import type { QueryClient } from '@tanstack/react-query'
import {
  BridgeError,
  toBridgeError,
  type ClientStatus,
  type EscrowRecord,
  type EthReader,
  type HubBlock,
  type HubReader,
  type KidEthStatus,
  type KidId,
  type SendInfo,
} from '../chain/types'
import type { Deployment, DeploymentId } from '../config/deployments'
import { buildTrip, compareTrips, type SendFacts } from './derive'
import {
  BLOCK_SAMPLE,
  BLOCK_TIME_MS,
  FINAL_REFRESH_MS,
  KEEP_MS,
  keys,
  RECORD_GRACE_MS,
  SEND_RETRY_MS,
  SHARE_MS,
  STALE_LAG_MINUTES,
  type TripQueryKey,
} from './keys'
import { rememberedDetails, rememberedTrip, type RememberedTrip } from './storage'
import type { Health, Trip } from './types'

// The reading behind the hooks, outside React. Every chain read goes through queryClient.query() on a raw
// read key (see keys.ts), so hooks share reads and immutable facts are read once.

/** What a hook query stores: its value, plus a failure that didn't stop it (e.g. Ethereum down, Hub fine). */
export interface WithError<T> {
  value: T
  error: BridgeError | null
}

/** What the loaders need. */
export interface Ctx {
  qc: QueryClient
  deployment: Deployment
  hub: HubReader
  eth: EthReader
}

const dep = (ctx: Ctx): DeploymentId => ctx.deployment.id

type Settled<T> = { ok: true; value: T } | { ok: false; error: BridgeError }

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true, value }),
    (e: unknown) => ({ ok: false, error: toBridgeError(e) }),
  )
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
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

/** Hub reads per kid run this many at a time (tx search is the slow one). */
const HUB_CONCURRENCY = 8

// ---- raw reads ----

/** eth.client(), shared by every hook. */
export function readClient(ctx: Ctx): Promise<ClientStatus> {
  return ctx.qc.query({ queryKey: keys.client(dep(ctx)), queryFn: () => ctx.eth.client(), staleTime: SHARE_MS, retry: false })
}

/** hub.latestBlock(), shared by every hook. */
export function readLatest(ctx: Ctx): Promise<HubBlock> {
  return ctx.qc.query({ queryKey: keys.latest(dep(ctx)), queryFn: () => ctx.hub.latestBlock(), staleTime: SHARE_MS, retry: false })
}

/** A Hub block's header. Immutable. */
function readBlock(ctx: Ctx, height: number): Promise<HubBlock> {
  return ctx.qc.query({
    queryKey: keys.block(dep(ctx), height),
    queryFn: () => ctx.hub.block(height),
    staleTime: Infinity,
    gcTime: KEEP_MS,
    retry: false,
  })
}

/** Average Hub block time in seconds, over the last BLOCK_SAMPLE blocks. Rejects if it can't be measured. */
export function readBlockSeconds(ctx: Ctx, latest: HubBlock): Promise<number> {
  return ctx.qc.query({
    queryKey: keys.blockTime(dep(ctx)),
    staleTime: BLOCK_TIME_MS,
    gcTime: 2 * BLOCK_TIME_MS,
    retry: false,
    queryFn: async () => {
      if (latest.height <= BLOCK_SAMPLE) throw new BridgeError('Unknown', 'chain too short to measure block time')
      const past = await ctx.hub.block(latest.height - BLOCK_SAMPLE)
      const seconds = (latest.time.getTime() - past.time.getTime()) / 1000 / (latest.height - past.height)
      // anything outside this is a bad clock or a bad node, not a real block time
      if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 60) {
        throw new BridgeError('Unknown', `implausible block time ${seconds}s`)
      }
      return seconds
    },
  })
}

/** The escrow record. Once it exists it never changes; a null is re-read on every refresh. */
function readRecord(ctx: Ctx, id: KidId): Promise<EscrowRecord | null> {
  return ctx.qc.query({
    queryKey: keys.record(dep(ctx), id),
    queryFn: () => ctx.hub.record(id),
    staleTime: (q) => (q.state.data ? Infinity : SHARE_MS),
    gcTime: KEEP_MS,
    retry: false,
  })
}

