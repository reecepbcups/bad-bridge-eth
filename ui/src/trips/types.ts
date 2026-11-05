// Workstream C owns src/trips/. These types are the contract the UI codes against.

import type { Hex } from 'viem'
import type { BridgeError, ClaimResult, ClaimStage, EthAddress, HubAddress, KidId, SendResult, SendStage } from '../chain/types'

/**
 * Where a kid is on its trip. Rebuilt from chain state every time (see derive.ts and PLAN.md's state table).
 * - `locked`: the record exists and Hs is known, but Ethereum's client hasn't been read yet (first load, or
 *   every Ethereum read failed). A fallback, not a step: normal reads go straight to `catching-up`.
 * - `crossing`: the record exists but the send height Hs is unknown, so stages 2 and 3 can't be told apart.
 */
export type Stage = 'home-hub' | 'locked' | 'catching-up' | 'proving' | 'ready' | 'home-eth' | 'crossing'

/** One kid's journey. */
export interface Trip {
  /** The kid. */
  tokenId: KidId
  /** Where it is now. */
  stage: Stage
  /** Ethereum recipient from the escrow record; null while the kid is still on the Hub. */
  recipient: EthAddress | null
  /** Hub send tx hash, when tx search found it. */
  sendTx?: string
  /** Hs: Hub height of the send, when known. */
  sendHeight?: number
  /** When the send landed. */
  sentAt?: Date
  /** Hub address that sent it. */
  sender?: HubAddress
  /** Current Ethereum owner once minted. Can differ from recipient after a transfer. */
  owner?: EthAddress
  /** catching-up only: Hub blocks until Ethereum's client passes Hs (Hs + 1 - client height, at least 1). */
  blocksToGo?: number
}

/** Options for the trip hooks. */
export interface TripOptions {
  /** Poll every ~10s instead of 30s, for the crossing screen. */
  live?: boolean
}

/** How far behind Ethereum's view of the Hub is. Drives "Ethereum is N min behind" and the paused banner. */
export interface Health {
  /** Latest Hub height. */
  hubHeight: number
  /** Latest Hub height Ethereum's light client has seen. */
  clientHeight: number
  /** hubHeight - clientHeight, never negative. */
  lagBlocks: number
  /** lagBlocks in minutes at the Hub's measured block time. */
  lagMinutes: number
  /** Light client frozen: sending is disabled site-wide. */
  frozen: boolean
  /**
   * Don't trust "N min behind": Ethereum is over 3 hours behind, or the last client or Hub read failed and
   * these numbers are old (QueryState.error says why).
   */
  stale: boolean
  /** Average Hub block time in seconds, measured over the last 1000 blocks (deployment default if that failed). */
  avgBlockSeconds?: number
}

/** Which trips to find. Fields combine (union). An empty query finds nothing. */
export interface TripQuery {
  /** Every kid whose escrow record points at this Ethereum address. */
  eth?: EthAddress
  /** Every kid this Hub address sent. */
  hub?: HubAddress
  /** These kids, whatever their state. */
  ids?: readonly KidId[]
}

/** One way BadBridge's link to the light client differs from the deployment. */
export interface WiringMismatch {
  field: 'router' | 'clientId' | 'lightClient' | 'chainId'
  expected: string
  actual: string
}

/** A startup sanity check that failed. Any problem hard-disables sending. */
export type ConfigProblem = (
  /** the deployment has no escrow or bridge yet */
  | { code: 'NotLive' }
  | { code: 'ClientUnavailable'; reason: 'frozen' | 'expired' | 'retired' }
  | { code: 'EscrowAdmin'; power: 'upgrade' | 'emergency unlock'; admin: HubAddress }
  /** the escrow accepts a different cw721 than the deployment's */
  | { code: 'EscrowCollection'; expected: HubAddress; actual: HubAddress }
  /** bridge.ESCROW() isn't the deployment's escrow (or isn't 32 bytes, or the configured escrow isn't) */
  | { code: 'BridgeEscrow'; expected: Hex; actual: Hex }
  /**
   * BadBridge isn't wired to the light client the deployment expects: its ROUTER(), its clientId(), the client
   * the router hands back, or the chain that client follows (one entry per mismatch)
   */
  | { code: 'BridgeClient'; mismatches: WiringMismatch[] }
) & {
  /** Plain-English explanation, always set by useConfigSanity. describeConfigProblem() builds it. */
  message?: string
}

