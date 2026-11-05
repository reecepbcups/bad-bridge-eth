// Workstream C: the trip hooks. Signatures here are the contract the UI codes against.
//
// Every hook reads chain state through useBridge() and react-query. Hook queries poll (30s, or 10s with
// { live: true }); the chain reads underneath are shared between hooks and cached by how much they can change
// (see keys.ts). A failure that doesn't stop a hook, like Ethereum being down while the Hub answers, comes back
// in QueryState.error beside the data that did load.

import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query'
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useBridge } from '../chain/context'
import {
  BridgeError,
  toBridgeError,
  type ClaimEstimate,
  type ClaimStage,
  type EthAddress,
  type KidId,
  type SendEstimate,
  type SendInfo,
  type SendResult,
  type SendStage,
} from '../chain/types'
import { isLive } from '../config/deployments'
import { compareTrips, isFinal } from './derive'
import { idsKey, isKidId, discoverTrips, loadHealth, loadOwned, loadTrips, seededTrip, sortOwned, type Ctx, type WithError } from './load'
import { keys, LIVE_POLL_MS, POLL_MS, type TripQueryKey } from './keys'
import { notLive, readSendSanity } from './sanity'
import { loadTrustFacts, type TrustFacts } from './trust'
import { rememberedTrips, rememberTrips, subscribeRemembered } from './storage'
import type {
  ClaimKidsOptions,
  ClaimKidsState,
  ConfigSanity,
  Health,
  MutationState,
  NudgeOptions,
  NudgeState,
  QueryState,
  SendKidsOptions,
  SendKidsState,
  Trip,
  TripOptions,
  TripQuery,
} from './types'

export { LIVE_POLL_MS, POLL_MS } from './keys'
export { describeConfigProblem } from './sanity'
export type { TrustFacts } from './trust'

/**
 * The connected Hub wallet's kids, for the pick screen: still-home ones first (ascending, stage `home-hub`),
 * then every kid it sent, with its current stage (ready first, then in flight, then home on Ethereum), so a
 * kid picked here that then left (sent from elsewhere) can drop out of the pick. Idle (no data) until a Hub
 * wallet is connected.
 */
export function useOwnedKids(): QueryState<Trip[]> {
  const ctx = useCtx()
  const { hubWallet } = useBridge()
  const owner = hubWallet.status === 'connected' ? hubWallet.address : undefined
  const q = useQuery({
    queryKey: keys.owned(ctx.deployment.id, owner),
    enabled: owner !== undefined,
    refetchInterval: POLL_MS,
    queryFn: () => (owner ? loadOwned(ctx, owner, isLive(ctx.deployment)) : Promise.resolve({ value: [], error: null })),
  })
  return useTripsState(ctx, q)
}

/**
 * Trips matching any part of `query` (union, deduped by kid): ready first, then in flight, then home, newest
 * send first within each. An empty query finds nothing and stays idle.
 * - `eth`: every escrow record for that recipient (case-insensitive), plus kids this browser sent there.
 * - `hub`: every send by that Hub address, plus kids this browser sent from it.
 * - `ids`: those kids, whatever their state.
 * Polls every 30s (10s with `live`). A query for `ids` alone stops polling once every kid is home on Ethereum.
 */
export function useTrips(query: TripQuery, options?: TripOptions): QueryState<Trip[]> {
  const ctx = useCtx()
  const key = normalizeQuery(query)
  const discovering = Boolean(key.eth || key.hub)
  const interval = options?.live ? LIVE_POLL_MS : POLL_MS
  const q = useQuery({
    queryKey: keys.trips(ctx.deployment.id, key),
    enabled: Boolean(key.eth || key.hub || key.ids),
    refetchInterval: (query) => {
      const trips = query.state.data?.value
      // a lookup can always find new kids; a fixed set of kids is done once they're all home
      return !discovering && trips?.length && trips.every((t) => isFinal(t.stage)) ? false : interval
    },
    queryFn: () => discoverTrips(ctx, key),
  })
  return useTripsState(ctx, q)
}

/**
 * One kid's trip, whatever its state (a kid that never left is `home-hub`). Polls every 30s (10s with `live`)
 * and stops once it's home on Ethereum. A malformed id fails with BadTokenId.
 */
