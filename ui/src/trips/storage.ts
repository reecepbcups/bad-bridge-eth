import type { EthAddress, HubAddress, KidId } from '../chain/types'
import type { DeploymentId } from '../config/deployments'

// What this browser remembers, per deployment. Never required: every storage access is wrapped (it can
// throw in private mode, with storage disabled, or when full), and a trip's state always comes from chain.
// When storage is unusable, everything still works for this tab from the in-memory copy.
//
// 1. Remembered trips (`bad-bridge:trips:<deployment>`): kids this browser sent or claimed, with what the
//    send told us. They show up without a lookup, and the send height is a fallback while tx search hasn't
//    indexed the send yet.

/** A kid this browser sent or claimed. Everything but the id is optional (claims and old entries have less). */
export interface RememberedTrip {
  id: KidId
  /** Hub send tx hash, uppercase hex. */
  txHash?: string
  /** Hs, from the broadcast result. */
  height?: number
  /** Where it was sent. */
  recipient?: EthAddress
  /** The Hub wallet that sent it. */
  sender?: HubAddress
  /** When this browser saw the send land (local clock, ms). */
  sentAt?: number
}

/** Oldest entries are dropped past this, so storage can't grow forever. */
const MAX_REMEMBERED = 500

const TRIPS_PREFIX = 'bad-bridge:trips:'

interface Remembered {
  details: readonly RememberedTrip[]
  ids: KidId[]
}

const remembered = new Map<DeploymentId, Remembered>()
const listeners = new Set<() => void>()

// ---- storage access, all wrapped ----

function storage(): Storage | null {
  try {
    // the getter itself throws a SecurityError when site data is blocked
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value))
  } catch {
    // private mode, disabled or full: remembered for this tab only
  }
}

// ---- validation: storage is user-editable, so trust nothing ----

const isKidId = (n: unknown): n is KidId => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffff_ffff

function parseEntry(raw: unknown): RememberedTrip | null {
  if (isKidId(raw)) return { id: raw } // Phase 0 stored bare ids
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isKidId(r.id)) return null
  const entry: RememberedTrip = { id: r.id }
  if (typeof r.txHash === 'string' && /^[0-9a-fA-F]{64}$/.test(r.txHash)) entry.txHash = r.txHash.toUpperCase()
  if (Number.isSafeInteger(r.height) && (r.height as number) > 0) entry.height = r.height as number
  if (typeof r.recipient === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.recipient)) entry.recipient = r.recipient as EthAddress
  if (typeof r.sender === 'string' && /^[a-z]{1,20}1[02-9ac-hj-np-z]{6,90}$/.test(r.sender)) entry.sender = r.sender
  if (typeof r.sentAt === 'number' && Number.isFinite(r.sentAt) && r.sentAt > 0) entry.sentAt = r.sentAt
  return entry
}

function loadRemembered(deployment: DeploymentId): Remembered {
  const raw = readJson(TRIPS_PREFIX + deployment)
  const byId = new Map<KidId, RememberedTrip>()
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = parseEntry(item)
    if (entry) byId.set(entry.id, { ...byId.get(entry.id), ...entry })
  }
  return toRemembered([...byId.values()])
}

function toRemembered(details: readonly RememberedTrip[]): Remembered {
  const kept = details.slice(-MAX_REMEMBERED)
  return { details: kept, ids: kept.map((d) => d.id) }
}

function current(deployment: DeploymentId): Remembered {
  let r = remembered.get(deployment)
  if (!r) {
    r = loadRemembered(deployment)
    remembered.set(deployment, r)
  }
  return r
}

// ---- remembered trips ----

/** Remembered kid ids, oldest first. Returns the same array until it changes (useSyncExternalStore-safe). */
export function rememberedTrips(deployment: DeploymentId): KidId[] {
  return current(deployment).ids
}

/** Remembered trips with what's known about each send, oldest first. Same array until it changes. */
export function rememberedDetails(deployment: DeploymentId): readonly RememberedTrip[] {
  return current(deployment).details
}

/** One remembered trip, if this browser has it. */
export function rememberedTrip(deployment: DeploymentId, id: KidId): RememberedTrip | undefined {
  return current(deployment).details.find((d) => d.id === id)
}

/** Remembers kids (bare ids or with send details). Known ones keep their place and gain the new fields. */
export function rememberTrips(deployment: DeploymentId, add: readonly (KidId | RememberedTrip)[]): void {
  // the in-memory cache only learns about other tabs' writes via the 'storage' listener, which is only attached
  // while a subscriber is mounted: re-read localStorage fresh so a write here never clobbers a concurrent write
  // from another tab that this tab missed.
  // Merge the tab's unsaved entries too: getItem may work even when setItem fails (quota/full storage).
  const byId = new Map(current(deployment).details.map((entry) => [entry.id, entry]))
  for (const entry of loadRemembered(deployment).details) byId.set(entry.id, { ...byId.get(entry.id), ...entry })
  const details = [...byId.values()]
  let changed = false
  for (const item of add) {
    const entry = parseEntry(item)
    if (!entry) continue
    const at = details.findIndex((d) => d.id === entry.id)
    const before = details[at]
    if (!before) {
      details.push(entry)
    } else {
      const merged = { ...before, ...entry }
      if (JSON.stringify(merged) === JSON.stringify(before)) continue
      details[at] = merged
    }
    changed = true
  }
  if (!changed) return
  const next = toRemembered(details)
  remembered.set(deployment, next)
  writeJson(TRIPS_PREFIX + deployment, next.details)
  notify()
}

export function subscribeRemembered(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** Another tab wrote: drop the in-memory copies so the next read reloads. */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && !e.key.startsWith(TRIPS_PREFIX)) return
  remembered.clear()
  notify()
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Drops the in-memory copies (tests only; the next read reloads from storage). */
export function resetTripStorage(): void {
  remembered.clear()
}
