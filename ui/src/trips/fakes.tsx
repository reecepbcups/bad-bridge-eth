// Test-only: a hand-rolled chain behind BridgeContext, for hook tests that need failures, counters and exact
// heights the demo sim doesn't offer. Never imported by app code.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Hex } from 'viem'
import { vi } from 'vitest'
import { BridgeContext, type BridgeContextValue } from '../chain/context'
import {
  BridgeError,
  type BridgeWiring,
  type ClaimOptions,
  type ClientStatus,
  type ContractInfo,
  type EthAddress,
  type EthReader,
  type EthWriter,
  type HubAddress,
  type HubReader,
  type HubWriter,
  type KidId,
  type SendInfo,
  type SendOptions,
  type TxStatus,
  type WalletState,
} from '../chain/types'
import { DEPLOYMENTS, type Deployment } from '../config/deployments'
import { escrowBytes32 } from './sanity'

export const ALICE: EthAddress = '0x00000000000000000000000000000000000A11CE'
export const BOB: EthAddress = '0x0000000000000000000000000000000000000B0B'
export const HUB_A: HubAddress = 'cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl'
export const HUB_B: HubAddress = 'cosmos1qa3t6xrnec5cfhe6jhcyhfsptjm3ymwg6vlqk8'

/** Hub height "now" in the fake chain. */
export const NOW_HEIGHT = 10_000
/** Block time of NOW_HEIGHT. */
export const NOW_TIME = Date.parse('2026-09-27T17:00:00Z')

export const LIVE: Deployment = DEPLOYMENTS['reece-test']
// Bad Kids as it was before launch, with no escrow or bridge yet.
const realBadkids = DEPLOYMENTS.badkids
export const NOT_LIVE: Deployment = {
  ...realBadkids,
  hub: { ...realBadkids.hub, escrow: null },
  eth: { ...realBadkids.eth, bridge: null },
  explorer: { ...realBadkids.explorer, ethToken: () => null, opensea: () => null, openseaCollection: () => null },
}
export const GOOD_ESCROW = escrowBytes32(LIVE.hub.escrow ?? '') as Hex

/** Mutable chain state. Tests poke it between reads. */
export interface FakeChain {
  /** escrow records: id → recipient */
  records: Map<KidId, EthAddress>
  /** what allRecords() returns, when it should differ from records (a lagging node) */
  allRecords?: Map<KidId, EthAddress>
  /** tx search: id → send */
  sends: Map<KidId, SendInfo>
  /** cw721 owners on the Hub */
  owned: Map<HubAddress, KidId[]>
  client: ClientStatus
  proven: Map<KidId, EthAddress>
  owners: Map<KidId, EthAddress>
  hubHeight: number
  /** seconds per Hub block */
  blockSeconds: number
  escrowCw721: string
  bridgeEscrow: Hex
  /** What bridgeWiring() returns. Defaults to the deployment's own settings. */
  wiring: BridgeWiring
  /** What hubClientId() returns: the Hub-side client id for the speed-up nudge. */
  hubClientId: string
  /** contractInfo(): address → info. Missing addresses fail with Unknown. */
  contracts: Map<HubAddress, ContractInfo>
  /** proxyImplementation(): lowercase address → implementation. */
  proxies: Map<string, EthAddress>
  emergencyAdmin: HubAddress | null
  clientExpired: boolean
  clientRetired: boolean
  /** wei, for estimateClaim() */
  gasPrice: bigint
  /** txStatus(): hash → status. Missing hashes read as pending. */
  txs: Map<string, TxStatus>
  /** make a read fail: method name → error */
  fail: Partial<Record<keyof HubReader | keyof EthReader, BridgeError>>
}

export function fakeChain(init: Partial<FakeChain> = {}): FakeChain {
  return {
    records: new Map(),
    sends: new Map(),
    owned: new Map(),
    client: { latestHeight: NOW_HEIGHT - 100, frozen: false },
    proven: new Map(),
    owners: new Map(),
    hubHeight: NOW_HEIGHT,
    blockSeconds: 6,
    escrowCw721: LIVE.hub.cw721,
    bridgeEscrow: GOOD_ESCROW,
    wiring: { router: LIVE.eth.router, clientId: LIVE.eth.clientId, lightClient: LIVE.eth.lightClient, chainId: LIVE.hub.chainId },
    hubClientId: '08-wasm-1369',
    contracts: new Map(LIVE.hub.escrow ? [[LIVE.hub.escrow, { codeId: 750, admin: null }]] : []),
    proxies: new Map(),
    emergencyAdmin: null,
    clientExpired: false,
    clientRetired: false,
    gasPrice: 1_000_000_000n,
    txs: new Map(),
    fail: {},
    ...init,
  }
}

