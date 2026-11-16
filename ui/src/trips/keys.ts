import type { KidId } from '../chain/types'
import type { DeploymentId } from '../config/deployments'

// react-query keys and timings for src/trips. Everything lives under ['bridge', deployment].
//
// Two layers:
// - Hook queries ('trips', 'trip', 'owned', 'health', 'sanity', 'estimate', 'claim-estimate', 'trust'): what the
//   hooks return. Most of them poll.
// - Raw reads ('read', …): one chain read each, fetched through queryClient.query() from inside the hook
//   queries. They never poll on their own; their staleTime decides whether a hook refresh re-reads them, so
//   hooks share them (one eth.client() for every hook on the page) and immutable facts are read once.

/** How often trips and health refresh on their own. */
export const POLL_MS = 30_000
/** Polling with { live: true }, for the crossing screen. */
export const LIVE_POLL_MS = 10_000
/** A read younger than this is reused instead of repeated, so hooks refreshing together share one read. */
export const SHARE_MS = 5_000
/** tx search found no send yet (not indexed, or the kid never left): ask again at most this often. */
export const SEND_RETRY_MS = 60_000
/** A minted kid's owner is re-read at most this often (it only changes on a transfer). Polls skip it otherwise. */
export const FINAL_REFRESH_MS = 10 * 60_000
/** Measured Hub block time is reused for this long. */
export const BLOCK_TIME_MS = 60 * 60_000
/** Immutable reads (sends, records, blocks) and last-known statuses stay cached this long without a hook. */
export const KEEP_MS = 60 * 60_000
/** Health is stale (don't trust "N min behind") once Ethereum is this far behind the Hub. */
export const STALE_LAG_MINUTES = 3 * 60
/** Blocks sampled for the average Hub block time. */
export const BLOCK_SAMPLE = 1_000
/** After a send, trust this browser's memory of it over a Hub node that doesn't show the record yet, for this long. */
export const RECORD_GRACE_MS = 10 * 60_000

/** A TripQuery reduced to its identity: lowercased eth and owner, trimmed hub, sorted unique ids. */
export interface TripQueryKey {
  eth?: string
  owner?: string
  hub?: string
  ids?: string
}

const root = (d: DeploymentId) => ['bridge', d] as const

export const keys = {
  all: root,

  // hook queries
  tripsAll: (d: DeploymentId) => [...root(d), 'trips'] as const,
  trips: (d: DeploymentId, q: TripQueryKey) => [...root(d), 'trips', q] as const,
  tripAll: (d: DeploymentId) => [...root(d), 'trip'] as const,
  trip: (d: DeploymentId, id: KidId) => [...root(d), 'trip', id] as const,
  ownedAll: (d: DeploymentId) => [...root(d), 'owned'] as const,
  owned: (d: DeploymentId, owner: string | undefined) => [...root(d), 'owned', owner] as const,
  health: (d: DeploymentId) => [...root(d), 'health'] as const,
  sanity: (d: DeploymentId) => [...root(d), 'sanity'] as const,
  estimate: (d: DeploymentId, sender: string | undefined, ids: string, recipient: string | null) =>
    [...root(d), 'estimate', sender, ids, recipient] as const,
  claimEstimate: (d: DeploymentId, ids: string) => [...root(d), 'claim-estimate', ids] as const,
  trust: (d: DeploymentId) => [...root(d), 'trust'] as const,

  // raw reads
  latest: (d: DeploymentId) => [...root(d), 'read', 'latest'] as const,
  client: (d: DeploymentId) => [...root(d), 'read', 'client'] as const,
  blockTime: (d: DeploymentId) => [...root(d), 'read', 'blockTime'] as const,
  block: (d: DeploymentId, height: number) => [...root(d), 'read', 'block', height] as const,
  record: (d: DeploymentId, id: KidId) => [...root(d), 'read', 'record', id] as const,
  send: (d: DeploymentId, id: KidId) => [...root(d), 'read', 'send', id] as const,
  kidAll: (d: DeploymentId) => [...root(d), 'read', 'kid'] as const,
  kid: (d: DeploymentId, id: KidId) => [...root(d), 'read', 'kid', id] as const,
  records: (d: DeploymentId) => [...root(d), 'read', 'records'] as const,
  sendsByAll: (d: DeploymentId) => [...root(d), 'read', 'sendsBy'] as const,
  sendsBy: (d: DeploymentId, sender: string) => [...root(d), 'read', 'sendsBy', sender] as const,
  ownedKidsAll: (d: DeploymentId) => [...root(d), 'read', 'ownedKids'] as const,
  ownedKids: (d: DeploymentId, owner: string) => [...root(d), 'read', 'ownedKids', owner] as const,
  heldKids: (d: DeploymentId, owner: string) => [...root(d), 'read', 'heldKids', owner] as const,
}
