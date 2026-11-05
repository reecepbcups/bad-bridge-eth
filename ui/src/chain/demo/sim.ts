import { keccak256, toHex, type Hex } from 'viem'
import {
  BridgeError,
  type BridgeErrorCode,
  type ClaimResult,
  type ClientStatus,
  type EscrowRecord,
  type EthAddress,
  type HubAddress,
  type HubBlock,
  type KidEthStatus,
  type KidId,
  type SendEstimate,
  type SendInfo,
  type SendResult,
  type WalletStatus,
} from '../types'
import * as seed from './seed'

// An in-memory Hub + Ethereum on a virtual clock. Sends walk through the real stages:
// record written at the current Hub height, the light client catches up past it, someone proves it,
// then the kid can be claimed. Everything is synchronous here; adapter.ts adds latency and async.

const BLOCK_MS = 6_000
const MIN = 60_000

export interface DemoTimeline {
  /** Send landed → Ethereum's client passes Hs (virtual time). */
  catchUpMs: number
  /** Prove clicked → proof made (real time). */
  proveMs: number
  /** Background Eureka relays, so the lag stays realistic in a long session (virtual time). */
  relayEveryMs: number
  /** Wallet connect prompt (real time). */
  walletMs: number
  /** Signing prompt, the "Check Keplr…" moment (real time). */
  signMs: number
  /** Every read (real time), so loading states show. */
  latencyMs: number
}

export const DEFAULT_TIMELINE: DemoTimeline = {
  catchUpMs: 5_000,
  proveMs: 3_000,
  relayEveryMs: 15 * MIN,
  walletMs: 600,
  signMs: 1_200,
  latencyMs: 150,
}

/** All real-time delays off, for unit tests and e2e. */
export const INSTANT: Partial<DemoTimeline> = { walletMs: 0, signMs: 0, latencyMs: 0, proveMs: 0 }

export interface DemoOptions {
  timeline?: Partial<DemoTimeline>
  /** Start with the clock stopped (stable screenshots). */
  paused?: boolean
  /** Start with both wallets disconnected. */
  disconnected?: boolean
  /** Also give the demo Hub wallet this many extra kids (#1000 up, no pictures), for big-wallet review. */
  extraKids?: number
  /** Pretend the deployment has no escrow or bridge yet (the provider swaps the deployment). */
  notLive?: boolean
  /** Start with the Ethereum wallet on another network. */
  wrongChain?: boolean
}

export type DemoChain = 'hub' | 'eth'

export interface DemoWallet {
  status: WalletStatus
  address?: string
  walletName?: string
}

/** Immutable view of the sim for React (useSyncExternalStore) and the dev toolbar. */
export interface DemoSnapshot {
  /** Bumps on every change. */
  version: number
  /** Virtual time, ms since the Unix epoch. */
  now: number
  hubHeight: number
  clientHeight: number
  paused: boolean
  /** Light client frozen: no relays, no proofs. Claims still work. */
  frozen: boolean
  /** Every read fails with Network. */
  offline: boolean
  /** The next write that can fail this way will, once. */
  failNext: BridgeErrorCode | null
  /** Trip events still to come (relays for sent kids). skip() jumps to the next. */
  pending: number
  hubWallet: DemoWallet
  ethWallet: DemoWallet
  /** The Ethereum wallet is on another network: claims fail with WrongChain until switchChain(). */
  ethWrongChain: boolean
}

type EventKind = 'relay' | 'background'
interface SimEvent {
  at: number
  kind: EventKind
  ids: KidId[]
}

/** Where an injected failure can surface. Codes only fire where a real chain could throw them. */
type Site = 'simulate' | 'sign' | 'claim' | 'connect'
const FAILS_AT: Record<Site, readonly BridgeErrorCode[]> = {
  simulate: ['WrongCollection', 'BadTokenId', 'BadRecipient', 'ZeroRecipient', 'AlreadyBridged', 'NotOwner', 'InsufficientFunds', 'Network', 'Unknown'],
  sign: ['UserRejected', 'WrongChain', 'Network', 'Unknown'],
  claim: ['NotProven', 'UserRejected', 'WrongChain', 'InsufficientFunds', 'Network', 'Unknown'],
  connect: ['UserRejected', 'WrongChain', 'Unknown'],
}

const hash = (label: string): Hex => keccak256(toHex(label))
const hubHash = (label: string): string => hash(label).slice(2).toUpperCase()

export class DemoSim {
  readonly timeline: DemoTimeline
  private readonly options: DemoOptions

  private now = seed.EPOCH
  private clientHeight = seed.EPOCH_CLIENT_HEIGHT
  private paused = false
  private frozen = false
  private offline = false
  private failNext: BridgeErrorCode | null = null
  /** A blocked event that finally applies counts from here, not from when it was due. */
  private unblockedAt = seed.EPOCH

