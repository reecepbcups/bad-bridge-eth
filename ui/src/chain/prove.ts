// Cross-cuts the Hub adapter, the Ethereum adapter and the Succinct network client into one "prove my own
// kids" flow: read each escrow record's Merkle proof, request one Groth16 proof covering all of them,
// submitBatch it. Own kids only — the connected wallet's, never scanning or batching anyone else's records
// (see the build plan's scope note) — but any number of them together, since one proof/one submitBatch tx
// covers many records at close to the same cost as one (Ethereum-side verification is a fixed-size pairing
// check regardless of batch size; the SP1 proving cost is the only thing that scales, and sublinearly at
// that since it's one zkVM run either way). Behind real.tsx's lazy boundary like hub/ and eth/ already are,
// so cosmjs-types and the zstd WASM module never load in the demo bundle.

import { fromBase64 } from '@cosmjs/encoding'
import { bytesToHex, decodeAbiParameters, hexToBytes, parseAbiParameters, type Hex } from 'viem'
import { readContract } from 'viem/actions'
import type { Deployment } from '../config/deployments'
import { bridgeAbi, lightClientAbi } from './eth/abi'
import { createEthPublicClient } from './eth/client'
import { MIN_DEPOSIT } from './eth/fundProve'
import { requireBridge } from './eth/reader'
import type { EthWriterWithBatch } from './eth/writer'
import { escrowRaw, proofHeader, proveAt, storeKey } from './hub/prove'
import { encodeSp1Stdin, stdinChunks, type StdinRecord } from './hub/stdin'
import { createTransport } from './hub/transport'
import { getProveBalance, MAX_PROOF_COST, waitForProof, type ProofQuote, type ProofRequestProgress, type SuccinctStage } from './succinct/client'
import { BridgeError, type BatchOptions, type ConsensusStateArgs, type EthAddress, type KidId } from './types'

export type ProveStage = 'finding-proof' | SuccinctStage | 'signing' | 'confirming'

/**
 * bincode(SP1VerifyingKey) for public/membership.elf (batcher/elf/sp1-ics07-tendermint-membership), computed
 * once offline (2026-09-28) via `ProverClient::builder().mock().build().setup(elf)` — setup() needs no
 * network access, just the ELF, so this never changes unless the ELF does. Verified this session: its
 * bytes32() hash matched the light client's on-chain MEMBERSHIP_PROGRAM_VKEY exactly. If the light client is
 * ever redeployed with a different membership program, this pairing goes stale — CreateProgram would then
 * reject it (the network checks a submitted vk hashes to the vk_hash it's claimed against), not silently
 * register the wrong thing.
 */
const MEMBERSHIP_VK_BASE64 =
  'uGsAAAF4AAAAAAAAm5n5cNPZczk4H187KIagQAJmCwUvC/Ffc79eGpL39T7c8KpRHjUkEQTnPwu27GkO0Y7hGXvCcV/gG/waQO39QZpDVh9/BqING0DiLjhtMl6otMtC/4oxXgAAAAA='
/**
 * The vk hash Succinct's network keys programs by: the SDK's get_vk_hash, i.e. vk.hash_bytes(). Not the same
 * encoding as the on-chain MEMBERSHIP_PROGRAM_VKEY (bytes32()), which only the Ethereum side uses. Requesting
 * with the on-chain form makes the network's proof verification fail. Read off the batcher's successful
 * mainnet request, and its GetProgram vk matches MEMBERSHIP_VK_BASE64 byte for byte.
 */
const MEMBERSHIP_NETWORK_VK_HASH: Hex = '0x05ec76217a996e1710fd6af54e44692c19497f945f807ca528573f6876ed3e4f'
const MEMBERSHIP_ELF_URL = '/membership.elf'

