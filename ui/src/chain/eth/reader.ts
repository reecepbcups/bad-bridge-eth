import { getAddress, TransactionReceiptNotFoundError, zeroAddress, type Address, type Chain, type Client, type Hex, type Transport } from 'viem'
import { estimateContractGas, getCode, getGasPrice, getStorageAt, getTransactionReceipt, multicall, readContract } from 'viem/actions'
import type { Deployment } from '../../config/deployments'
import {
  BridgeError,
  type BridgeWiring,
  type ClaimEstimate,
  type ClientStatus,
  type EthAddress,
  type EthReader,
  type KidEthStatus,
  type KidId,
} from '../types'
import { bridgeAbi, lightClientAbi, routerAbi } from './abi'
import { createEthPublicClient } from './client'
import { typicalClaimGas } from './gas'
import { findRevert, toEthError } from './errors'
import { readClientSafety } from './safety'

/** Kids per multicall. Two calls each: 500 calls, ~110 KB of calldata and ~2M gas, well inside public RPC limits. */
export const KID_STATUS_CHUNK = 250
/** Multicalls in flight at once, so a 10k-kid lookup doesn't hit a public RPC with 40 requests at once. */
const CHUNK_CONCURRENCY = 4
/** EIP-7702 delegation designator: 0xef0100 ++ 20-byte delegate. Code like this is still an EOA. */
const DELEGATION_PREFIX = '0xef0100'
const DELEGATION_CODE_LENGTH = 2 + 2 * 23
/** EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const EIP1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

export interface EthReaderOptions {
  /** Client to read through. Defaults to one over the deployment's RPCs (fallback transport). */
  client?: Client<Transport, Chain | undefined>
  /** Kids per multicall; tests shrink it to exercise chunking. */
  chunkSize?: number
}

/** Rejects with NotLive when the deployment has no bridge yet. */
export function requireBridge(deployment: Deployment): Address {
  if (!deployment.eth.bridge) throw new BridgeError('NotLive', `${deployment.collectionName} has no Ethereum bridge yet`)
  return deployment.eth.bridge
}

/** A kid id the contracts accept: a u32. */
export function assertKidId(id: KidId): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) throw new BridgeError('BadTokenId', `${id} isn't a u32 token id`)
}

/** Runs `fn`, turning anything it throws into a BridgeError (transport failures become Network). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toEthError(e)
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** True for code that makes an address a contract. Empty code and EIP-7702 delegations are EOAs. */
export function isContractCode(code: Hex | undefined): boolean {
  if (!code || code === '0x') return false
  if (code.length === DELEGATION_CODE_LENGTH && code.toLowerCase().startsWith(DELEGATION_PREFIX)) return false
  return true
}