  private hubOwners = new Map<KidId, HubAddress>()
  private records = new Map<KidId, EthAddress>()
  private sends = new Map<KidId, SendInfo>()
  private proven = new Map<KidId, EthAddress>()
  private ethOwners = new Map<KidId, EthAddress>()
  private events: SimEvent[] = []
  private hubWallet: DemoWallet = { status: 'disconnected' }
  private ethWallet: DemoWallet = { status: 'disconnected' }
  private txCount = 0
  private ethWrongChain = false

  private version = 0
  private snapshot!: DemoSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(options: DemoOptions = {}) {
    this.options = options
    this.timeline = { ...DEFAULT_TIMELINE, ...options.timeline }
    this.seed()
  }

  // ---- React glue (arrow fields so they can be passed around unbound) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): DemoSnapshot => this.snapshot

  // ---- clock ----

  heightAt(t: number): number {
    return seed.EPOCH_HEIGHT + Math.floor((t - seed.EPOCH) / BLOCK_MS)
  }

  timeAt(height: number): number {
    return seed.EPOCH + (height - seed.EPOCH_HEIGHT) * BLOCK_MS
  }

  get hubHeight(): number {
    return this.heightAt(this.now)
  }

  /** Autoplay step: moves the clock unless paused. Only notifies when something visible changed. */
  tick(ms: number): void {
    if (this.paused) return
    const height = this.hubHeight
    this.now += ms
    const applied = this.process()
    if (applied || this.hubHeight !== height) this.emit()
  }

  /** Moves the clock forward even while paused. */
  advance(ms: number): void {
    this.now += Math.max(0, ms)
    this.process()
    this.emit()
  }

  /** Jumps to the next relay for a sent kid. False if nothing can happen (none left, or frozen). */
  skip(): boolean {
    const next = this.events
      .filter((e) => e.kind !== 'background' && !this.frozen)
      .sort((a, b) => a.at - b.at)[0]
    if (!next) return false
    this.now = Math.max(this.now, next.at)
    this.process()
    this.emit()
    return true
  }

  // ---- dev controls ----

  setPaused(on: boolean): void {
    this.paused = on
    this.emit()
  }

  setFrozen(on: boolean): void {
    if (this.frozen && !on) this.unblockedAt = this.now
    this.frozen = on
    this.process()
    this.emit()
  }

  setOffline(on: boolean): void {
    this.offline = on
    this.emit()
  }

  setFailNext(code: BridgeErrorCode | null): void {
    this.failNext = code
    this.emit()
  }

  /** Instant connect/disconnect for the toolbar; skips prompts and injected failures. */
  setWallet(chain: DemoChain, connected: boolean): void {
    this.setWalletState(chain, connected ? this.connected(chain, chain === 'hub' ? 'Keplr' : 'MetaMask') : { status: 'disconnected' })
  }

  /** Put the Ethereum wallet on another network (or back). */
  setWrongChain(on: boolean): void {
    this.ethWrongChain = on
    this.emit()
  }

  /** The wallet's "switch network" prompt, accepted. */
  switchChain(): void {
    this.takeFailure('connect')
    this.ethWrongChain = false
    this.emit()
  }

  reset(): void {
    this.seed()
  }

  // ---- reads ----

  assertOnline(): void {
    if (this.offline) throw new BridgeError('Network', 'demo: offline mode is on')
  }

  ownedKids(owner: HubAddress): KidId[] {
    return [...this.hubOwners].filter(([, o]) => o === owner).map(([id]) => id).sort((a, b) => a - b)
  }

  record(id: KidId): EscrowRecord | null {
    const recipient = this.records.get(id)
    return recipient ? { tokenId: id, recipient } : null
  }

  allRecords(): EscrowRecord[] {
    return [...this.records].map(([tokenId, recipient]) => ({ tokenId, recipient })).sort((a, b) => a.tokenId - b.tokenId)
  }

  sendInfo(id: KidId): SendInfo | null {
    const info = this.sends.get(id)
    return info ? { ...info } : null
  }

  sendsBy(sender: HubAddress): SendInfo[] {
    return [...this.sends.values()]
      .filter((s) => s.sender === sender)
      .sort((a, b) => b.height - a.height || a.tokenId - b.tokenId)
      .map((s) => ({ ...s }))
  }

  latestBlock(): HubBlock {
    return this.block(this.hubHeight)
  }

  block(height: number): HubBlock {
    if (height > this.hubHeight) throw new BridgeError('Unknown', `demo: block ${height} doesn't exist yet`)
    return { height, time: new Date(this.timeAt(height)) }
  }

  client(): ClientStatus {
    return { latestHeight: this.clientHeight, frozen: this.frozen }
  }