async function fetchMembershipElf(): Promise<Uint8Array> {
  const res = await fetch(MEMBERSHIP_ELF_URL)
  if (!res.ok) throw new BridgeError('Network', `fetching the membership program: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export interface ProveKidsOptions {
  /** Called as the flow reaches each stage. Never called after the promise settles. */
  onStage?: (stage: ProveStage) => void
  /** Called with the Succinct request id and its live status while proving. */
  onProgress?: (progress: ProofRequestProgress) => void
  confirmQuote?: (quote: ProofQuote) => Promise<boolean>
  onRequestSubmitting?: () => void
  /** Persist these before requesting a paid proof, so a reload can submit at the original height. */
  onPrepared?: (height: bigint, consensusState: ConsensusStateArgs) => void
  /**
   * Per-id recipient the caller already believes each kid is headed to (e.g. from useTrip). Checked against
   * the Hub's own record before proving — the same sanity check the Rust batcher makes (hub.rs's
   * value-vs-REST cross-check) — since a mismatch means something is lying, not that the record changed.
   */
  expectedRecipients?: ReadonlyMap<KidId, EthAddress>
}

export interface ProveKidOptions {
  confirmQuote?: (quote: ProofQuote) => Promise<boolean>
  onStage?: (stage: ProveStage) => void
  expectedRecipient?: EthAddress
}

export interface ProveKidsResult {
  txHash: Hex
  /** Which of the requested ids actually made it into the batch: one not yet visible at the current height is
   * skipped rather than failing the whole batch (it just needs another try once Ethereum catches up to it). */
  proved: KidId[]
}

export interface SubmitRequestOptions {
  onStage?: (stage: ProveStage) => void
  onProgress?: (progress: ProofRequestProgress) => void
  /** Hub height the proof was made at. Defaults to the light client's latest, which is what proveKids uses. */
  height?: bigint
  /** Saved alongside height; avoids depending on historical RPC retention during recovery. */
  consensusState?: ConsensusStateArgs
}

export interface ProveKidResult {
  txHash: Hex
}

export interface ProveKidWriter {
  proveKid(id: KidId, options?: ProveKidOptions): Promise<ProveKidResult>
  /** Proves any number of the wallet's own pending kids in one batch: one proof, one submitBatch tx. */
  proveKids(ids: readonly KidId[], options?: ProveKidsOptions): Promise<ProveKidsResult>
  /**
   * Picks up a Succinct request that was started earlier (e.g. before a reload): waits for it to be fulfilled,
   * then submitBatch it. Needs the wallet only for the final Ethereum tx.
   */
  submitRequest(requestId: Hex, options?: SubmitRequestOptions): Promise<{ txHash: Hex }>
  /**
   * The connected wallet's PROVE balance deposited on Succinct's network — what RequestProof actually draws
   * from, not the wallet's ERC20 PROVE balance (a separate, unrelated number). Wei-like base units (18
   * decimals). Needs no signature, so this is safe to call just to show a "you'll need some PROVE" note.
   */
  proveBalance(): Promise<bigint>
  /**
   * Registers the membership program on Succinct's network, if it isn't already — the one-time step
   * RequestProof needs before it'll accept BadBridge's vk_hash. Anyone can call this; it's not gated to
   * whoever built the program. A no-op if it's already registered.
   */
  registerProgram(): Promise<void>
  /** Current Ethereum gas price in wei. */
  gasPrice(): Promise<bigint>
  /** ETH for exactly `prove` PROVE (18 decimals) on Uniswap right now. */
  quoteProve(prove: bigint): Promise<bigint>
  /** USD per ETH right now, for display only. */
  ethUsdPrice(): Promise<number>
  /** PROVE sitting in the wallet, waiting to be deposited. */
  walletProveBalance(): Promise<bigint>
  /** Buys exactly `prove` PROVE with ETH, into the wallet. */
  buyProve(prove: bigint, options?: BatchOptions): Promise<Hex>
  /** Moves PROVE from the wallet into its Succinct network account. */
  depositProve(amount: bigint, options?: BatchOptions): Promise<Hex>
}

/**
 * PROVE the Succinct account must hold before sending. One proof measured 0.334 PROVE on mainnet 2026-09-28 for
 * 1 kid and for 10 kids alike, so it's per proof, not per kid. 0.34 covers one proof of up to 50 kids.
 */
export const PROVE_NEEDED = MAX_PROOF_COST

export { MIN_DEPOSIT }

export function createProveKidWriter(deployment: Deployment, ethWriter: EthWriterWithBatch): ProveKidWriter {
  const publicClient = createEthPublicClient(deployment)
  const hubTransport = createTransport(deployment.hub)

  async function proveKids(ids: readonly KidId[], options?: ProveKidsOptions): Promise<ProveKidsResult> {
    const onStage = options?.onStage
    const bridge = requireBridge(deployment)
    const escrowBech32 = deployment.hub.escrow
    if (!escrowBech32) throw new BridgeError('NotLive', `${deployment.collectionName} has no escrow on the Hub yet`)
    if (ids.length === 0) throw new BridgeError('Unknown', 'no kids to prove')

    onStage?.('finding-proof')
    const lightClient = await readContract(publicClient, { address: bridge, abi: bridgeAbi, functionName: 'lightClient' })
    const [, , latestHeight, , , isFrozen] = await readContract(publicClient, {
      address: lightClient,
      abi: lightClientAbi,
      functionName: 'clientState',
    })
    if (isFrozen) throw new BridgeError('ClientFrozen', "Ethereum's light client of the Hub is frozen")
    const height = latestHeight.revisionHeight
    const queryHeight = Number(height) - 1

    const escrow = escrowRaw(escrowBech32)
    const records: (StdinRecord & { id: KidId })[] = []
    for (const id of ids) {
      const key = storeKey(escrow, id)
      const proof = await proveAt(hubTransport, queryHeight, key)
      if (!proof) continue // not visible at this height yet — leave it for a later try, don't fail the batch
      const expected = options?.expectedRecipients?.get(id)
      if (expected && bytesToHex(proof.value).toLowerCase() !== expected.toLowerCase()) {
        throw new BridgeError('Unknown', `#${id}'s on-chain record doesn't match what was expected; refusing to prove it`)
      }
      records.push({ id, storeKey: key, value: proof.value, merkleProofBytes: proof.merkleProofBytes })
    }
    if (records.length === 0) {
      throw new BridgeError('Unknown', `none of these kids' records are visible at Hub height ${queryHeight} yet; try again shortly`)
    }

    const header = await proofHeader(hubTransport, Number(height))
    const vkHash = await readContract(publicClient, { address: lightClient, abi: lightClientAbi, functionName: 'MEMBERSHIP_PROGRAM_VKEY' })

    const cs = { timestamp: header.timestampNs, root: bytesToHex(header.appHash), nextValidatorsHash: bytesToHex(header.nextValidatorsHash) }
    options?.onPrepared?.(height, cs)
    const stdinBytes = encodeSp1Stdin(stdinChunks(header.appHash, records))
    const decoded = await ethWriter.requestGroth16Proof(MEMBERSHIP_NETWORK_VK_HASH, stdinBytes, {
      onStage, onProgress: options?.onProgress, confirmQuote: options?.confirmQuote,
      onRequestSubmitting: options?.onRequestSubmitting,
    })
    const sp1Proof = { vKey: vkHash, publicValues: decoded.publicValues, proof: decoded.proofBytes }
    const { txHash } = await ethWriter.submitBatch(height, cs, sp1Proof, { onStage })
    return { txHash, proved: records.map((r) => r.id) }
  }

  async function submitRequest(requestId: Hex, options?: SubmitRequestOptions): Promise<{ txHash: Hex }> {
    const onStage = options?.onStage
    const bridge = requireBridge(deployment)
    onStage?.('proving')
    const decoded = await waitForProof(hexToBytes(requestId), { onProgress: options?.onProgress })

    onStage?.('finding-proof')
    const lightClient = await readContract(publicClient, { address: bridge, abi: bridgeAbi, functionName: 'lightClient' })
    const vkHash = await readContract(publicClient, { address: lightClient, abi: lightClientAbi, functionName: 'MEMBERSHIP_PROGRAM_VKEY' })
    let height = options?.height
    if (options?.consensusState && height === undefined) throw new BridgeError('Unknown', 'a saved proof needs its original height')
    if (height === undefined) {
      const [, , latestHeight, , , isFrozen] = await readContract(publicClient, { address: lightClient, abi: lightClientAbi, functionName: 'clientState' })
      if (isFrozen) throw new BridgeError('ClientFrozen', "Ethereum's light client of the Hub is frozen")
      height = latestHeight.revisionHeight
    }
    let cs = options?.consensusState
    if (!cs) {
      const header = await proofHeader(hubTransport, Number(height))
      cs = { timestamp: header.timestampNs, root: bytesToHex(header.appHash), nextValidatorsHash: bytesToHex(header.nextValidatorsHash) }
    }
    const [output] = decodeAbiParameters(
      parseAbiParameters('(bytes32 commitmentRoot, (bytes[] path, bytes value)[] kvPairs)'), decoded.publicValues,
    )
    if (output.commitmentRoot.toLowerCase() !== cs.root.toLowerCase()) {
      throw new BridgeError('Unknown', `this proof wasn't made at Hub height ${height}. Enter the height it was proven at.`)
    }
    const sp1Proof = { vKey: vkHash, publicValues: decoded.publicValues, proof: decoded.proofBytes }
    const { txHash } = await ethWriter.submitBatch(height, cs, sp1Proof, { onStage })
    return { txHash }
  }

  async function proveKid(id: KidId, options?: ProveKidOptions): Promise<ProveKidResult> {
    const { txHash } = await proveKids([id], {
      onStage: options?.onStage,
      confirmQuote: options?.confirmQuote,
      expectedRecipients: options?.expectedRecipient ? new Map([[id, options.expectedRecipient]]) : undefined,
    })
    return { txHash }
  }

  async function registerProgram(): Promise<void> {
    requireBridge(deployment)
    const elf = await fetchMembershipElf()
    await ethWriter.registerProgram(MEMBERSHIP_NETWORK_VK_HASH, fromBase64(MEMBERSHIP_VK_BASE64), elf)
  }

  return {
    proveKid,
    proveKids,
    submitRequest,
    proveBalance: () => getProveBalance(ethWriter.address),
    registerProgram,
    gasPrice: () => publicClient.getGasPrice(),
    quoteProve: (prove) => ethWriter.quoteProve(prove),
    ethUsdPrice: () => ethWriter.ethUsdPrice(),
    walletProveBalance: () => ethWriter.walletProveBalance(),
    buyProve: (prove, options) => ethWriter.swapEthForProve(prove, options),
    depositProve: (amount, options) => ethWriter.depositProve(amount, options),
  }
}