export function useTrip(id: KidId, options?: TripOptions): QueryState<Trip> {
  const ctx = useCtx()
  const interval = options?.live ? LIVE_POLL_MS : POLL_MS
  const q = useQuery({
    queryKey: keys.trip(ctx.deployment.id, id),
    ...(isKidId(id) ? {} : { retry: false }),
    refetchInterval: (query) => (query.state.data && isFinal(query.state.data.value.stage) ? false : interval),
    queryFn: async (): Promise<WithError<Trip>> => {
      if (!isKidId(id)) throw new BridgeError('BadTokenId', String(id), { tokenId: id })
      const { value, error } = await loadTrips(ctx, [id])
      const [trip] = value
      if (!trip) throw new BridgeError('Unknown', `no trip for #${id}`, { tokenId: id })
      return { value: trip, error }
    },
  })
  return { ...toQueryState(q), refetch: () => refetchNow(ctx, q, [keys.kid(ctx.deployment.id, id), keys.client(ctx.deployment.id)]) }
}

/**
 * How far behind Ethereum's view of the Hub is, whether the client is frozen, and whether to trust it.
 * lagMinutes uses the Hub's block time measured over the last 1000 blocks (cached for an hour; the
 * deployment's ~6s if it can't be measured). A failed read keeps the last numbers with stale: true and
 * the failure in error. Polls every 30s (10s with `live`).
 */
export function useHealth(options?: TripOptions): QueryState<Health> {
  const ctx = useCtx()
  const q = useQuery({
    queryKey: keys.health(ctx.deployment.id),
    refetchInterval: options?.live ? LIVE_POLL_MS : POLL_MS,
    queryFn: () => loadHealth(ctx),
  })
  const d = ctx.deployment.id
  const state = { ...toQueryState(q), refetch: () => refetchNow(ctx, q, [keys.client(d), keys.latest(d)]) }
  // a whole refresh failed: the old numbers are still shown, so say they're old
  return state.data && q.isError ? { ...state, data: { ...state.data, stale: true } } : state
}

/**
 * Sends kids from the connected Hub wallet in one tx. Right before the wallet is involved it re-reads Ethereum's
 * light client, not the cached health: frozen refuses with ClientFrozen, unreadable with Network, and nothing is
 * sent either way. Once it lands:
 * - remembers them in this browser (ids, tx hash, height, recipient, sender, time), best effort;
 * - seeds the cache, so useTrip(id) and useTrips({ ids }) for the sent kids show them at once with Hs known
 *   (`catching-up`, or `locked` if Ethereum's client hasn't been read yet), and the pick screen shows them sent;
 * - refreshes owned kids and every trip list.
 * Rejects with a BridgeError; bookkeeping after a successful send never makes it reject.
 * `stage` says where a running send is (simulating → signing → broadcasting); `options.onStage` hears the same.
 */
export function useSendKids(options?: SendKidsOptions): SendKidsState {
  const ctx = useCtx()
  const { hubWriter } = useBridge()
  const [stage, setStage] = useState<SendStage | null>(null)
  const onStage = useLatest(options?.onStage)
  const m = useMutation({
    mutationKey: ['bridge', ctx.deployment.id, 'send'] as const,
    mutationFn: async ([ids, recipient]: [readonly KidId[], EthAddress]) => {
      setStage(null)
      if (!hubWriter) throw new BridgeError('Unknown', 'Hub wallet not connected')
      if (ids.length === 0) throw new BridgeError('Unknown', 'no kids picked')
      const report = (s: SendStage) => {
        setStage(s)
        onStage.current?.(s)
      }
      await checkClientFresh(ctx)
      const result = await hubWriter.send(ids, recipient, { onStage: report })
      try {
        afterSend(ctx, hubWriter.address, [...new Set(ids)], recipient, result)
      } catch {
        // the kids are on their way whatever happens here; the next poll finds them
      }
      return result
    },
  })
  return { ...toMutationState(m), stage: m.status === 'pending' ? stage : null }
}

/**
 * Claims proven kids from the connected Ethereum wallet (one tx for any number). Once mined, the claimed kids
 * show as home at once (owner = their recipient), and every trip is re-read to confirm.
 * `stage` says where a running claim is (signing → confirming); `options.onStage` hears the same.
 */