/** The send tx. Immutable once found; a null (not indexed yet) is asked again at most every SEND_RETRY_MS. */
function readSend(ctx: Ctx, id: KidId): Promise<SendInfo | null> {
  return ctx.qc.query({
    queryKey: keys.send(dep(ctx), id),
    queryFn: () => ctx.hub.sendInfo(id),
    staleTime: (q) => (q.state.data ? Infinity : SEND_RETRY_MS),
    gcTime: KEEP_MS,
    retry: false,
  })
}

/**
 * proven / ownerOf for one kid, batched: every call made in the same tick becomes one eth.kidStatus(ids).
 * A minted kid is re-read at most every FINAL_REFRESH_MS, so polls skip finished trips.
 */
function readKidStatus(ctx: Ctx, id: KidId): Promise<KidEthStatus> {
  const load = kidStatusLoader(ctx.eth)
  return ctx.qc.query({
    queryKey: keys.kid(dep(ctx), id),
    queryFn: () => load(id),
    staleTime: (q) => (q.state.data?.owner ? FINAL_REFRESH_MS : SHARE_MS),
    gcTime: KEEP_MS,
    retry: false,
  })
}

interface Waiting {
  id: KidId
  resolve: (s: KidEthStatus) => void
  reject: (e: BridgeError) => void
}

const loaders = new WeakMap<EthReader, (id: KidId) => Promise<KidEthStatus>>()

function kidStatusLoader(eth: EthReader): (id: KidId) => Promise<KidEthStatus> {
  const existing = loaders.get(eth)
  if (existing) return existing
  let waiting: Waiting[] = []
  const flush = () => {
    const batch = waiting
    waiting = []
    const ids = [...new Set(batch.map((w) => w.id))]
    eth.kidStatus(ids).then(
      (statuses) => {
        for (const w of batch) {
          const status = statuses.get(w.id)
          if (status) w.resolve(status)
          else w.reject(new BridgeError('Unknown', `kidStatus left out #${w.id}`, { tokenId: w.id }))
        }
      },
      (e: unknown) => {
        const error = toBridgeError(e)
        for (const w of batch) w.reject(error)
      },
    )
  }
  const load = (id: KidId) =>
    new Promise<KidEthStatus>((resolve, reject) => {
      if (waiting.length === 0) queueMicrotask(flush)
      waiting.push({ id, resolve, reject })
    })
  loaders.set(eth, load)
  return load
}

// ---- trips ----

/** Facts already known from discovery, so loadTrips can skip those reads. */
export interface Known {
  record?: EscrowRecord | null
  send?: SendInfo | null
}

export function knownFromSends(sends: readonly SendInfo[]): Map<KidId, Known> {
  return new Map(sends.map((s) => [s.tokenId, { send: s, record: { tokenId: s.tokenId, recipient: s.recipient } }]))
}

/** What this browser remembered about a send, if it has the height (and the recipient, when a record is known). */
function rememberedSend(rem: RememberedTrip | undefined, record: EscrowRecord | null): SendFacts | null {
  if (!rem?.height) return null
  // a send is once per kid, so a mismatch means the memory is wrong: trust the chain
  if (record && rem.recipient && rem.recipient.toLowerCase() !== record.recipient.toLowerCase()) return null
  return { height: rem.height, txHash: rem.txHash, sender: rem.sender }
}

/**
 * Reads everything deriveStage needs for each kid, in one pass:
 * - Ethereum first, in one tick: one eth.client() (shared) and one batched eth.kidStatus() for the set.
 * - Hub per kid: record (unless known), send (unless known, falling back to what this browser remembered),
 *   and the send's block time when tx search didn't return one.
 *
 * Failures:
 * - A record read that fails with nothing cached doesn't throw (a bad kid shouldn't drop the rest of the
 *   list): it falls back to no record, unless Ethereum says proven or minted (those win), and the error comes
 *   back beside the trips.
 * - Ethereum failures don't throw. The last good client / status is used if there is one (both only move
 *   forward), else null, and the error comes back beside the trips.
 * - A failed send lookup falls back to memory, else unknown Hs (`crossing`), also reported beside the trips.
 */