  kidStatus(ids: readonly KidId[]): Map<KidId, KidEthStatus> {
    return new Map(ids.map((id) => [id, { proven: this.proven.get(id) ?? null, owner: this.ethOwners.get(id) ?? null }]))
  }

  isContract(address: EthAddress): boolean {
    return seed.CONTRACTS.some((c) => c.toLowerCase() === address.toLowerCase())
  }

  // ---- writes ----

  simulateSend(sender: HubAddress, ids: readonly KidId[], recipient: EthAddress): SendEstimate {
    this.assertOnline()
    this.takeFailure('simulate')
    this.validateSend(sender, ids, recipient)
    const gas = 150_000 + 100_000 * ids.length
    return { gas, amount: String(Math.ceil(gas * 0.005)), denom: 'uatom' }
  }

  /** The wallet half of a send: throws a failure injected for signing (UserRejected…), if there is one. */
  signSend(): void {
    this.takeFailure('sign')
  }

  /** The broadcast half of a send; the adapter simulates and waits for the "signature" first. */
  commitSend(sender: HubAddress, ids: readonly KidId[], recipient: EthAddress): SendResult {
    this.takeFailure('sign')
    this.validateSend(sender, ids, recipient)
    const height = this.hubHeight
    const txHash = hubHash(`demo:send:${++this.txCount}`)
    const time = new Date(this.timeAt(height))
    for (const id of ids) {
      this.hubOwners.delete(id)
      this.records.set(id, recipient)
      this.sends.set(id, { tokenId: id, txHash, height, sender, recipient, time })
    }
    // the record is in state after block Hs, so the client has to reach Hs+1
    this.events.push({ at: Math.max(this.now + this.timeline.catchUpMs, this.timeAt(height + 1)), kind: 'relay', ids: [...ids] })
    this.emit()
    return { txHash, height }
  }

  /** The nudge's simulate half: just validates the recipient, no kids or ownership involved. */
  simulateNudge(recipient: EthAddress): SendEstimate {
    this.assertOnline()
    this.takeFailure('simulate')
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new BridgeError('BadRecipient', `demo: ${recipient}`)
    if (/^0x0{40}$/.test(recipient)) throw new BridgeError('ZeroRecipient')
    return { gas: 130_000, amount: '650', denom: 'uatom' }
  }

  /**
   * The speed-up nudge: doesn't touch any record or proof, just pulls the next background relay forward to
   * almost now, as if a relayer had noticed the ICS20 packet and updated the client early.
   */
  nudge(recipient: EthAddress): SendResult {
    this.takeFailure('sign')
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new BridgeError('BadRecipient', `demo: ${recipient}`)
    if (/^0x0{40}$/.test(recipient)) throw new BridgeError('ZeroRecipient')
    const height = this.hubHeight
    const txHash = hubHash(`demo:nudge:${++this.txCount}`)
    this.events.push({ at: this.now + Math.min(this.timeline.catchUpMs, 2_000), kind: 'background', ids: [] })
    this.emit()
    return { txHash, height }
  }

  /** Proves every kid in `ids` the client has passed, like a submitBatch. Returns the ones it proved. */
  prove(ids: readonly KidId[]): KidId[] {
    this.takeFailure('sign')
    if (this.ethWrongChain) throw new BridgeError('WrongChain', 'demo: the Ethereum wallet is on another network')
    if (this.frozen) throw new BridgeError('ClientFrozen', 'demo: the light client is frozen')
    const proved = ids.filter((id) => {
      const recipient = this.records.get(id)
      const sent = this.sends.get(id)
      return recipient && sent && sent.height < this.clientHeight && !this.proven.has(id)
    })
    if (proved.length === 0) throw new BridgeError('Unknown', 'demo: nothing to prove yet')
    for (const id of proved) this.proven.set(id, this.records.get(id)!)
    this.txCount++
    this.emit()
    return proved
  }

  /** Mints every proven, unminted kid in `ids`, like Multicall3 aggregate3 with allowFailure. */
  claim(ids: readonly KidId[]): ClaimResult {
    this.takeFailure('claim')
    if (this.ethWrongChain) throw new BridgeError('WrongChain', 'demo: the Ethereum wallet is on another network')
    const mintable = ids.filter((id) => this.proven.has(id) && !this.ethOwners.has(id))
    if (mintable.length === 0) {
      const id = ids.find((i) => !this.proven.has(i))
      throw new BridgeError('NotProven', id === undefined ? 'demo: already claimed' : `demo: #${id} isn't proven yet`, { tokenId: id })
    }
    for (const id of mintable) this.ethOwners.set(id, this.proven.get(id)!)
    const txHash = hash(`demo:claim:${++this.txCount}`)
    this.emit()
    return { txHash, claimed: mintable }
  }

  beginConnect(chain: DemoChain): void {
    this.takeFailure('connect')
    this.setWalletState(chain, { status: 'connecting' })
  }

