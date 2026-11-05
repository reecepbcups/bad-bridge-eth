import type { Account, Address, Chain, Client, Hex, Transport } from 'viem'
import {
  getChainId,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions'
import { recordActivity, type ActivityEntry } from '../../activity/storage'
import type { Deployment } from '../../config/deployments'
import {
  BridgeError,
  stageReporter,
  type BatchOptions,
  type BatchStage,
  type ClaimResult,
  type ClaimStage,
  type ConsensusStateArgs,
  type EthAddress,
  type EthReader,
  type EthWriter,
  type KidId,
  type Sp1ProofArgs,
  type SubmitBatchResult,
} from '../types'
import { registerProgram as registerProgramImpl, requestGroth16Proof as requestGroth16ProofImpl, type ProofQuote, type ProofRequestProgress, type SuccinctStage } from '../succinct/client'
import type { DecodedGroth16Proof } from '../succinct/proof'
import { bridgeAbi } from './abi'
import { depositProve as depositProveImpl, ethUsdPrice as ethUsdPriceImpl, quoteProve as quoteProveImpl, swapEthForProve as swapEthForProveImpl, walletProveBalance as walletProveBalanceImpl } from './fundProve'
import { ethChain } from './client'
import { toEthError } from './errors'
import { assertKidId, createEthReader, requireBridge } from './reader'

/** A client that can sign and send: a viem WalletClient, or wagmi's connector client. */
export type SignerClient = Client<Transport, Chain | undefined, Account>
/** Anything viem's public actions run on. */
export type ReadClient = Client<Transport, Chain | undefined>

/** A claim sent at a low fee can sit in the mempool a while. Past this, the UI's polling takes over. */
const RECEIPT_TIMEOUT_MS = 10 * 60_000

export type EthWriterDeps = {
  deployment: Deployment
  /** Reads, simulation, gas estimates and receipts. */
  publicClient: ReadClient
  /** Status re-read before each claim. Defaults to a reader over `publicClient`. */
  reader?: EthReader
} & (
  | {
      /** A fixed signer. `address` is its account. */
      walletClient: SignerClient
    }
  | {
      /** Called once per claim, so the signer always reflects the wallet's current chain and account. */
      getWalletClient: () => Promise<SignerClient>
      /** The account `getWalletClient` signs with. */
      address: EthAddress
    }
)

/** Progress for one claim; `signing` goes out just before the wallet is asked. */
type Report = (stage: ClaimStage) => void
/** Progress for one submitBatch call. */
type BatchReport = (stage: BatchStage) => void

/** An EthWriter that also carries submitBatch and requestGroth16Proof, for the proof page (createEthWriter returns this). */
export interface EthWriterWithBatch extends EthWriter {
  /**
   * Anyone can submit a batch (it's checked on-chain, not by msg.sender) — this always uses the connected
   * wallet, same as claim. `options.onStage` reports signing → confirming.
   */
  submitBatch(proofHeight: bigint, cs: ConsensusStateArgs, sp1Proof: Sp1ProofArgs, options?: BatchOptions): Promise<SubmitBatchResult>
  /**
   * Requests a Groth16 membership proof from Succinct's network, signing with the same connected wallet
   * that would submitBatch it. The wallet client stays inside this module — callers never see it.
   */
  requestGroth16Proof(vkHash: Hex, stdinBytes: Uint8Array, options?: {
      onStage?: (stage: SuccinctStage) => void
      onProgress?: (progress: ProofRequestProgress) => void
      confirmQuote?: (quote: ProofQuote) => Promise<boolean>
      onRequestSubmitting?: () => void
      /** Kids the proof is for, so the activity log can name them. */
      kids?: readonly KidId[]
    },
  ): Promise<DecodedGroth16Proof>
  /**
   * Registers a guest program on Succinct's network (a no-op if it's already registered), signing with the
   * same connected wallet. Anyone can register any program — this isn't gated to whoever built it.
   */
  registerProgram(vkHash: Hex, vk: Uint8Array, elf: Uint8Array): Promise<void>
  /** ETH the router wants for exactly `prove` PROVE (18 decimals) right now. */
  quoteProve(prove: bigint): Promise<bigint>
  /** USD per ETH right now, for display only. */
  ethUsdPrice(): Promise<number>
  /** PROVE held in the connected wallet, not the Succinct network balance. */
  walletProveBalance(): Promise<bigint>
  /** Buys exactly `prove` PROVE with ETH on Uniswap, into the connected wallet. Returns the tx hash. */
  swapEthForProve(prove: bigint, options?: BatchOptions): Promise<Hex>
  /** Deposits PROVE into the connected wallet's Succinct network account (one permit signature, one tx). */
  depositProve(amount: bigint, options?: BatchOptions): Promise<Hex>
}

/** Splits requested ids into what can be claimed now, and why the rest can't. */
export function sortClaimable(ids: readonly KidId[], status: Map<KidId, { proven: unknown; owner: unknown }>) {
  const claimable: KidId[] = []
  const minted: KidId[] = []
  const unproven: KidId[] = []
  for (const id of ids) {
    const s = status.get(id)
    if (!s || s.proven === null) unproven.push(id)
    else if (s.owner !== null) minted.push(id)
    else claimable.push(id)
  }
  return { claimable, minted, unproven }
}

function kids(ids: readonly KidId[]): string {
  return ids.map((id) => `#${id}`).join(', ')
}

/** NotProven for a claim with nothing left to mint; the detail says which were minted already and which aren't proven. */
function nothingToClaim(minted: readonly KidId[], unproven: readonly KidId[]): BridgeError {
  const parts: string[] = []
  if (minted.length) parts.push(`already minted: ${kids(minted)}`)
  if (unproven.length) parts.push(`not proven yet: ${kids(unproven)}`)
  return new BridgeError('NotProven', parts.join('; '), { tokenId: unproven[0] ?? minted[0] })
}

/**
 * The claim core, free of wagmi so it runs against anvil in the fork test.
 *
 * claim(ids):
 * 1. refuses with WrongChain unless the wallet is on the deployment's chain;
 * 2. re-reads status and keeps only proven, unminted kids (none left → NotProven, detail says why);
 * 3. one kid → bridge.claim(id); several → one bridge.claimMany;
 * 4. simulates, sends, waits for the receipt and fails if it reverted.
 * `onStage` hears `signing` right before the wallet is asked, and `confirming` once the tx is sent.
 */
export function createEthWriter(deps: EthWriterDeps): EthWriterWithBatch {
  const { deployment, publicClient } = deps
  const reader = deps.reader ?? createEthReader(deployment, { client: publicClient })
  const address = 'walletClient' in deps ? deps.walletClient.account.address : deps.address
  const getWallet = 'walletClient' in deps ? () => Promise.resolve(deps.walletClient) : deps.getWalletClient
  const chain = ethChain(deployment)
  const log = (entry: ActivityEntry) => recordActivity(deployment.id, entry)

  async function claimOne(wallet: SignerClient, bridge: Address, id: KidId, report: Report): Promise<Hex> {
    const { request } = await simulateContract(publicClient, {
      account: wallet.account,
      address: bridge,
      abi: bridgeAbi,
      functionName: 'claim',
      args: [id],
    })
    report('signing')
    const hash = await writeContract(wallet, { ...request, account: wallet.account, chain })
    log({ action: 'claim', hash, kids: [id] })
    return hash
  }

  async function submitBatchTx(
    wallet: SignerClient,
    bridge: Address,
    proofHeight: bigint,
    cs: ConsensusStateArgs,
    sp1Proof: Sp1ProofArgs,
    report: BatchReport,
    kidIds: readonly KidId[] | undefined,
  ): Promise<Hex> {
    const { request } = await simulateContract(publicClient, {
      account: wallet.account,
      address: bridge,
      abi: bridgeAbi,
      functionName: 'submitBatch',
      args: [proofHeight, cs, sp1Proof],
    })
    report('signing')
    const hash = await writeContract(wallet, { ...request, account: wallet.account, chain })
    log({ action: 'submit-proof', hash, kids: kidIds && [...kidIds] })
    return hash
  }

  async function claimMany(
    wallet: SignerClient,
    bridge: Address,
    ids: readonly KidId[],
    report: Report,
  ): Promise<{ hash: Hex; claimed: KidId[] }> {
    // the contract skips kids someone else already claimed, so one front-run claim doesn't sink the batch
    const { request } = await simulateContract(publicClient, {
      account: wallet.account,
      address: bridge,
      abi: bridgeAbi,
      functionName: 'claimMany',
      args: [[...ids]],
    })
    report('signing')
    const hash = await writeContract(wallet, { ...request, account: wallet.account, chain })
    log({ action: 'claim', hash, kids: [...ids] })
    return { hash, claimed: [...ids] }
  }

  async function claim(ids: readonly KidId[], report: Report): Promise<ClaimResult> {
    const bridge = requireBridge(deployment)
    ids.forEach(assertKidId)
    const unique = [...new Set(ids)]
    if (unique.length === 0) throw new BridgeError('Unknown', 'no kids to claim')

    const wallet = await getWallet()
    const walletChain = await getChainId(wallet)
    if (walletChain !== chain.id) {
      throw new BridgeError('WrongChain', `wallet is on chain ${walletChain}, the bridge is on ${chain.name} (${chain.id})`)
    }

    const { claimable, minted, unproven } = sortClaimable(unique, await reader.kidStatus(unique))
    if (claimable.length === 0) throw nothingToClaim(minted, unproven)

    const { hash, claimed } =
      claimable.length === 1
        ? { hash: await claimOne(wallet, bridge, claimable[0] as KidId, report), claimed: [claimable[0] as KidId] }
        : await claimMany(wallet, bridge, claimable, report)

    report('confirming')
    let cancelled = false
    const receipt = await waitForTransactionReceipt(publicClient, {
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
      onReplaced: (r) => {
        cancelled = r.reason === 'cancelled'
      },
    })
    if (cancelled) throw new BridgeError('UserRejected', `claim ${hash} was cancelled in the wallet`)
    if (receipt.status !== 'success') throw new BridgeError('Unknown', `claim transaction ${receipt.transactionHash} reverted`)
    return { txHash: receipt.transactionHash, claimed }
  }

  async function submitBatch(
    proofHeight: bigint,
    cs: ConsensusStateArgs,
    sp1Proof: Sp1ProofArgs,
    report: BatchReport,
    kidIds: readonly KidId[] | undefined,
  ): Promise<SubmitBatchResult> {
    const bridge = requireBridge(deployment)
    const wallet = await getWallet()
    const walletChain = await getChainId(wallet)
    if (walletChain !== chain.id) {
      throw new BridgeError('WrongChain', `wallet is on chain ${walletChain}, the bridge is on ${chain.name} (${chain.id})`)
    }

    const hash = await submitBatchTx(wallet, bridge, proofHeight, cs, sp1Proof, report, kidIds)
    report('confirming')
    let cancelled = false
    const receipt = await waitForTransactionReceipt(publicClient, {
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
      onReplaced: (r) => {
        cancelled = r.reason === 'cancelled'
      },
    })
    if (cancelled) throw new BridgeError('UserRejected', `submitBatch ${hash} was cancelled in the wallet`)
    if (receipt.status !== 'success') throw new BridgeError('Unknown', `submitBatch transaction ${receipt.transactionHash} reverted`)
    return { txHash: receipt.transactionHash }
  }

  async function requestGroth16Proof(
    vkHash: Hex,
    stdinBytes: Uint8Array,
    onStage: ((stage: SuccinctStage) => void) | undefined,
    onProgress: ((progress: ProofRequestProgress) => void) | undefined,
    confirmQuote: ((quote: ProofQuote) => Promise<boolean>) | undefined,
    onRequestSubmitting: (() => void) | undefined,
    kidIds: readonly KidId[] | undefined,
  ): Promise<DecodedGroth16Proof> {
    const wallet = await getWallet()
    const onSigned = (requestId: Hex | undefined) => log({ action: 'sign-proof-request', requestId, kids: kidIds && [...kidIds] })
    return requestGroth16ProofImpl({ wallet, vkHash, stdinBytes, onStage, onProgress, confirmQuote, onRequestSubmitting, onSigned })
  }

  async function registerProgram(vkHash: Hex, vk: Uint8Array, elf: Uint8Array): Promise<void> {
    const wallet = await getWallet()
    await registerProgramImpl({ wallet, vkHash, vk, elf })
  }

  return {
    address,
    claim: async (ids, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        return await claim(ids, stage.report)
      } catch (e) {
        throw toEthError(e, ids.length === 1 ? ids[0] : undefined)
      } finally {
        stage.done()
      }
    },
    submitBatch: async (proofHeight, cs, sp1Proof, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        return await submitBatch(proofHeight, cs, sp1Proof, stage.report, options?.kids)
      } catch (e) {
        throw toEthError(e)
      } finally {
        stage.done()
      }
    },
    requestGroth16Proof: async (vkHash, stdinBytes, options) => {
      try {
        return await requestGroth16Proof(vkHash, stdinBytes, options?.onStage, options?.onProgress, options?.confirmQuote, options?.onRequestSubmitting, options?.kids)
      } catch (e) {
        throw toEthError(e)
      }
    },
    registerProgram: async (vkHash, vk, elf) => {
      try {
        return await registerProgram(vkHash, vk, elf)
      } catch (e) {
        throw toEthError(e)
      }
    },
    quoteProve: async (prove) => {
      try {
        return await quoteProveImpl(publicClient, prove)
      } catch (e) {
        throw toEthError(e)
      }
    },
    ethUsdPrice: async () => {
      try {
        return await ethUsdPriceImpl(publicClient)
      } catch (e) {
        throw toEthError(e)
      }
    },
    walletProveBalance: async () => {
      try {
        return await walletProveBalanceImpl(publicClient, address)
      } catch (e) {
        throw toEthError(e)
      }
    },
    swapEthForProve: async (prove, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        return await swapEthForProveImpl(publicClient, await getWallet(), chain.id, prove, stage.report, log)
      } catch (e) {
        throw toEthError(e)
      } finally {
        stage.done()
      }
    },
    depositProve: async (amount, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        return await depositProveImpl(publicClient, await getWallet(), chain.id, amount, stage.report, log)
      } catch (e) {
        throw toEthError(e)
      } finally {
        stage.done()
      }
    },
  }
}