export async function loadTrips(ctx: Ctx, ids: readonly KidId[], known: ReadonlyMap<KidId, Known> = new Map()): Promise<WithError<Trip[]>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return { value: [], error: null }
  const d = dep(ctx)
  const errors: BridgeError[] = []

  // started synchronously together, so the kid statuses batch into one call
  const clientP = settle(readClient(ctx))
  const statusP = Promise.all(unique.map((id) => settle(readKidStatus(ctx, id))))

  const hubFacts = await mapLimit(unique, HUB_CONCURRENCY, async (id) => {
    const k = known.get(id)
    const rem = rememberedTrip(d, id)
    let record: EscrowRecord | null
    let recordError: BridgeError | null = null
    if (k?.record !== undefined) {
      record = k.record
    } else {
      const r = await settle(readRecord(ctx, id))
      if (r.ok) record = r.value
      else {
        const cached = ctx.qc.getQueryData<EscrowRecord | null>(keys.record(d, id))
        // nothing to go on: decided below, once Ethereum has had its say
        if (cached === undefined) recordError = r.error
        else errors.push(r.error)
        record = cached ?? null
      }
    }
    // just sent from here, and this Hub node doesn't show the record yet: trust the broadcast for a bit
    if (!record && rem?.height && rem.recipient && rem.sentAt && Date.now() - rem.sentAt < RECORD_GRACE_MS) {
      record = { tokenId: id, recipient: rem.recipient }
    }

    let send: SendFacts | null = null
    let sentAt: Date | undefined
    if (record) {
      if (k?.send !== undefined) {
        const info = k.send
        if (info) {
          send = { height: info.height, txHash: info.txHash, sender: info.sender }
          sentAt = info.time
        } else {
          send = rememberedSend(rem, record)
        }
      } else {
        // not from live discovery: this id is only known locally, so try what this browser remembered before
        // paying for a tx search, which is expensive and often unnecessary when the local send is sufficient.
        send = rememberedSend(rem, record)
        if (!send) {
          const s = await settle(readSend(ctx, id))
          const info = s.ok ? s.value : (ctx.qc.getQueryData<SendInfo | null>(keys.send(d, id)) ?? null)
          if (!s.ok) errors.push(s.error)
          if (info) {
            send = { height: info.height, txHash: info.txHash, sender: info.sender }
            sentAt = info.time
          }
        }
      }
      if (send && !sentAt) {
        const b = await settle(readBlock(ctx, send.height))
        if (b.ok) sentAt = b.value.time
        else if (rem?.sentAt && rem.height === send.height) sentAt = new Date(rem.sentAt)
      }
    }
    return { id, record, recordError, send, sentAt }
  })

  const clientR = await clientP
  let client: ClientStatus | null
  if (clientR.ok) client = clientR.value
  else {
    client = ctx.qc.getQueryData<ClientStatus>(keys.client(d)) ?? null
    errors.push(clientR.error)
  }
  const statusRs = await statusP
  const statuses = new Map<KidId, KidEthStatus | null>()
  unique.forEach((id, i) => {
    const r = statusRs[i]
    if (r?.ok) statuses.set(id, r.value)
    else {
      statuses.set(id, ctx.qc.getQueryData<KidEthStatus>(keys.kid(d, id)) ?? null)
      if (r) errors.push(r.error)
    }
  })

  const trips = hubFacts.map(({ id, record, recordError, send, sentAt }) => {
    const eth = statuses.get(id) ?? null
    // no record read: proven or minted still decides the stage; otherwise this kid's stage is a guess
    // (falls back to no record), reported in error rather than failing every other kid in the list
    if (recordError) errors.push(recordError)
    return buildTrip({ tokenId: id, record, send, sentAt, client, eth })
  })

  return { value: trips, error: errors[0] ?? null }
}

/** The trip a kid would have before any Ethereum read: for seeding the cache right after a send. */
export function seededTrip(ctx: Ctx, id: KidId, send: SendInfo, sentAt: Date): Trip {
  const client = ctx.qc.getQueryData<ClientStatus>(keys.client(dep(ctx))) ?? null
  return buildTrip({
    tokenId: id,
    record: { tokenId: id, recipient: send.recipient },
    send: { height: send.height, txHash: send.txHash, sender: send.sender },
    sentAt,
    client,
    eth: null,
  })
}