  finishConnect(chain: DemoChain, walletName: string): void {
    this.setWalletState(chain, this.connected(chain, walletName))
  }

  disconnect(chain: DemoChain): void {
    this.setWalletState(chain, { status: 'disconnected' })
  }

  // ---- internals ----

  private seed(): void {
    this.now = seed.EPOCH
    this.clientHeight = seed.EPOCH_CLIENT_HEIGHT
    this.paused = this.options.paused ?? false
    this.frozen = false
    this.offline = false
    this.failNext = null
    this.unblockedAt = seed.EPOCH
    this.hubOwners = new Map(seed.OWNED.map((id) => [id, seed.DEMO_HUB]))
    for (let i = 0; i < (this.options.extraKids ?? 0); i++) this.hubOwners.set(1000 + i, seed.DEMO_HUB)
    this.ethWrongChain = this.options.wrongChain ?? false
    this.records = new Map()
    this.sends = new Map()
    this.proven = new Map()
    this.ethOwners = new Map()
    this.events = []
    this.txCount = 0
    for (const t of seed.TRIPS) {
      const height = this.heightAt(t.sentAt)
      this.records.set(t.id, t.recipient)
      this.sends.set(t.id, {
        tokenId: t.id,
        txHash: hubHash(`demo:seed:${t.id}`),
        height,
        sender: t.sender,
        recipient: t.recipient,
        time: new Date(this.timeAt(height)),
      })
      if (t.proven) this.proven.set(t.id, t.recipient)
      if (t.minted) this.ethOwners.set(t.id, t.recipient)
    }
    // the last relay was 10 minutes before EPOCH
    this.events.push({ at: seed.EPOCH + Math.max(1_000, this.timeline.relayEveryMs - 10 * MIN), kind: 'background', ids: [] })
    const connected = !this.options.disconnected
    this.hubWallet = connected ? this.connected('hub', 'Keplr') : { status: 'disconnected' }
    this.ethWallet = connected ? this.connected('eth', 'MetaMask') : { status: 'disconnected' }
    this.emit()
  }

  private connected(chain: DemoChain, walletName: string): DemoWallet {
    return { status: 'connected', address: chain === 'hub' ? seed.DEMO_HUB : seed.DEMO_ETH, walletName }
  }

  private setWalletState(chain: DemoChain, wallet: DemoWallet): void {
    if (chain === 'hub') this.hubWallet = wallet
    else this.ethWallet = wallet
    this.emit()
  }

  /** Applies every due, unblocked event in time order. Returns whether anything changed. */
  private process(): boolean {
    let applied = false
    for (;;) {
      const due = this.events
        .filter((e) => e.at <= this.now && !this.frozen)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) return applied
      this.events.splice(this.events.indexOf(due), 1)
      this.apply(due, Math.max(due.at, this.unblockedAt))
      applied = true
    }
  }

  private apply(e: SimEvent, at: number): void {
    const height = this.heightAt(at)
    switch (e.kind) {
      case 'background':
        this.clientHeight = Math.max(this.clientHeight, height - 1)
        this.events.push({ at: at + this.timeline.relayEveryMs, kind: 'background', ids: [] })
        break
      case 'relay':
        this.clientHeight = Math.max(this.clientHeight, height)
        break
    }
  }

  private validateSend(sender: HubAddress, ids: readonly KidId[], recipient: EthAddress): void {
    if (ids.length === 0) throw new BridgeError('Unknown', 'demo: no kids picked')
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new BridgeError('BadRecipient', `demo: ${recipient}`)
    if (/^0x0{40}$/.test(recipient)) throw new BridgeError('ZeroRecipient')
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) throw new BridgeError('BadTokenId', String(id))
      if (this.records.has(id)) throw new BridgeError('AlreadyBridged', `demo: #${id}`, { tokenId: id })
      if (this.hubOwners.get(id) !== sender) throw new BridgeError('NotOwner', `demo: ${sender} doesn't own #${id}`, { tokenId: id })
    }
  }

  private takeFailure(site: Site): void {
    const code = this.failNext
    if (!code || !FAILS_AT[site].includes(code)) return
    this.failNext = null
    this.emit()
    throw new BridgeError(code, `demo: injected ${code}`)
  }

  private emit(): void {
    this.snapshot = {
      version: ++this.version,
      now: this.now,
      hubHeight: this.hubHeight,
      clientHeight: this.clientHeight,
      paused: this.paused,
      frozen: this.frozen,
      offline: this.offline,
      failNext: this.failNext,
      pending: this.events.filter((e) => e.kind !== 'background').length,
      hubWallet: this.hubWallet,
      ethWallet: this.ethWallet,
      ethWrongChain: this.ethWrongChain,
    }
    for (const listener of this.listeners) listener()
  }
}
