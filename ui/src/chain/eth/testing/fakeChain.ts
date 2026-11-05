// Test-only: a tiny in-memory BadBridge + light client + Multicall3 behind an EIP-1193 `request`, so the reader and
// writer run through real viem (encoding, multicall, simulate, send, receipt) with no network. Not imported by the app.

import {
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  keccak256,
  numberToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type Transport,
} from 'viem'
import { bridgeAbi, lightClientAbi, multicall3WriteAbi, routerAbi } from '../abi'

export const BRIDGE: Address = '0xdDef181a0b9F5A090830F9ccBE5Ffb0D2BA07A7e'
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'
export const LIGHT_CLIENT: Address = '0x4bB8A05D5b40dF7a3B97770E1943461B681B62E9'
export const ROUTER: Address = '0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7'
export const ESCROW: Hex = '0x1e331b6d98530b4a2755404f892dc016fb1020eba8796f41db0369a92a884810'
export const ALICE: Address = getAddress('0xd2c392084761cb6e44c544b6f39dcc001fde9775')
export const BOB: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
/** The estimate eth_estimateGas answers with. */
export const FAKE_GAS = 100_000n

type Call = { to: Address; data: Hex; from?: Address; gas?: Hex }
type Outcome = { ok: true; data: Hex } | { ok: false; data: Hex }

export interface SentTx {
  hash: Hex
  from: Address
  to: Address
  data: Hex
  gas: bigint | undefined
}

/** Shaped like a node's JSON-RPC error, so viem maps it the way it maps a real one. */
function rpcError(code: number, message: string, data?: Hex): Error {
  return Object.assign(new Error(message), { code, data })
}

export class FakeChain {
  proven = new Map<number, Address>()
  owners = new Map<number, Address>()
  code = new Map<string, Hex>()
  latestHeight = 33_100_000n
  frozen = false
  currentClient: Address = LIGHT_CLIENT
  consensusHash: Hex = `0x${'11'.repeat(32)}`
  timestamp = BigInt(Math.floor(Date.now() / 1000))
  /** clientState().chainId */
  clientChainId = 'cosmoshub-4'
  /** bridge.clientId() */
  clientId = 'cosmoshub-0'
  /** bridge.ROUTER() */
  router: Address = ROUTER
  /** router.getCounterparty(clientId).clientId: the Hub-side client id Ethereum's client counterparts to. */
  counterpartyClientId = '08-wasm-1369'
  /** eth_getStorageAt: lowercase address → slot → value */
  storage = new Map<string, Map<string, Hex>>()
  /** eth_gasPrice, wei */
  gasPrice = 2_000_000_000n
  /** The chain the wallet reports; the node is always mainnet. */
  walletChainId = 1
  /** eth_call to ownerOf for these ids reverts with junk instead of ERC721NonexistentToken. */
  brokenOwnerOf = new Set<number>()
  /** Every JSON-RPC method the public side saw, in order. */
  publicLog: string[] = []
  /** eth_estimateGas requests. */
  estimates: Call[] = []
  sent: SentTx[] = []
  /** The next receipt reports a revert. */
  revertNextTx = false
  /** Thrown from the wallet's eth_sendTransaction (a user rejection, insufficient funds…). */
  walletError: Error | undefined
  /** Thrown from every public request (transport down). */
  publicError: Error | undefined
  private receipts = new Map<Hex, 'success' | 'reverted'>()

  /** Transport for the public client (reads, simulate, estimate, receipts). */
  publicTransport(): Transport {
    return custom({ request: ({ method, params }: { method: string; params?: unknown }) => this.publicRequest(method, params) }, { retryCount: 0 })
  }

  /** Transport for a JSON-RPC wallet account: eth_chainId says walletChainId, eth_sendTransaction mines instantly. */
  walletTransport(): Transport {
    return custom({ request: ({ method, params }: { method: string; params?: unknown }) => this.walletRequest(method, params) }, { retryCount: 0 })
  }

