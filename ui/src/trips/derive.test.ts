import { describe, expect, it } from 'vitest'
import type { ClientStatus, EscrowRecord, KidEthStatus } from '../chain/types'
import { blocksToGo, buildTrip, compareTrips, deriveStage, type StageInput, type TripInput } from './derive'
import type { Stage, Trip } from './types'

const ALICE = '0x00000000000000000000000000000000000A11CE'
const BOB = '0x0000000000000000000000000000000000000B0B'
const HS = 1_000

const record: EscrowRecord = { tokenId: 7, recipient: ALICE }
const client = (latestHeight: number, frozen = false): ClientStatus => ({ latestHeight, frozen })
const eth = (proven: string | null, owner: string | null = null) => ({ proven, owner }) as KidEthStatus
const nothingOnEth = eth(null)

// One row per line of PLAN.md's state table, then the edge cases around it.
const cases: [name: string, input: StageInput, want: Stage][] = [
  // the table
  ['home-hub: no record', { record: null, sendHeight: null, client: client(HS), eth: nothingOnEth }, 'home-hub'],
  ['locked: record and Hs, client not read yet', { record, sendHeight: HS, client: null, eth: nothingOnEth }, 'locked'],
  ['catching-up: client behind Hs', { record, sendHeight: HS, client: client(HS - 5), eth: nothingOnEth }, 'catching-up'],
  ['proving: client past Hs, not proven', { record, sendHeight: HS, client: client(HS + 50), eth: nothingOnEth }, 'proving'],
  ['ready: proven, not minted', { record, sendHeight: HS, client: client(HS + 1), eth: eth(ALICE) }, 'ready'],
  ['home-eth: minted', { record, sendHeight: HS, client: client(HS + 1), eth: eth(ALICE, ALICE) }, 'home-eth'],
  ['crossing: record but Hs unknown', { record, sendHeight: null, client: client(HS + 1), eth: nothingOnEth }, 'crossing'],

  // the Hs boundary: the prover proves at H-1, so the client has to pass Hs, not reach it
  ['client exactly at Hs is still catching-up', { record, sendHeight: HS, client: client(HS), eth: nothingOnEth }, 'catching-up'],
  ['client at Hs + 1 is proving', { record, sendHeight: HS, client: client(HS + 1), eth: nothingOnEth }, 'proving'],

  // unknowns
  ['Hs unknown and client unknown: still crossing', { record, sendHeight: null, client: null, eth: null }, 'crossing'],
  ['Hs unknown but proven', { record, sendHeight: null, client: client(HS + 1), eth: eth(ALICE) }, 'ready'],
  ['Hs unknown but minted', { record, sendHeight: null, client: null, eth: eth(ALICE, ALICE) }, 'home-eth'],
  ['Ethereum read failed: Hub side still decides', { record, sendHeight: HS, client: client(HS + 1), eth: null }, 'proving'],
  ['Ethereum all down: locked', { record, sendHeight: HS, client: null, eth: null }, 'locked'],
  ['no record read, but proven wins', { record: null, sendHeight: null, client: null, eth: eth(ALICE) }, 'ready'],

  // frozen client: the stage is the stage; proven and minted still win
  ['frozen client, behind Hs', { record, sendHeight: HS, client: client(HS - 1, true), eth: nothingOnEth }, 'catching-up'],
  ['frozen client, past Hs', { record, sendHeight: HS, client: client(HS + 1, true), eth: nothingOnEth }, 'proving'],
  ['frozen client, proven kid is still ready', { record, sendHeight: HS, client: client(HS - 1, true), eth: eth(ALICE) }, 'ready'],
  ['frozen client, minted kid is home', { record, sendHeight: HS, client: client(HS - 1, true), eth: eth(ALICE, BOB) }, 'home-eth'],

  // owner is whoever holds it now
  ['minted, since sold to someone else', { record, sendHeight: HS, client: client(HS + 1), eth: eth(ALICE, BOB) }, 'home-eth'],
]

describe('deriveStage', () => {
  it.each(cases)('%s', (_name, input, want) => {
    expect(deriveStage(input)).toBe(want)
  })
})

describe('buildTrip', () => {
  const base: TripInput = {
    tokenId: 7,
    record,
    send: { height: HS, txHash: 'AB'.repeat(32), sender: 'cosmos1sender' },
    sentAt: new Date('2026-09-27T16:00:00Z'),
    client: client(HS + 1),
    eth: nothingOnEth,
  }

  it('fills the send facts', () => {
    expect(buildTrip(base)).toEqual({
      tokenId: 7,
      stage: 'proving',
      recipient: ALICE,
      sendTx: 'AB'.repeat(32),
      sendHeight: HS,
      sender: 'cosmos1sender',
      sentAt: base.sentAt,
    })
  })

  it.each([
    [HS - 9, 10],
    [HS - 1, 2],
    [HS, 1],
  ])('catching-up at client %i: %i blocks to go', (height, want) => {
    const trip = buildTrip({ ...base, client: client(height) })
    expect(trip).toMatchObject({ stage: 'catching-up', blocksToGo: want })
  })

  it('sets blocksToGo only while catching up', () => {
    expect(buildTrip(base).blocksToGo).toBeUndefined()
    expect(buildTrip({ ...base, client: null }).blocksToGo).toBeUndefined()
    expect(buildTrip({ ...base, send: null }).blocksToGo).toBeUndefined()
  })

  it('reports the current owner, not the recipient', () => {
    const trip = buildTrip({ ...base, eth: eth(ALICE, BOB) })
    expect(trip).toMatchObject({ stage: 'home-eth', recipient: ALICE, owner: BOB })
  })

  it('falls back to the proven recipient without a record', () => {
    expect(buildTrip({ ...base, record: null, send: null, eth: eth(BOB) })).toMatchObject({ stage: 'ready', recipient: BOB })
  })

  it('has no recipient while home', () => {
    expect(buildTrip({ ...base, record: null, send: null })).toMatchObject({ stage: 'home-hub', recipient: null })
  })
})

describe('blocksToGo', () => {
  it('counts until the client passes Hs', () => {
    expect(blocksToGo(HS, HS - 9)).toBe(10)
    expect(blocksToGo(HS, HS)).toBe(1)
    expect(blocksToGo(HS, HS + 1)).toBe(0)
    expect(blocksToGo(HS, HS + 100)).toBe(0)
  })
})

describe('compareTrips', () => {
  const trip = (tokenId: number, stage: Stage, sendHeight?: number): Trip => ({ tokenId, stage, recipient: ALICE, sendHeight })

  it('puts ready first, then in flight, then home; newest first within each', () => {
    const trips = [
      trip(1, 'home-eth', 50),
      trip(2, 'proving', 90),
      trip(3, 'ready', 10),
      trip(4, 'catching-up', 95),
      trip(5, 'crossing'),
      trip(6, 'home-hub'),
      trip(7, 'ready', 20),
      trip(8, 'home-eth', 60),
      trip(9, 'locked', 99),
    ]
    expect(trips.sort(compareTrips).map((t) => t.tokenId)).toEqual([7, 3, 9, 4, 2, 5, 8, 1, 6])
  })
})
