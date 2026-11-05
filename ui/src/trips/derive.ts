import type { ClientStatus, EscrowRecord, EthAddress, HubAddress, KidEthStatus, KidId } from '../chain/types'
import type { Stage, Trip } from './types'

/** Chain facts about one kid. null means unknown (not found, or the read failed). */
export interface StageInput {
  /** Escrow record; null if the kid never left the Hub. */
  record: EscrowRecord | null
  /** Hs, the send height; null if tx search couldn't find it. */
  sendHeight: number | null
  /** Ethereum's light client of the Hub; null if it hasn't been read. */
  client: ClientStatus | null
  /** proven / ownerOf on Ethereum; null if it hasn't been read. */
  eth: KidEthStatus | null
}

/**
 * PLAN.md's state table, in priority order:
 *
 * | stage         | when                                                        |
 * |---------------|-------------------------------------------------------------|
 * | `home-eth`    | ownerOf(id) succeeded (whoever owns it now)                 |
 * | `ready`       | proven(id) != 0, not minted                                 |
 * | `home-hub`    | no escrow record                                            |
 * | `crossing`    | record, but Hs unknown: don't guess between 2 and 3         |
 * | `locked`      | record and Hs, but the client hasn't been read              |
 * | `catching-up` | client.latestHeight <= Hs                                   |
 * | `proving`     | client.latestHeight > Hs, not proven                        |
 *
 * Proven and minted are permanent facts on Ethereum, so they win over everything: unknown Hs, a missing
 * record read, or a frozen client. A frozen client doesn't change the stage; Health.frozen drives the banner.
 *
 * The client must pass Hs (latestHeight > Hs, not >=): the prover proves against the app hash at client
 * height H, which commits to state after block H-1, and the record is in state after block Hs.
 *
 * `locked` is kept as its own stage rather than folded into `catching-up`: without the client height there's
 * no honest blocksToGo. It's a fallback (first paint after a send, or Ethereum reads failing); the hooks never
 * return it once a client read has succeeded.
 */
export function deriveStage({ record, sendHeight, client, eth }: StageInput): Stage {
  if (eth?.owner) return 'home-eth'
  if (eth?.proven) return 'ready'
  if (!record) return 'home-hub'
  if (sendHeight === null) return 'crossing'
  if (!client) return 'locked'
  if (client.latestHeight <= sendHeight) return 'catching-up'
  return 'proving'
}

/** catching-up: Hub blocks until the client passes Hs, i.e. reaches Hs + 1. Never negative. */
export function blocksToGo(sendHeight: number, clientHeight: number): number {
  return Math.max(0, sendHeight + 1 - clientHeight)
}

/** Nothing left to happen: the kid is minted. Hooks stop polling trips that are all final. */
export function isFinal(stage: Stage): boolean {
  return stage === 'home-eth'
}

/** On its way: the record exists and it isn't minted or claimable yet. */
export function isInFlight(stage: Stage): boolean {
  return stage === 'locked' || stage === 'catching-up' || stage === 'proving' || stage === 'crossing'
}

/**
 * Sort groups for lists: ready first (there's something to do), then everything in flight, then home on
 * Ethereum, then still on the Hub. Within a group, trips sort by recency (see compareTrips).
 */
export const STAGE_ORDER: Readonly<Record<Stage, number>> = {
  ready: 0,
  proving: 1,
  crossing: 1,
  'catching-up': 1,
  locked: 1,
  'home-eth': 2,
  'home-hub': 3,
}

/** List order: STAGE_ORDER group, then newest send first (unknown Hs last), then token id. */
export function compareTrips(a: Trip, b: Trip): number {
  return (
    STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] ||
    (b.sendHeight ?? -1) - (a.sendHeight ?? -1) ||
    (b.sentAt?.getTime() ?? -1) - (a.sentAt?.getTime() ?? -1) ||
    a.tokenId - b.tokenId
  )
}

/** The send, as far as it's known: from tx search, or from what this browser remembered when it sent. */
export interface SendFacts {
  /** Hs. */
  height: number
  /** Hub tx hash, when known. */
  txHash?: string
  /** Hub sender, when known. */
  sender?: HubAddress
}

/** Everything buildTrip needs about one kid. */
export interface TripInput {
  tokenId: KidId
  record: EscrowRecord | null
  send: SendFacts | null
  /** When the send landed, when known. */
  sentAt?: Date
  client: ClientStatus | null
  eth: KidEthStatus | null
}

/** Assembles a Trip from chain facts. Pure: the hooks do the reading and the remembering. */
export function buildTrip(input: TripInput): Trip {
  const { tokenId, record, send, client, eth } = input
  const stage = deriveStage({ record, sendHeight: send?.height ?? null, client, eth })
  const recipient: EthAddress | null = record?.recipient ?? eth?.proven ?? null
  const trip: Trip = { tokenId, stage, recipient }
  if (send) {
    trip.sendHeight = send.height
    if (send.txHash) trip.sendTx = send.txHash
    if (send.sender) trip.sender = send.sender
  }
  if (input.sentAt) trip.sentAt = input.sentAt
  if (eth?.owner) trip.owner = eth.owner
  if (stage === 'catching-up' && send && client) trip.blocksToGo = blocksToGo(send.height, client.latestHeight)
  return trip
}