  private publicRequest(method: string, params: unknown): Promise<unknown> {
    this.publicLog.push(method)
    if (this.publicError) return Promise.reject(this.publicError)
    const [first] = (params ?? []) as [unknown]
    switch (method) {
      case 'eth_chainId':
        return Promise.resolve(numberToHex(1))
      case 'eth_blockNumber':
        return Promise.resolve(numberToHex(1))
      case 'eth_getBlockByNumber':
        return Promise.resolve({ number: '0x1', timestamp: numberToHex(this.timestamp), transactions: [] })
      case 'eth_call': {
        const out = this.execute(first as Call)
        return out.ok ? Promise.resolve(out.data) : Promise.reject(rpcError(3, 'execution reverted', out.data))
      }
      case 'eth_estimateGas': {
        const call = first as Call
        this.estimates.push(call)
        const out = this.execute(call)
        return out.ok ? Promise.resolve(numberToHex(FAKE_GAS)) : Promise.reject(rpcError(3, 'execution reverted', out.data))
      }
      case 'eth_getCode':
        return Promise.resolve(this.code.get((first as string).toLowerCase()) ?? '0x')
      case 'eth_getStorageAt': {
        const [address, slot] = params as [string, Hex]
        return Promise.resolve(this.storage.get(address.toLowerCase())?.get(slot.toLowerCase()) ?? `0x${'0'.repeat(64)}`)
      }
      case 'eth_gasPrice':
        return Promise.resolve(numberToHex(this.gasPrice))
      case 'eth_getTransactionReceipt':
        return Promise.resolve(this.receipt(first as Hex))
      default:
        return Promise.reject(rpcError(-32601, `fake chain: ${method} isn't supported`))
    }
  }

  private walletRequest(method: string, params: unknown): Promise<unknown> {
    const [first] = (params ?? []) as [unknown]
    switch (method) {
      case 'eth_chainId':
        return Promise.resolve(numberToHex(this.walletChainId))
      case 'eth_sendTransaction': {
        if (this.walletError) return Promise.reject(this.walletError)
        const tx = first as Call
        const hash = keccak256(toHex(`tx-${this.sent.length}`))
        this.sent.push({ hash, from: tx.from ?? zeroAddress, to: getAddress(tx.to), data: tx.data, gas: tx.gas ? BigInt(tx.gas) : undefined })
        const reverted = this.revertNextTx || !this.execute(tx, true).ok
        this.revertNextTx = false
        this.receipts.set(hash, reverted ? 'reverted' : 'success')
        return Promise.resolve(hash)
      }
      default:
        return this.publicRequest(method, params)
    }
  }

  private receipt(hash: Hex) {
    const status = this.receipts.get(hash)
    if (!status) return null
    const tx = this.sent.find((t) => t.hash === hash)
    return {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: keccak256(hash),
      blockNumber: '0x1',
      from: tx?.from,
      to: tx?.to,
      cumulativeGasUsed: '0x1',
      gasUsed: '0x1',
      effectiveGasPrice: '0x1',
      contractAddress: null,
      logs: [],
      logsBloom: `0x${'0'.repeat(512)}`,
      status: status === 'success' ? '0x1' : '0x0',
      type: '0x2',
    }
  }