// ---- discovery ----

type Source = 'eth' | 'hub' | 'ids' | 'eth-memory' | 'hub-memory'

/**
 * Trips for a TripQuery: the union of every part, deduped by token id, sorted by compareTrips.
 * - eth: every escrow record for that recipient (case-insensitive), plus trips this browser remembers
 *   sending there (kept only if the chain agrees on the recipient).
 * - hub: every send by that address (tx search), plus remembered sends from it (kept only if the send agrees).
 * - ids: those kids, whatever their state.
 * If some sources fail, the rest still load and the failure comes back beside them; if all fail, it throws.
 */
export async function discoverTrips(ctx: Ctx, q: TripQueryKey): Promise<WithError<Trip[]>> {
  const d = dep(ctx)
  const sources = new Map<KidId, Set<Source>>()
  const add = (id: KidId, source: Source) => {
    const set = sources.get(id) ?? new Set<Source>()
    set.add(source)
    sources.set(id, set)
  }
  const known = new Map<KidId, Known>()
  const errors: BridgeError[] = []
  let attempted = 0
  let failed = 0

  const tasks: Promise<void>[] = []
  if (q.eth) {
    const eth = q.eth
    attempted++
    tasks.push(
      settle(ctx.qc.query({ queryKey: keys.records(d), queryFn: () => ctx.hub.allRecords(), staleTime: Infinity, retry: false })).then((r) => {
        if (!r.ok) {
          failed++
          errors.push(r.error)
          return
        }
        for (const record of r.value) {
          if (record.recipient.toLowerCase() !== eth) continue
          add(record.tokenId, 'eth')
          known.set(record.tokenId, { ...known.get(record.tokenId), record })
        }
      }),
    )
    for (const rem of rememberedDetails(d)) if (rem.recipient?.toLowerCase() === eth) add(rem.id, 'eth-memory')
  }
  if (q.hub) {
    const hub = q.hub
    attempted++
    tasks.push(
      settle(readSendsBy(ctx, hub)).then((r) => {
        if (!r.ok) {
          failed++
          errors.push(r.error)
          return
        }
        for (const [id, k] of knownFromSends(r.value)) {
          add(id, 'hub')
          known.set(id, { ...known.get(id), ...k })
        }
      }),
    )
    for (const rem of rememberedDetails(d)) if (rem.sender === hub) add(rem.id, 'hub-memory')
  }
  if (q.ids) for (const id of parseIds(q.ids)) add(id, 'ids')
  await Promise.all(tasks)
  // every lookup failed and nothing else to show: that's an error, not "no kids"
  const [firstError] = errors
  if (firstError && failed === attempted && sources.size === 0) throw firstError

  const loaded = await loadTrips(ctx, [...sources.keys()], known)
  const trips = loaded.value.filter((trip) => {
    const from = sources.get(trip.tokenId)
    if (!from || from.has('eth') || from.has('hub') || from.has('ids')) return true
    // remembered only: keep it if the chain agrees it belongs to this query
    if (from.has('eth-memory') && q.eth && trip.recipient?.toLowerCase() === q.eth) return true
    if (from.has('hub-memory') && q.hub && trip.sender === q.hub) return true
    return false
  })
  return { value: trips.sort(compareTrips), error: errors[0] ?? loaded.error }
}

/** hub.sendsBy(), shared, and its sends cached per kid (they're immutable). */
export async function readSendsBy(ctx: Ctx, sender: string): Promise<SendInfo[]> {
  const d = dep(ctx)
  const sends = await ctx.qc.query({ queryKey: keys.sendsBy(d, sender), queryFn: () => ctx.hub.sendsBy(sender), staleTime: SHARE_MS, retry: false })
  for (const s of sends) {
    if (!ctx.qc.getQueryData(keys.send(d, s.tokenId))) ctx.qc.setQueryData(keys.send(d, s.tokenId), s)
  }
  return sends
}