export function useClaimKids(options?: ClaimKidsOptions): ClaimKidsState {
  const ctx = useCtx()
  const { ethWriter } = useBridge()
  const [stage, setStage] = useState<ClaimStage | null>(null)
  const onStage = useLatest(options?.onStage)
  const m = useMutation({
    mutationKey: ['bridge', ctx.deployment.id, 'claim'] as const,
    mutationFn: async ([ids]: [readonly KidId[]]) => {
      setStage(null)
      if (!ethWriter) throw new BridgeError('Unknown', 'Ethereum wallet not connected')
      if (ids.length === 0) throw new BridgeError('Unknown', 'no kids to claim')
      const report = (s: ClaimStage) => {
        setStage(s)
        onStage.current?.(s)
      }
      const result = await ethWriter.claim(ids, { onStage: report })
      try {
        afterClaim(ctx, [...new Set(ids)])
      } catch {
        // minted either way; the next poll shows it
      }
      return result
    },
  })
  return { ...toMutationState(m), stage: m.status === 'pending' ? stage : null }
}

/**
 * The "speed up" nudge: a small ATOM ICS20 transfer from the connected Hub wallet, over the Hub-side Eureka
 * client for Ethereum (read fresh from the router right before sending, like useSendKids re-reads the light
 * client). Best effort: it doesn't seed any trip state, since nothing about a kid's trip actually changes until
 * a relayer notices and updates the client on its own.
 * `stage` says where a running nudge is (simulating → signing → broadcasting); `options.onStage` hears the same.
 */
export function useNudge(options?: NudgeOptions): NudgeState {
  const { hubWriter, eth } = useBridge()
  const [stage, setStage] = useState<SendStage | null>(null)
  const onStage = useLatest(options?.onStage)
  const m = useMutation({
    mutationFn: async ([recipient]: [EthAddress]) => {
      setStage(null)
      if (!hubWriter) throw new BridgeError('Unknown', 'Hub wallet not connected')
      const report = (s: SendStage) => {
        setStage(s)
        onStage.current?.(s)
      }
      const sourceClientId = await eth.hubClientId()
      return hubWriter.nudge(sourceClientId, recipient, { onStage: report })
    },
  })
  return { ...toMutationState(m), stage: m.status === 'pending' ? stage : null }
}

/** Simulates sending `ids` to `recipient` from the connected Hub wallet. Idle until all three exist. */
export function useSendEstimate(ids: readonly KidId[], recipient: EthAddress | null): QueryState<SendEstimate> {
  const { deployment, hubWriter } = useBridge()
  const key = idsKey(ids)
  return toQueryState(
    useQuery({
      queryKey: keys.estimate(deployment.id, hubWriter?.address, key, recipient),
      enabled: hubWriter !== null && key !== '' && recipient !== null,
      retry: false,
      staleTime: 30_000,
      gcTime: 60_000,
      queryFn: async (): Promise<WithError<SendEstimate>> => {
        if (!hubWriter || !recipient || !key) throw new BridgeError('Unknown', 'nothing to simulate')
        return { value: await hubWriter.simulateSend(key.split(',').map(Number), recipient), error: null }
      },
    }),
  )
}

/**
 * The startup check behind Send: the escrow accepts our cw721, bridge.ESCROW() is our escrow (32 bytes), and the
 * bridge reaches the configured light client through the pinned Eureka router, following the Hub's chain id.
 * Send only when data?.ok === true: no data (loading), `unknown` (a read failed; error says why, re-checked
 * every 30s), `mismatch` and `not-live` all mean no. A definitive answer is re-checked at most every POLL_MS,
 * so escrow/wiring changing server-side mid-session doesn't stay cached for the rest of the tab's life.
 */
export function useConfigSanity(): QueryState<ConfigSanity> {
  const { deployment, hub, eth } = useBridge()
  return toQueryState(
    useQuery({
      queryKey: keys.sanity(deployment.id),
      staleTime: POLL_MS,
      retry: false,
      refetchInterval: POLL_MS,
      queryFn: async (): Promise<WithError<ConfigSanity>> => {
        if (!deployment.hub.escrow || !isLive(deployment)) return { value: notLive(), error: null }
        try {
          return { value: await readSendSanity(deployment, hub, eth), error: null }
        } catch (e) {
          const error = toBridgeError(e)
          if (error.code === 'NotLive') return { value: notLive(), error: null }
          // couldn't read: that proves nothing either way, so it's not ok and not a mismatch
          return { value: { ok: false, status: 'unknown', problems: [] }, error }
        }
      },
    }),
  )
}

/**
 * What claiming `ids` would cost now, in wei (see EthReader.estimateClaim). An empty list prices one typical kid,
 * for copy like the FAQ. Re-read every minute.
 */