/** A send at `height` (time derived from the fake block time). */
export function send(chain: FakeChain, id: KidId, height: number, recipient: EthAddress, sender: HubAddress = HUB_A): SendInfo {
  const info: SendInfo = {
    tokenId: id,
    txHash: id.toString(16).padStart(64, '0').toUpperCase(),
    height,
    sender,
    recipient,
    time: timeAt(chain, height),
  }
  chain.records.set(id, recipient)
  chain.sends.set(id, info)
  return info
}

export function timeAt(chain: FakeChain, height: number): Date {
  return new Date(NOW_TIME - (chain.hubHeight - height) * chain.blockSeconds * 1000)
}

const net = () => new BridgeError('Network', 'fake: down')

export function fakeReaders(chain: FakeChain) {
  const guard = <T,>(name: keyof HubReader | keyof EthReader, fn: () => T): Promise<T> => {
    const error = chain.fail[name]
    return error ? Promise.reject(error) : Promise.resolve().then(fn)
  }
  const hub = {
    escrowAdmin: vi.fn(() => guard('escrowAdmin', () => chain.emergencyAdmin)),
    ownedKids: vi.fn((owner: HubAddress) => guard('ownedKids', () => [...(chain.owned.get(owner) ?? [])].sort((a, b) => a - b))),
    record: vi.fn((id: KidId) =>
      guard('record', () => {
        const recipient = chain.records.get(id)
        return recipient ? { tokenId: id, recipient } : null
      }),
    ),
    allRecords: vi.fn(() =>
      guard('allRecords', () =>
        [...(chain.allRecords ?? chain.records)].map(([tokenId, recipient]) => ({ tokenId, recipient })).sort((a, b) => a.tokenId - b.tokenId),
      ),
    ),
    sendInfo: vi.fn((id: KidId) => guard('sendInfo', () => chain.sends.get(id) ?? null)),
    sendsBy: vi.fn((sender: HubAddress) =>
      guard('sendsBy', () => [...chain.sends.values()].filter((s) => s.sender === sender).sort((a, b) => b.height - a.height)),
    ),
    latestBlock: vi.fn(() => guard('latestBlock', () => ({ height: chain.hubHeight, time: timeAt(chain, chain.hubHeight) }))),
    block: vi.fn((height: number) => guard('block', () => ({ height, time: timeAt(chain, height) }))),
    escrowCw721: vi.fn(() => guard('escrowCw721', () => chain.escrowCw721)),
    contractInfo: vi.fn((address: HubAddress) =>
      guard('contractInfo', () => {
        const info = chain.contracts.get(address)
        if (!info) throw new BridgeError('Unknown', `fake: no contract ${address}`)
        return { ...info }
      }),
    ),
    txStatus: vi.fn((hash: string) => guard('txStatus', () => chain.txs.get(hash) ?? 'pending')),
  } satisfies HubReader
  const eth = {
    clientSafety: vi.fn(() => guard('clientSafety', () => ({ frozen: chain.client.frozen, expired: chain.clientExpired, retired: chain.clientRetired }))),
    client: vi.fn(() => guard('client', () => ({ ...chain.client }))),
    kidStatus: vi.fn((ids: readonly KidId[]) =>
      guard('kidStatus', () => new Map(ids.map((id) => [id, { proven: chain.proven.get(id) ?? null, owner: chain.owners.get(id) ?? null }]))),
    ),
    isContract: vi.fn(() => Promise.resolve(false)),
    bridgeEscrow: vi.fn(() => guard('bridgeEscrow', () => chain.bridgeEscrow)),
    bridgeWiring: vi.fn(() => guard('bridgeWiring', () => ({ ...chain.wiring }))),
    proxyImplementation: vi.fn((address: EthAddress) => guard('proxyImplementation', () => chain.proxies.get(address.toLowerCase()) ?? null)),
    estimateClaim: vi.fn((ids: readonly KidId[]) =>
      guard('estimateClaim', () => {
        const n = Math.max(1, new Set(ids).size)
        const gas = 79_000n + 30_000n * BigInt(n - 1)
        const claimable = ids.length > 0 && ids.every((id) => chain.proven.has(id) && !chain.owners.has(id))
        return { gas: Number(gas), gasPrice: chain.gasPrice.toString(), fee: (gas * chain.gasPrice).toString(), simulated: claimable }
      }),
    ),
    hubClientId: vi.fn(() => guard('hubClientId', () => chain.hubClientId)),
    txStatus: vi.fn((hash: Hex) => guard('txStatus', () => chain.txs.get(hash) ?? 'pending')),
  } satisfies EthReader
  return { hub, eth }
}