/**
 * Where the sanity check landed. Only `ok` allows sending.
 * - `mismatch`: a contract disagrees with the deployment (see problems).
 * - `not-live`: the deployment has no escrow or bridge yet.
 * - `unknown`: a read failed, so nothing is proven either way. QueryState.error says why; it re-checks every 30s.
 */
export type SanityStatus = 'ok' | 'mismatch' | 'not-live' | 'unknown'

/** Result of the startup sanity check. */
export interface ConfigSanity {
  /** Sending is allowed. Only true once both checks passed. Treat "still loading" (no data) as not ok too. */
  ok: boolean
  /** What's wrong, for the visible error. Empty when ok or unknown. */
  problems: ConfigProblem[]
  /** Shown but don't block sending: escrow admins, so the UI can be tested before they're removed. */
  warnings?: ConfigProblem[]
  /** Why ok is what it is. Always set by useConfigSanity. */
  status?: SanityStatus
}

/** A read hook's result. Deliberately smaller than react-query's, so the implementation can change. */
export interface QueryState<T> {
  /** Latest good value. Kept while refetching and after a failed refresh. */
  data: T | undefined
  /** Last failure, or null. */
  error: BridgeError | null
  /** First load: no data yet and a fetch is running. */
  isLoading: boolean
  /** Any fetch is running, including background refreshes. */
  isFetching: boolean
  /** Refetch now. */
  refetch: () => void
}

/** A write hook's result. */
export interface MutationState<Args extends unknown[], Result> {
  /** Runs the write. Rejects with a BridgeError; the same error lands in `error`. */
  run: (...args: Args) => Promise<Result>
  /** idle until run() is called. */
  status: 'idle' | 'pending' | 'success' | 'error'
  /** The last successful result. */
  data: Result | undefined
  /** The last failure, or null. */
  error: BridgeError | null
  /** Back to idle. */
  reset: () => void
}

/** Options for useSendKids. */
export interface SendKidsOptions {
  /** Hears each stage of a running send, as HubWriter.send reports it. */
  onStage?: (stage: SendStage) => void
}

/** useSendKids(): the mutation plus where a running send is. */
export interface SendKidsState extends MutationState<[ids: readonly KidId[], recipient: EthAddress], SendResult> {
  /** simulating → signing → broadcasting while a send runs; null otherwise (and briefly before the first stage). */
  stage: SendStage | null
}

/** Options for useClaimKids. */
export interface ClaimKidsOptions {
  /** Hears each stage of a running claim, as EthWriter.claim reports it. */
  onStage?: (stage: ClaimStage) => void
}

/** useClaimKids(): the mutation plus where a running claim is. */
export interface ClaimKidsState extends MutationState<[ids: readonly KidId[]], ClaimResult> {
  /** signing → confirming while a claim runs; null otherwise (and briefly before the first stage). */
  stage: ClaimStage | null
}

/** Options for useNudge. */
export interface NudgeOptions {
  /** Hears each stage of a running nudge, as HubWriter.nudge reports it. */
  onStage?: (stage: SendStage) => void
}

/** useNudge(): the mutation plus where a running speed-up send is. */
export interface NudgeState extends MutationState<[recipient: EthAddress], SendResult> {
  /** simulating → signing → broadcasting while a nudge runs; null otherwise (and briefly before the first stage). */
  stage: SendStage | null
}