export function useClaimEstimate(ids: readonly KidId[]): QueryState<ClaimEstimate> {
  const { deployment, eth } = useBridge()
  const key = idsKey(ids)
  return toQueryState(
    useQuery({
      queryKey: keys.claimEstimate(deployment.id, key),
      enabled: isLive(deployment),
      staleTime: 60_000,
      refetchInterval: 60_000,
      queryFn: async (): Promise<WithError<ClaimEstimate>> => ({
        value: await eth.estimateClaim(key ? key.split(',').map(Number) : []),
        error: null,
      }),
    }),
  )
}

/**
 * Who could change the contracts a kid depends on, read live: the escrow's admin and code id, the collection's
 * admin, and whether BadBridge's Eureka router is upgradeable. A fact that couldn't be read is undefined, and the
 * failure is in `error`. From public RPCs: good for catching mistakes, not a trust anchor.
 */
export function useTrustFacts(): QueryState<TrustFacts> {
  const { deployment, hub, eth } = useBridge()
  return toQueryState(
    useQuery({
      queryKey: keys.trust(deployment.id),
      staleTime: 5 * 60_000,
      queryFn: () => loadTrustFacts(deployment, hub, eth),
    }),
  )
}

/** Kids this browser sent or claimed, oldest first. Survives reloads when storage works; never required. */
export function useRememberedTrips(): KidId[] {
  const { deployment } = useBridge()
  return useSyncExternalStore(subscribeRemembered, () => rememberedTrips(deployment.id))
}

// ---- internals ----

/** A ref that always holds the latest `value`, for callbacks that outlive the render that made them. */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

function useCtx(): Ctx {
  const { deployment, hub, eth } = useBridge()
  const qc = useQueryClient()
  return useMemo(() => ({ qc, deployment, hub, eth }), [qc, deployment, hub, eth])
}

function normalizeQuery(query: TripQuery): TripQueryKey {
  const key: TripQueryKey = {}
  const eth = query.eth?.trim().toLowerCase()
  const hub = query.hub?.trim()
  const ids = query.ids ? idsKey(query.ids) : ''
  if (eth) key.eth = eth
  if (hub) key.hub = hub
  if (ids) key.ids = ids
  return key
}

/** QueryState for a trip list; refetch() also re-reads minted kids' owners, which polls skip. */
function useTripsState(ctx: Ctx, q: UseQueryResult<WithError<Trip[]>>): QueryState<Trip[]> {
  const d = ctx.deployment.id
  return { ...toQueryState(q), refetch: () => refetchNow(ctx, q, [keys.kidAll(d), keys.client(d)]) }
}

/** An explicit refetch means now: the shared reads it depends on are re-read even if a hook just read them. */
function refetchNow(ctx: Ctx, q: UseQueryResult<unknown>, reads: readonly (readonly unknown[])[]): void {
  for (const queryKey of reads) void ctx.qc.invalidateQueries({ queryKey, refetchType: 'none' })
  void q.refetch()
}

/** Refreshes the client, wiring and both escrow-admin checks before involving the wallet. */
async function checkClientFresh(ctx: Ctx): Promise<void> {
  const d = ctx.deployment.id
  let frozen: boolean
  try {
    const client = await ctx.eth.client()
    ctx.qc.setQueryData(keys.client(d), client)
    frozen = client.frozen
  } catch (e) {
    void ctx.qc.invalidateQueries({ queryKey: keys.health(d) })
    const error = toBridgeError(e)
    throw new BridgeError(error.code === 'NotLive' ? 'NotLive' : 'Network', `couldn't re-check Ethereum's light client before sending, so nothing was sent: ${error.detail ?? error.code}`, { cause: e })
  }
  if (frozen) {
    void ctx.qc.invalidateQueries({ queryKey: keys.health(d) })
    throw new BridgeError('ClientFrozen', "Ethereum's light client of the Hub is frozen, so nothing was sent")
  }
  try {
    const sanity = await readSendSanity(ctx.deployment, ctx.hub, ctx.eth)
    ctx.qc.setQueryData(keys.sanity(d), { value: sanity, error: null })
    if (!sanity.ok) throw new BridgeError('Unknown', `${sanity.problems.map((p) => p.message).join(' ')} Nothing was sent.`)
  } catch (e) {
    void ctx.qc.invalidateQueries({ queryKey: keys.sanity(d) })
    throw toBridgeError(e)
  }
}