/** hub.ownedKids(), shared. */
export function readOwnedKids(ctx: Ctx, owner: string): Promise<KidId[]> {
  return ctx.qc.query({ queryKey: keys.ownedKids(dep(ctx), owner), queryFn: () => ctx.hub.ownedKids(owner), staleTime: SHARE_MS, retry: false })
}

/** A kid still in the wallet: the pick screen's tile. */
export function homeTrip(id: KidId): Trip {
  return { tokenId: id, stage: 'home-hub', recipient: null }
}

/** The pick screen's order: kids still home first (ascending), then sent ones (compareTrips). */
export function sortOwned(trips: readonly Trip[]): Trip[] {
  const home = trips.filter((t) => t.stage === 'home-hub').sort((a, b) => a.tokenId - b.tokenId)
  const sent = trips.filter((t) => t.stage !== 'home-hub').sort(compareTrips)
  return [...home, ...sent]
}

/**
 * The connected Hub wallet's kids: owned ones (home-hub), plus every kid it sent (tx search, plus this
 * browser's memory while tx search catches up) with its current stage. A kid with a record counts as sent
 * even if a lagging node still lists it as owned.
 */
export async function loadOwned(ctx: Ctx, owner: string, withSends: boolean): Promise<WithError<Trip[]>> {
  const d = dep(ctx)
  const [ownedR, sendsR] = await Promise.all([
    settle(readOwnedKids(ctx, owner)),
    withSends ? settle(readSendsBy(ctx, owner)) : Promise.resolve<Settled<SendInfo[]>>({ ok: true, value: [] }),
  ])
  if (!ownedR.ok) throw ownedR.error
  const known = sendsR.ok ? knownFromSends(sendsR.value) : new Map<KidId, Known>()
  const ids = new Set(known.keys())
  for (const rem of rememberedDetails(d)) if (rem.sender === owner) ids.add(rem.id)
  const sent = await loadTrips(ctx, [...ids], known)
  // remembered but the chain says it never left (the grace window passed): it's just an owned kid
  const moving = sent.value.filter((t) => t.stage !== 'home-hub')
  const movingIds = new Set(moving.map((t) => t.tokenId))
  const home = ownedR.value.filter((id) => !movingIds.has(id)).map(homeTrip)
  return { value: sortOwned([...home, ...moving]), error: sendsR.ok ? sent.error : sendsR.error }
}

/** Health from the shared client and latest block, falling back to the last good ones (then stale). */
export async function loadHealth(ctx: Ctx): Promise<WithError<Health>> {
  const d = dep(ctx)
  const [latestR, clientR] = await Promise.all([settle(readLatest(ctx)), settle(readClient(ctx))])
  const latest = latestR.ok ? latestR.value : ctx.qc.getQueryData<HubBlock>(keys.latest(d))
  const client = clientR.ok ? clientR.value : ctx.qc.getQueryData<ClientStatus>(keys.client(d))
  const error = (!clientR.ok ? clientR.error : null) ?? (!latestR.ok ? latestR.error : null)
  if (!latest || !client) throw error ?? new BridgeError('Unknown', 'no health data')
  const measured = await settle(readBlockSeconds(ctx, latest))
  const avgBlockSeconds = measured.ok ? measured.value : ctx.deployment.hub.blockSeconds
  const lagBlocks = Math.max(0, latest.height - client.latestHeight)
  const lagMinutes = (lagBlocks * avgBlockSeconds) / 60
  return {
    value: {
      hubHeight: latest.height,
      clientHeight: client.latestHeight,
      lagBlocks,
      lagMinutes,
      frozen: client.frozen,
      stale: error !== null || lagMinutes > STALE_LAG_MINUTES,
      avgBlockSeconds,
    },
    error,
  }
}

// ---- query normalization ----

const MAX_KID_ID = 0xffff_ffff

export function isKidId(id: unknown): id is KidId {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) <= MAX_KID_ID
}

/** Sorted unique valid ids as a key string. */
export function idsKey(ids: readonly KidId[]): string {
  return [...new Set(ids.filter(isKidId))].sort((a, b) => a - b).join(',')
}

function parseIds(key: string): KidId[] {
  return key ? key.split(',').map(Number).filter(isKidId) : []
}
