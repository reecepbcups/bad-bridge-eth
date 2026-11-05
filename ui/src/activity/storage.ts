import type { KidId } from '../chain/types'
import type { DeploymentId } from '../config/deployments'

// What this browser signed, per deployment (`bad-bridge:activity:<deployment>`), for the Activity tab.
// Written the moment the wallet hands back a tx hash or signature, so a tx that later fails or hangs is still
// listed. Same rules as trips/storage.ts: every storage access is wrapped, everything read back is validated
// (storage is user-editable), and when storage is unusable this tab still has the in-memory copy.

export type ActivityAction =
  | 'send'
  | 'nudge'
  | 'claim'
  | 'submit-proof'
  | 'buy-prove'
  | 'deposit-prove'
  | 'sign-proof-request'
  | 'sign-prove-permit'

export type ActivityChain = 'hub' | 'eth' | 'succinct'

/** Which chain each action lives on. Derived, not stored, so a hand-edited entry can't mismatch. */
export const ACTION_CHAIN: Readonly<Record<ActivityAction, ActivityChain>> = {
  send: 'hub',
  nudge: 'hub',
  claim: 'eth',
  'submit-proof': 'eth',
  'buy-prove': 'eth',
  'deposit-prove': 'eth',
  'sign-proof-request': 'succinct',
  'sign-prove-permit': 'succinct',
}

/** One thing this browser signed. Txs carry `hash`; off-chain signatures don't, and may carry `requestId`. */
export interface Activity {
  action: ActivityAction
  /** When the wallet handed it back (local clock, ms). */
  at: number
  /** Hub: uppercase hex. Ethereum: 0x lowercase hex. */
  hash?: string
  /** Succinct proof request id, 0x hex. */
  requestId?: string
  kids?: KidId[]
}

/** What a signing site hands recordActivity: `at` defaults to now. */
export type ActivityEntry = Omit<Activity, 'at'> & { at?: number }

/** Oldest entries are dropped past this, so storage can't grow forever. */
export const MAX_ACTIVITY = 200
const MAX_KIDS = 50

const PREFIX = 'bad-bridge:activity:'

const logs = new Map<DeploymentId, readonly Activity[]>()
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
const HUB_HASH = /^[0-9a-fA-F]{64}$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/

export function parseActivity(raw: unknown): Activity | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.action !== 'string' || !Object.hasOwn(ACTION_CHAIN, r.action)) return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at <= 0) return null
  const action = r.action as ActivityAction
  const entry: Activity = { action, at: r.at }
  const chain = ACTION_CHAIN[action]
  if (typeof r.hash === 'string') {
    if (chain === 'hub' && HUB_HASH.test(r.hash)) entry.hash = r.hash.toUpperCase()
    else if (chain === 'eth' && HEX32.test(r.hash)) entry.hash = r.hash.toLowerCase()
  }
  // a tx without its hash can't be looked up or linked, so it isn't worth keeping
  if (chain !== 'succinct' && !entry.hash) return null
  if (chain === 'succinct' && typeof r.requestId === 'string' && HEX32.test(r.requestId)) entry.requestId = r.requestId.toLowerCase()
  if (Array.isArray(r.kids)) {
    const kids = [...new Set(r.kids.filter(isKidId))].slice(0, MAX_KIDS)
    if (kids.length) entry.kids = kids
  }
  return entry
}

/** Same tx (or same signature moment) twice is one entry. */
function keyOf(a: Activity): string {
  return a.hash ?? `${a.action}:${a.at}`
}

function load(deployment: DeploymentId): Activity[] {
  const raw = readJson(PREFIX + deployment)
  const out: Activity[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = parseActivity(item)
    if (entry) out.push(entry)
  }
  return out
}

/** Dedupes by key (later wins, merged), sorts oldest first and keeps the newest MAX_ACTIVITY. */
function merge(...lists: readonly (readonly Activity[])[]): Activity[] {
  const byKey = new Map<string, Activity>()
  for (const list of lists) for (const a of list) byKey.set(keyOf(a), { ...byKey.get(keyOf(a)), ...a })
  return [...byKey.values()].sort((a, b) => a.at - b.at).slice(-MAX_ACTIVITY)
}

// ---- the log ----

/** This browser's activity, oldest first. Returns the same array until it changes (useSyncExternalStore-safe). */
export function activityLog(deployment: DeploymentId): readonly Activity[] {
  let log = logs.get(deployment)
  if (!log) {
    log = merge(load(deployment))
    logs.set(deployment, log)
  }
  return log
}

/** Logs one signed thing. Never throws: logging must not break the send it's describing. */
export function recordActivity(deployment: DeploymentId, raw: ActivityEntry): void {
  try {
    const entry = parseActivity({ at: Date.now(), ...raw })
    if (!entry) return
    // re-read storage so a write here never clobbers another tab's, and keep this tab's unsaved entries too
    const next = merge(activityLog(deployment), load(deployment), [entry])
    logs.set(deployment, next)
    writeJson(PREFIX + deployment, next)
    notify()
  } catch {
    // best effort
  }
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** Another tab wrote: drop the in-memory copies so the next read reloads. */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && !e.key.startsWith(PREFIX)) return
  logs.clear()
  notify()
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Drops the in-memory copies (tests only; the next read reloads from storage). */
export function resetActivityStorage(): void {
  logs.clear()
}