function afterSend(ctx: Ctx, sender: string, ids: readonly KidId[], recipient: EthAddress, result: SendResult): void {
  const { qc, deployment } = ctx
  const d = deployment.id
  const now = Date.now()
  rememberTrips(
    d,
    ids.map((id) => ({ id, txHash: result.txHash, height: result.height, recipient, sender, sentAt: now })),
  )

  // the record and the send are facts now, and immutable: seed them so no read has to find them
  const trips = ids.map((id) => {
    const send: SendInfo = { tokenId: id, txHash: result.txHash, height: result.height, sender, recipient }
    qc.setQueryData(keys.record(d, id), { tokenId: id, recipient })
    qc.setQueryData(keys.send(d, id), send)
    return seededTrip(ctx, id, send, new Date(now))
  })
  for (const trip of trips) qc.setQueryData<WithError<Trip>>(keys.trip(d, trip.tokenId), { value: trip, error: null })
  qc.setQueryData<WithError<Trip[]>>(keys.trips(d, { ids: idsKey(ids) }), { value: [...trips].sort(compareTrips), error: null })
  replaceTrips(qc, keys.owned(d, sender), trips, sortOwned)

  // everything that lists kids re-reads; the reads seeded above stay put
  invalidate(qc, [keys.ownedKidsAll(d), keys.sendsByAll(d), keys.records(d)], [keys.tripsAll(d), keys.tripAll(d), keys.ownedAll(d)])
}

function afterClaim(ctx: Ctx, ids: readonly KidId[]): void {
  const { qc, deployment } = ctx
  const d = deployment.id
  rememberTrips(d, ids)
  const claimed = new Set(ids)
  // minted to the proven recipient; the refresh below confirms (a kid that somehow wasn't flips back)
  const flip = (t: Trip): Trip =>
    claimed.has(t.tokenId) && t.stage === 'ready' && t.recipient ? { ...t, stage: 'home-eth', owner: t.recipient } : t
  qc.setQueriesData<WithError<Trip[]>>({ queryKey: keys.tripsAll(d) }, (old) =>
    old ? { ...old, value: old.value.map(flip).sort(compareTrips) } : old,
  )
  qc.setQueriesData<WithError<Trip[]>>({ queryKey: keys.ownedAll(d) }, (old) =>
    old ? { ...old, value: sortOwned(old.value.map(flip)) } : old,
  )
  for (const id of ids) qc.setQueryData<WithError<Trip>>(keys.trip(d, id), (old) => (old ? { ...old, value: flip(old.value) } : old))
  invalidate(
    qc,
    ids.map((id) => keys.kid(d, id)),
    [keys.tripsAll(d), keys.tripAll(d), keys.ownedAll(d)],
  )
}

/** Puts `trips` into a cached list in place of the same kids, keeping the list's order rule. */
function replaceTrips(qc: QueryClient, key: readonly unknown[], trips: readonly Trip[], sort: (t: readonly Trip[]) => Trip[]): void {
  const byId = new Map(trips.map((t) => [t.tokenId, t]))
  qc.setQueryData<WithError<Trip[]>>(key, (old) => {
    if (!old) return old
    const rest = old.value.filter((t) => !byId.has(t.tokenId))
    return { ...old, value: sort([...rest, ...trips]) }
  })
}

/**
 * Marks raw reads stale first, then refetches the hook queries. Order matters: an active hook query refetches
 * synchronously on invalidation, and would reuse a raw read that isn't marked yet.
 */
function invalidate(qc: QueryClient, reads: readonly (readonly unknown[])[], hookQueries: readonly (readonly unknown[])[]): void {
  for (const queryKey of reads) void qc.invalidateQueries({ queryKey, refetchType: 'none' })
  for (const queryKey of hookQueries) void qc.invalidateQueries({ queryKey })
}

function toQueryState<T>(q: UseQueryResult<WithError<T>>): QueryState<T> {
  return {
    data: q.data?.value,
    error: q.error ? toBridgeError(q.error) : (q.data?.error ?? null),
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    refetch: () => void q.refetch(),
  }
}

function toMutationState<Args extends unknown[], Result>(
  m: UseMutationResult<Result, Error, Args>,
): MutationState<Args, Result> {
  return {
    run: (...args) => m.mutateAsync(args).catch((e: unknown) => Promise.reject(toBridgeError(e))),
    status: m.status,
    data: m.data,
    error: m.error ? toBridgeError(m.error) : null,
    reset: m.reset,
  }
}