/** EthReader over viem. Batches kid lookups through Multicall3 with allowFailure (ownerOf reverts until minted). */
export function createEthReader(deployment: Deployment, options: EthReaderOptions = {}): EthReader {
  const client = options.client ?? createEthPublicClient(deployment)
  const chunkSize = Math.max(1, options.chunkSize ?? KID_STATUS_CHUNK)
  const multicallAddress = deployment.eth.multicall3

  async function statusChunk(bridge: Address, ids: readonly KidId[]): Promise<[KidId, KidEthStatus][]> {
    const contracts = ids.flatMap((id) => [
      { address: bridge, abi: bridgeAbi, functionName: 'proven', args: [id] } as const,
      { address: bridge, abi: bridgeAbi, functionName: 'ownerOf', args: [BigInt(id)] } as const,
    ])
    // batchSize 0: we chunk ourselves, viem's 1 KB default would split this into dozens of requests
    const results = await multicall(client, { contracts, allowFailure: true, multicallAddress, batchSize: 0 })
    return ids.map((id, i) => {
      const proven = results[2 * i]
      const owner = results[2 * i + 1]
      if (!proven || !owner) throw new BridgeError('Network', `multicall returned ${results.length} results for ${contracts.length} calls`)
      if (proven.status === 'failure') {
        throw new BridgeError('Network', `proven(${id}) failed: ${proven.error.message}`, { tokenId: id, cause: proven.error })
      }
      let ownerOf: EthAddress | null = null
      if (owner.status === 'success') {
        ownerOf = owner.result
      } else if (findRevert(owner.error)?.errorName !== 'ERC721NonexistentToken') {
        // anything but "not minted yet" means we can't trust this answer
        throw new BridgeError('Network', `ownerOf(${id}) failed: ${owner.error.message}`, { tokenId: id, cause: owner.error })
      }
      const provenTo = proven.result
      return [id, { proven: provenTo === zeroAddress ? null : provenTo, owner: ownerOf }]
    })
  }

  /** Gas to claim exactly these kids, or null if any of them can't be claimed right now (the estimate reverts). */
  async function simulatedClaimGas(bridge: Address, ids: readonly KidId[]): Promise<bigint | null> {
    try {
      // claim ignores msg.sender, so estimating from no account prices the same transaction a wallet would send
      if (ids.length === 1) {
        return await estimateContractGas(client, { address: bridge, abi: bridgeAbi, functionName: 'claim', args: [ids[0] as KidId] })
      }
      return await estimateContractGas(client, { address: bridge, abi: bridgeAbi, functionName: 'claimMany', args: [[...ids]] })
    } catch {
      return null
    }
  }

  return {
    clientSafety: () => guard(() => readClientSafety(deployment, client)),
    client: () =>
      guard(async (): Promise<ClientStatus> => {
        const bridge = requireBridge(deployment)
        const lightClient = await readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'lightClient' })
        const [, , latestHeight, , , isFrozen] = await readContract(client, {
          address: lightClient,
          abi: lightClientAbi,
          functionName: 'clientState',
        })
        return { latestHeight: Number(latestHeight.revisionHeight), frozen: isFrozen }
      }),

    kidStatus: (ids) =>
      guard(async () => {
        const bridge = requireBridge(deployment)
        ids.forEach(assertKidId)
        const unique = [...new Set(ids)]
        const chunks: KidId[][] = []
        for (let i = 0; i < unique.length; i += chunkSize) chunks.push(unique.slice(i, i + chunkSize))
        const done = await mapLimit(chunks, CHUNK_CONCURRENCY, (chunk) => statusChunk(bridge, chunk))
        return new Map(done.flat())
      }),

    isContract: (address) =>
      guard(async () => {
        const code = await getCode(client, { address })
        return isContractCode(code)
      }),

    bridgeEscrow: () =>
      guard(async () => {
        const bridge = requireBridge(deployment)
        const escrow = await readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'ESCROW' })
        return escrow.toLowerCase() as Hex
      }),

    bridgeWiring: () =>
      guard(async (): Promise<BridgeWiring> => {
        const bridge = requireBridge(deployment)
        const [router, clientId, lightClient] = await Promise.all([
          readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'ROUTER' }),
          readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'clientId' }),
          readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'lightClient' }),
        ])
        const [chainId] = await readContract(client, { address: lightClient, abi: lightClientAbi, functionName: 'clientState' })
        return { router, clientId, lightClient, chainId }
      }),

    proxyImplementation: (address) =>
      guard(async () => {
        const slot = await getStorageAt(client, { address, slot: EIP1967_IMPLEMENTATION_SLOT })
        if (!slot || /^0x0*$/.test(slot)) return null
        return getAddress(`0x${slot.slice(-40)}`)
      }),

    estimateClaim: (ids) =>
      guard(async (): Promise<ClaimEstimate> => {
        const bridge = requireBridge(deployment)
        ids.forEach(assertKidId)
        const unique = [...new Set(ids)]
        const [gasPrice, simulated] = await Promise.all([
          getGasPrice(client),
          unique.length > 0 ? simulatedClaimGas(bridge, unique) : Promise.resolve(null),
        ])
        const gas = simulated ?? typicalClaimGas(Math.max(1, unique.length))
        return { gas: Number(gas), gasPrice: gasPrice.toString(), fee: (gas * gasPrice).toString(), simulated: simulated !== null }
      }),

    txStatus: (hash) =>
      guard(async () => {
        try {
          const receipt = await getTransactionReceipt(client, { hash })
          return receipt.status === 'success' ? 'confirmed' : 'failed'
        } catch (e) {
          // not mined yet, or dropped: either way not in a block
          if (e instanceof TransactionReceiptNotFoundError) return 'pending'
          throw e
        }
      }),

    hubClientId: () =>
      guard(async () => {
        const bridge = requireBridge(deployment)
        const [router, clientId] = await Promise.all([
          readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'ROUTER' }),
          readContract(client, { address: bridge, abi: bridgeAbi, functionName: 'clientId' }),
        ])
        const counterparty = await readContract(client, { address: router, abi: routerAbi, functionName: 'getCounterparty', args: [clientId] })
        return counterparty.clientId
      }),
  }
}