  /** Runs a call against the fake contracts. `commit` applies state changes (a mined tx). */
  execute(call: Call, commit = false): Outcome {
    const to = getAddress(call.to)
    if (to === MULTICALL3) return this.aggregate3(call.data, commit)
    if (to === BRIDGE) return this.bridge(call.data, commit)
    if (to === LIGHT_CLIENT) {
      if (decodeFunctionData({ abi: lightClientAbi, data: call.data }).functionName === 'getConsensusStateHash') {
        return { ok: true, data: encodeFunctionResult({ abi: lightClientAbi, functionName: 'getConsensusStateHash', result: this.consensusHash }) }
      }
      return {
        ok: true,
        data: encodeFunctionResult({
          abi: lightClientAbi,
          functionName: 'clientState',
          result: [this.clientChainId, { numerator: 2, denominator: 3 }, { revisionNumber: 4n, revisionHeight: this.latestHeight }, 1_209_600, 1_814_400, this.frozen, 1],
        }),
      }
    }
    if (to === this.router) {
      if (decodeFunctionData({ abi: routerAbi, data: call.data }).functionName === 'getClient') {
        return { ok: true, data: encodeFunctionResult({ abi: routerAbi, functionName: 'getClient', result: this.currentClient }) }
      }
      return {
        ok: true,
        data: encodeFunctionResult({
          abi: routerAbi,
          functionName: 'getCounterparty',
          result: { clientId: this.counterpartyClientId, merklePrefix: ['0x696263', '0x'] },
        }),
      }
    }
    return { ok: true, data: '0x' }
  }

  private aggregate3(data: Hex, commit: boolean): Outcome {
    const { args } = decodeFunctionData({ abi: multicall3WriteAbi, data })
    const results: { success: boolean; returnData: Hex }[] = []
    for (const c of args[0]) {
      const out = this.execute({ to: c.target, data: c.callData }, commit)
      if (!out.ok && !c.allowFailure) return { ok: false, data: out.data }
      results.push({ success: out.ok, returnData: out.data })
    }
    return { ok: true, data: encodeFunctionResult({ abi: multicall3WriteAbi, functionName: 'aggregate3', result: results }) }
  }

  private bridge(data: Hex, commit: boolean): Outcome {
    const call = decodeFunctionData({ abi: bridgeAbi, data })
    const result = (functionName: string, value: unknown): Outcome => ({
      ok: true,
      data: encodeFunctionResult({ abi: bridgeAbi, functionName: functionName as 'proven', result: value as Address }),
    })
    const revert = (errorName: string, args: readonly unknown[]): Outcome => ({
      ok: false,
      data: encodeErrorResult({ abi: bridgeAbi, errorName: errorName as 'NotProven', args: args as [number] }),
    })
    switch (call.functionName) {
      case 'lightClient':
        return result('lightClient', LIGHT_CLIENT)
      case 'ESCROW':
        return result('ESCROW', ESCROW)
      case 'ROUTER':
        return result('ROUTER', this.router)
      case 'clientId':
        return { ok: true, data: encodeFunctionResult({ abi: bridgeAbi, functionName: 'clientId', result: this.clientId }) }
      case 'proven':
        return result('proven', this.proven.get(call.args[0]) ?? zeroAddress)
      case 'ownerOf': {
        const id = Number(call.args[0])
        if (this.brokenOwnerOf.has(id)) return { ok: false, data: '0xdeadbeef' }
        const owner = this.owners.get(id)
        return owner ? result('ownerOf', owner) : revert('ERC721NonexistentToken', [BigInt(id)])
      }
      case 'claim': {
        const id = call.args[0]
        const to = this.proven.get(id)
        if (!to) return revert('NotProven', [id])
        if (this.owners.has(id)) return revert('ERC721InvalidSender', [zeroAddress])
        if (commit) this.owners.set(id, to)
        return { ok: true, data: '0x' }
      }
      case 'claimMany': {
        // like the contract: unproven reverts the batch, already minted is skipped
        for (const id of call.args[0]) {
          const to = this.proven.get(id)
          if (!to) return revert('NotProven', [id])
          if (commit && !this.owners.has(id)) this.owners.set(id, to)
        }
        return { ok: true, data: '0x' }
      }
      case 'submitBatch':
        // Not simulated: no test here exercises submitBatch yet. Kept as a no-op success case only so this
        // switch stays exhaustive over bridgeAbi's functionName union.
        return { ok: true, data: '0x' }
    }
  }
}