/** A Hub writer that lands sends at the current height. `indexed: false` leaves tx search behind. */
export function fakeHubWriter(chain: FakeChain, address: HubAddress, { indexed = true } = {}) {
  return {
    address,
    simulateSend: vi.fn((ids: readonly KidId[]) => Promise.resolve({ gas: 100_000 * ids.length, amount: '500', denom: 'uatom' })),
    send: vi.fn((ids: readonly KidId[], recipient: EthAddress, options?: SendOptions) => {
      options?.onStage?.('simulating')
      options?.onStage?.('signing')
      options?.onStage?.('broadcasting')
      const height = chain.hubHeight
      for (const id of ids) {
        chain.records.set(id, recipient)
        chain.owned.set(address, (chain.owned.get(address) ?? []).filter((k) => k !== id))
        if (indexed) send(chain, id, height, recipient, address)
      }
      return Promise.resolve({ txHash: 'AB'.repeat(32), height })
    }),
    nudge: vi.fn((_sourceClientId: string, _recipient: EthAddress, options?: SendOptions) => {
      options?.onStage?.('simulating')
      options?.onStage?.('signing')
      options?.onStage?.('broadcasting')
      return Promise.resolve({ txHash: 'CD'.repeat(32), height: chain.hubHeight })
    }),
  } satisfies HubWriter
}

/** An Ethereum writer that mints every proven kid it's asked for. */
export function fakeEthWriter(chain: FakeChain, address: EthAddress) {
  return {
    address,
    claim: vi.fn((ids: readonly KidId[], options?: ClaimOptions) => {
      options?.onStage?.('signing')
      options?.onStage?.('confirming')
      const claimed: KidId[] = []
      for (const id of ids) {
        const to = chain.proven.get(id)
        if (to) {
          chain.owners.set(id, to)
          claimed.push(id)
        }
      }
      return Promise.resolve({ txHash: `0x${'cd'.repeat(32)}` as const, claimed })
    }),
  } satisfies EthWriter
}

function wallet<A extends string>(address: A | undefined): WalletState<A> {
  return {
    status: address ? 'connected' : 'disconnected',
    address,
    options: [],
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  }
}

export interface FakeBridge {
  chain: FakeChain
  hub: ReturnType<typeof fakeReaders>['hub']
  eth: ReturnType<typeof fakeReaders>['eth']
  queryClient: QueryClient
  wrapper: (props: { children: ReactNode }) => ReactNode
}

/** renderHook() wrapper over a FakeChain. The readers are vi.fn()s, so tests can count calls. */
export function fakeBridge(
  chain: FakeChain = fakeChain(),
  options: { deployment?: Deployment; hubWriter?: HubWriter | null; ethWriter?: EthWriter | null } = {},
): FakeBridge {
  const { hub, eth } = fakeReaders(chain)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const hubWriter = options.hubWriter ?? null
  const ethWriter = options.ethWriter ?? null
  const value: BridgeContextValue = {
    deployment: options.deployment ?? LIVE,
    hub,
    eth,
    hubWallet: wallet<HubAddress>(hubWriter?.address),
    ethWallet: wallet<EthAddress>(ethWriter?.address),
    hubWriter,
    ethWriter,
    proveKid: null,
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>
    </QueryClientProvider>
  )
  return { chain, hub, eth, queryClient, wrapper }
}

export { net as networkError }

/** Makes window.localStorage itself throw, like Safari with site data blocked. Returns the undo. */
export function breakLocalStorage(): () => void {
  const own = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    },
  })
  return () => {
    if (own) Object.defineProperty(window, 'localStorage', own)
    else Reflect.deleteProperty(window, 'localStorage')
  }
}
