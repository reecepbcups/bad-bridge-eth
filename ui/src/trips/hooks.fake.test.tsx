import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, type KidId } from '../chain/types'
import {
  ALICE,
  BOB,
  breakLocalStorage,
  fakeBridge,
  fakeChain,
  fakeEthWriter,
  fakeHubWriter,
  HUB_A,
  HUB_B,
  LIVE,
  networkError,
  NOT_LIVE,
  NOW_HEIGHT,
  send,
} from './fakes'
import {
  POLL_MS,
  useClaimEstimate,
  useClaimKids,
  useConfigSanity,
  useHealth,
  useOwnedKids,
  useRememberedTrips,
  useSendEstimate,
  useSendKids,
  useTrip,
  useTrips,
  useTrustFacts,
} from './hooks'
import { rememberedTrip, rememberTrips, resetTripStorage } from './storage'
import type { QueryState, Trip } from './types'

// Hook tests over a hand-rolled chain (fakes.tsx): exact heights, injected failures, call counters.

const LIVE_ID = 'reece-test'
const CLIENT = NOW_HEIGHT - 100
const MIN = 60_000

/** A chain with one kid at every stage, all headed to ALICE and sent by HUB_A unless noted. */
function everyStage() {
  const chain = fakeChain({ client: { latestHeight: CLIENT, frozen: false } })
  send(chain, 1, CLIENT - 500, ALICE) // proving
  send(chain, 2, CLIENT + 50, ALICE) // catching-up, 51 to go
  send(chain, 3, CLIENT - 900, ALICE) // ready
  chain.proven.set(3, ALICE)
  send(chain, 4, CLIENT - 2000, ALICE) // home, since sold to BOB
  chain.proven.set(4, ALICE)
  chain.owners.set(4, BOB)
  send(chain, 5, CLIENT - 300, BOB, HUB_B) // someone else's
  chain.records.set(6, ALICE) // crossing: tx search can't find the send
  return chain
}

const stages = (trips: readonly Trip[] | undefined) => trips?.map((t) => [t.tokenId, t.stage])

async function loaded<T>(result: { current: QueryState<T> }): Promise<T> {
  await waitFor(() => expect(result.current.data).toBeDefined())
  return result.current.data as T
}

beforeEach(() => {
  localStorage.clear()
  resetTripStorage()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  resetTripStorage()
})

describe('useTrips discovery', () => {
  it('finds every record for an Ethereum address, any case, sorted by urgency then recency', async () => {
    const { wrapper } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrips({ eth: ALICE.toLowerCase() as typeof ALICE }), { wrapper })
    const trips = await loaded(result)
    expect(stages(trips)).toEqual([
      [3, 'ready'],
      [2, 'catching-up'],
      [1, 'proving'],
      [6, 'crossing'],
      [4, 'home-eth'],
    ])
    expect(trips.find((t) => t.tokenId === 2)).toMatchObject({ blocksToGo: 51, sendHeight: CLIENT + 50, sender: HUB_A })
    expect(trips.find((t) => t.tokenId === 4)).toMatchObject({ recipient: ALICE, owner: BOB })
    expect(result.current.error).toBeNull()
  })

  it('adds remembered trips for that recipient, if the chain agrees', async () => {
    const chain = everyStage()
    chain.allRecords = new Map([[1, ALICE]]) // a node whose `pending` pages lag behind
    rememberTrips(LIVE_ID, [
      { id: 2, recipient: ALICE, height: CLIENT + 50 },
      { id: 5, recipient: ALICE }, // memory says ALICE, the chain says BOB: dropped
      { id: 3, recipient: BOB }, // someone else's lookup
    ])
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ eth: ALICE }), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [2, 'catching-up'],
      [1, 'proving'],
    ])
  })

  it('finds every send by a Hub address, without re-reading what tx search returned', async () => {
    const { wrapper, hub } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrips({ hub: HUB_B }), { wrapper })
    expect(stages(await loaded(result))).toEqual([[5, 'proving']])
    expect(result.current.data?.[0]).toMatchObject({ sender: HUB_B, recipient: BOB })
    expect(hub.record).not.toHaveBeenCalled()
    expect(hub.sendInfo).not.toHaveBeenCalled()
  })

  it('loads kids by id, whatever their state', async () => {
    const { wrapper } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrips({ ids: [99, 4, 1] }), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [1, 'proving'],
      [4, 'home-eth'],
      [99, 'home-hub'],
    ])
  })

  it('combines every part of the query and lists each kid once', async () => {
    const { wrapper } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrips({ eth: ALICE, hub: HUB_B, ids: [3, 3, 99, 5] }), { wrapper })
    const trips = await loaded(result)
    expect(trips.map((t) => t.tokenId)).toEqual([3, 2, 5, 1, 6, 4, 99])
  })

  it('stays idle for an empty query', () => {
    const { wrapper, hub } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrips({ ids: [] }), { wrapper })
    expect(result.current).toMatchObject({ data: undefined, isLoading: false, error: null })
    expect(hub.allRecords).not.toHaveBeenCalled()
  })

  it('fails when the only lookup fails', async () => {
    const chain = everyStage()
    chain.fail.allRecords = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ eth: ALICE }), { wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe('Network'))
    expect(result.current.data).toBeUndefined()
  })

  it('shows what one lookup found when another fails', async () => {
    const chain = everyStage()
    chain.fail.sendsBy = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ eth: BOB, hub: HUB_B }), { wrapper })
    expect(stages(await loaded(result))).toEqual([[5, 'proving']])
    expect(result.current.error?.code).toBe('Network')
  })
})

describe('useTrips reads', () => {
  it('batches Ethereum status into one call and shares the client read between hooks', async () => {
    const { wrapper, eth } = fakeBridge(everyStage())
    const { result } = renderHook(() => ({ trips: useTrips({ ids: [1, 2, 3] }), one: useTrip(4), health: useHealth() }), { wrapper })
    await waitFor(() => expect(result.current.trips.data && result.current.one.data && result.current.health.data).toBeTruthy())
    expect(eth.client).toHaveBeenCalledTimes(1)
    // one call for the list's kids together (the lone kid may ride along or get its own)
    expect(eth.kidStatus.mock.calls.length).toBeLessThanOrEqual(2)
    expect(eth.kidStatus.mock.calls.some(([ids]) => [1, 2, 3].every((id) => ids.includes(id)))).toBe(true)
  })

  it('reads a found send once, and a missing one only slowly', async () => {
    const { wrapper, hub } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrips({ ids: [1, 6] }), { wrapper })
    await loaded(result)
    expect(hub.sendInfo).toHaveBeenCalledTimes(2)
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(hub.sendInfo).toHaveBeenCalledTimes(2)
  })

  it("falls back to this browser's memory of Hs while tx search can't find the send", async () => {
    rememberTrips(LIVE_ID, [{ id: 6, height: CLIENT - 10, recipient: ALICE, txHash: 'AB'.repeat(32) }])
    const { wrapper } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrip(6), { wrapper })
    expect(await loaded(result)).toMatchObject({ stage: 'proving', sendHeight: CLIENT - 10, sendTx: 'AB'.repeat(32) })
  })

  it('trusts a fresh send from this browser over a Hub node that lags behind it', async () => {
    const chain = everyStage()
    rememberTrips(LIVE_ID, [{ id: 42, height: NOW_HEIGHT, recipient: ALICE, sender: HUB_A, sentAt: Date.now() - MIN }])
    rememberTrips(LIVE_ID, [{ id: 43, height: NOW_HEIGHT - 500, recipient: ALICE, sender: HUB_A, sentAt: Date.now() - 60 * MIN }])
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ ids: [42, 43] }), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [42, 'catching-up'],
      [43, 'home-hub'], // an hour on and still no record: believe the chain
    ])
  })
})

describe('Ethereum failures', () => {
  it('still returns the Hub side, with the error beside it', async () => {
    const chain = everyStage()
    chain.fail.client = networkError()
    chain.fail.kidStatus = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ ids: [1, 6, 99] }), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [1, 'locked'],
      [6, 'crossing'],
      [99, 'home-hub'],
    ])
    expect(result.current.error).toBeInstanceOf(BridgeError)
    expect(result.current.error?.code).toBe('Network')
  })

  it('keeps the last known Ethereum facts when a refresh fails', async () => {
    const chain = everyStage()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ ids: [1, 3] }), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [3, 'ready'],
      [1, 'proving'],
    ])
    chain.fail.client = networkError()
    chain.fail.kidStatus = networkError()
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.error?.code).toBe('Network'))
    expect(stages(result.current.data)).toEqual([
      [3, 'ready'],
      [1, 'proving'],
    ])
  })

  it("guesses a kid's stage when its record can't be read, rather than failing it: the error comes back beside it", async () => {
    const chain = everyStage()
    chain.fail.record = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrip(99), { wrapper })
    expect(await loaded(result)).toMatchObject({ tokenId: 99, stage: 'home-hub' })
    expect(result.current.error?.code).toBe('Network')
  })

  it("still shows a proven or minted kid whose record can't be read", async () => {
    const chain = everyStage()
    chain.fail.record = networkError()
    chain.fail.sendInfo = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ ids: [3, 4] }), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [3, 'ready'],
      [4, 'home-eth'],
    ])
    expect(result.current.data?.[1]).toMatchObject({ recipient: ALICE, owner: BOB })
    expect(result.current.error?.code).toBe('Network')
  })

  it('rejects a malformed id without reading', async () => {
    const { wrapper, hub } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrip(-1), { wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe('BadTokenId'))
    expect(hub.record).not.toHaveBeenCalled()
  })
})

describe('polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  it('stops for kids that are home on Ethereum', async () => {
    const { wrapper, eth, hub } = fakeBridge(everyStage())
    const { result } = renderHook(() => ({ list: useTrips({ ids: [4] }), one: useTrip(4) }), { wrapper })
    await waitFor(() => expect(result.current.list.data && result.current.one.data).toBeTruthy())
    const reads = hub.record.mock.calls.length + eth.client.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(3 * POLL_MS))
    expect(hub.record.mock.calls.length + eth.client.mock.calls.length).toBe(reads)
  })

  it('keeps going for kids still on their way, faster when live', async () => {
    const { wrapper, eth } = fakeBridge(everyStage())
    const { result } = renderHook(() => useTrip(1, { live: true }), { wrapper })
    await loaded(result)
    const before = eth.client.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS + 1_000))
    expect(eth.client.mock.calls.length - before).toBeGreaterThanOrEqual(3)
  })

  it("keeps polling an address, but skips its cached records table and a minted kid's owner", async () => {
    const chain = everyStage()
    chain.proven.set(5, BOB)
    chain.owners.set(5, BOB)
    const { wrapper, eth, hub } = fakeBridge(chain)
    const { result } = renderHook(() => useTrips({ eth: BOB }), { wrapper })
    expect(stages(await loaded(result))).toEqual([[5, 'home-eth']])
    const [records, statuses] = [hub.allRecords.mock.calls.length, eth.kidStatus.mock.calls.length]
    await act(() => vi.advanceTimersByTimeAsync(2 * POLL_MS + 1_000))
    // allRecords is staleTime: Infinity (an effectively-immutable table): afterSend invalidates it, polling alone doesn't
    expect(hub.allRecords.mock.calls.length).toBe(records)
    // the minted kid's owner is re-read at most every FINAL_REFRESH_MS, which polling alone hasn't reached
    expect(eth.kidStatus.mock.calls.length).toBe(statuses)
  })
})

describe('without localStorage', () => {
  it('sends and remembers for this tab', async () => {
    const restore = breakLocalStorage()
    try {
      const chain = everyStage()
      chain.owned.set(HUB_A, [10, 11])
      const hubWriter = fakeHubWriter(chain, HUB_A)
      const { wrapper } = fakeBridge(chain, { hubWriter })
      const { result } = renderHook(() => ({ send: useSendKids(), remembered: useRememberedTrips(), trip: useTrip(1) }), { wrapper })
      await act(() => result.current.send.run([10], ALICE))
      expect(result.current.remembered).toEqual([10])
      await waitFor(() => expect(result.current.trip.data?.stage).toBe('proving'))
    } finally {
      restore()
    }
  })
})

describe('useConfigSanity', () => {
  it('passes when both contracts match', async () => {
    const { wrapper } = fakeBridge()
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    expect(await loaded(result)).toEqual({ ok: true, status: 'ok', problems: [] })
  })

  it('lists mismatches in plain words', async () => {
    const chain = fakeChain({ escrowCw721: 'cosmos1somethingelse', bridgeEscrow: `0x${'11'.repeat(32)}` })
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    const sanity = await loaded(result)
    expect(sanity).toMatchObject({ ok: false, status: 'mismatch' })
    expect(sanity.problems.map((p) => p.code)).toEqual(['EscrowCollection', 'BridgeEscrow'])
    expect(sanity.problems.every((p) => typeof p.message === 'string' && p.message.length > 0)).toBe(true)
  })

  it('flags a bridge wired to another router or light client', async () => {
    const chain = fakeChain()
    chain.wiring = { ...chain.wiring, router: BOB, chainId: 'theta-testnet-001' }
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    const sanity = await loaded(result)
    expect(sanity).toMatchObject({ ok: false, status: 'mismatch', problems: [{ code: 'BridgeClient' }] })
    expect(sanity.problems[0]?.message).toMatch(/asks router .* not IBC Eureka's .*follows theta-testnet-001/)
  })

  it('treats a failed wiring read as unknown, not ok', async () => {
    const chain = fakeChain()
    chain.fail.bridgeWiring = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    expect(await loaded(result)).toEqual({ ok: false, status: 'unknown', problems: [] })
  })

  it('treats a failed read as unknown, not ok, and says why', async () => {
    const chain = fakeChain()
    chain.fail.bridgeEscrow = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    expect(await loaded(result)).toEqual({ ok: false, status: 'unknown', problems: [] })
    expect(result.current.error?.code).toBe('Network')

    delete chain.fail.bridgeEscrow
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.data?.ok).toBe(true))
    expect(result.current.error).toBeNull()
  })

  it('reports a deployment without contracts as not live, without reading', async () => {
    const { wrapper, hub, eth } = fakeBridge(fakeChain(), { deployment: NOT_LIVE })
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    expect(await loaded(result)).toMatchObject({ ok: false, status: 'not-live', problems: [{ code: 'NotLive' }] })
    expect(hub.escrowCw721).not.toHaveBeenCalled()
    expect(eth.bridgeEscrow).not.toHaveBeenCalled()
  })

  it('reports not live when an adapter says so', async () => {
    const chain = fakeChain()
    chain.fail.bridgeEscrow = new BridgeError('NotLive', 'no bridge')
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useConfigSanity(), { wrapper })
    expect(await loaded(result)).toMatchObject({ ok: false, status: 'not-live' })
  })
})

describe('useHealth', () => {
  it('measures the Hub block time for the lag', async () => {
    const chain = fakeChain({ blockSeconds: 5 })
    const { wrapper, hub } = fakeBridge(chain)
    const { result } = renderHook(() => useHealth(), { wrapper })
    const health = await loaded(result)
    expect(health).toMatchObject({ hubHeight: NOW_HEIGHT, clientHeight: CLIENT, lagBlocks: 100, frozen: false, stale: false, avgBlockSeconds: 5 })
    expect(health.lagMinutes).toBeCloseTo((100 * 5) / 60)
    expect(hub.block).toHaveBeenCalledWith(NOW_HEIGHT - 1000)
  })

  it("falls back to the deployment's block time", async () => {
    const chain = fakeChain({ blockSeconds: 5 })
    chain.fail.block = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useHealth(), { wrapper })
    expect(await loaded(result)).toMatchObject({ lagBlocks: 100, lagMinutes: 10, avgBlockSeconds: 6, stale: false })
  })

  it('is stale when Ethereum is more than 3 hours behind', async () => {
    const chain = fakeChain({ client: { latestHeight: NOW_HEIGHT - 1801, frozen: false } })
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useHealth(), { wrapper })
    expect(await loaded(result)).toMatchObject({ lagBlocks: 1801, stale: true })
  })

  it('reports a frozen client', async () => {
    const { wrapper } = fakeBridge(fakeChain({ client: { latestHeight: CLIENT, frozen: true } }))
    const { result } = renderHook(() => useHealth(), { wrapper })
    expect(await loaded(result)).toMatchObject({ frozen: true })
  })

  it('keeps the last numbers, marked stale, when the client read fails', async () => {
    const chain = fakeChain()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useHealth(), { wrapper })
    await loaded(result)
    chain.fail.client = networkError()
    chain.hubHeight += 10
    act(() => result.current.refetch())
    await waitFor(() => expect(result.current.data?.stale).toBe(true))
    expect(result.current.data).toMatchObject({ hubHeight: NOW_HEIGHT + 10, clientHeight: CLIENT, lagBlocks: 110 })
    expect(result.current.error?.code).toBe('Network')
  })

  it('fails with no data if the client was never read', async () => {
    const chain = fakeChain()
    chain.fail.client = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useHealth(), { wrapper })
    await waitFor(() => expect(result.current.error?.code).toBe('Network'))
    expect(result.current.data).toBeUndefined()
  })
})

describe('useOwnedKids', () => {
  it("lists the wallet's kids, then the ones it sent (tx search or this browser's memory)", async () => {
    const chain = everyStage()
    chain.owned.set(HUB_A, [11, 2, 10]) // a lagging node still lists #2, which has a record
    chain.records.set(7, ALICE) // sent from here moments ago, tx search hasn't caught up
    rememberTrips(LIVE_ID, [{ id: 7, height: CLIENT + 90, recipient: ALICE, sender: HUB_A, sentAt: Date.now() }])
    const { wrapper } = fakeBridge(chain, { hubWriter: fakeHubWriter(chain, HUB_A) })
    const { result } = renderHook(() => useOwnedKids(), { wrapper })
    expect(stages(await loaded(result))).toEqual([
      [10, 'home-hub'],
      [11, 'home-hub'],
      [3, 'ready'],
      [7, 'catching-up'],
      [2, 'catching-up'],
      [1, 'proving'],
      [4, 'home-eth'],
    ])
  })

  it('is idle without a Hub wallet', () => {
    const { wrapper, hub } = fakeBridge(everyStage())
    const { result } = renderHook(() => useOwnedKids(), { wrapper })
    expect(result.current).toMatchObject({ data: undefined, isLoading: false })
    expect(hub.ownedKids).not.toHaveBeenCalled()
  })

  it('still lists owned kids when tx search fails', async () => {
    const chain = everyStage()
    chain.owned.set(HUB_A, [10])
    chain.fail.sendsBy = networkError()
    const { wrapper } = fakeBridge(chain, { hubWriter: fakeHubWriter(chain, HUB_A) })
    const { result } = renderHook(() => useOwnedKids(), { wrapper })
    expect(stages(await loaded(result))).toEqual([[10, 'home-hub']])
    expect(result.current.error?.code).toBe('Network')
  })
})

describe('useSendKids', () => {
  it('seeds the cache so sent kids show at once with Hs known, and remembers them', async () => {
    const chain = everyStage()
    chain.owned.set(HUB_A, [10, 11, 12])
    const hubWriter = fakeHubWriter(chain, HUB_A, { indexed: false }) // tx search lags the send
    const { wrapper, hub } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => ({ owned: useOwnedKids(), send: useSendKids(), health: useHealth() }), { wrapper })
    await waitFor(() => expect(result.current.owned.data && result.current.health.data).toBeTruthy())
    expect(stages(result.current.owned.data)?.slice(0, 3)).toEqual([
      [10, 'home-hub'],
      [11, 'home-hub'],
      [12, 'home-hub'],
    ])

    // stall the refresh that follows the send, so only the seeded cache can explain what shows
    hub.ownedKids.mockImplementation(() => new Promise(() => undefined))
    const sent = await act(() => result.current.send.run([11, 10], ALICE))
    expect(sent).toEqual({ txHash: 'AB'.repeat(32), height: NOW_HEIGHT })
    expect(hubWriter.send).toHaveBeenCalledWith([11, 10], ALICE, { onStage: expect.any(Function) as unknown })

    // the pick screen shows them sent right away
    await waitFor(() => expect(result.current.owned.data?.find((t) => t.tokenId === 10)?.stage).toBe('catching-up'))
    const owned = result.current.owned.data ?? []
    expect(owned.find((t) => t.tokenId === 12)?.stage).toBe('home-hub')
    expect(owned.find((t) => t.tokenId === 10)).toMatchObject({ stage: 'catching-up', sendHeight: NOW_HEIGHT, blocksToGo: 101 })

    // the crossing screen mounts with data on its first render, no loading state
    const crossing = renderHook(() => ({ list: useTrips({ ids: [10, 11] }, { live: true }), one: useTrip(11) }), { wrapper })
    expect(crossing.result.current.list.data?.map((t) => [t.tokenId, t.stage, t.sendHeight])).toEqual([
      [10, 'catching-up', NOW_HEIGHT],
      [11, 'catching-up', NOW_HEIGHT],
    ])
    expect(crossing.result.current.one.data).toMatchObject({ stage: 'catching-up', recipient: ALICE, sender: HUB_A, sendTx: 'AB'.repeat(32) })

    // and a refresh keeps Hs, though tx search still can't find it
    await waitFor(() => expect(crossing.result.current.list.isFetching).toBe(false))
    expect(crossing.result.current.list.data?.every((t) => t.sendHeight === NOW_HEIGHT)).toBe(true)
    expect(hub.sendInfo).not.toHaveBeenCalledWith(10)

    expect(rememberedTrip(LIVE_ID, 10)).toMatchObject({ id: 10, height: NOW_HEIGHT, recipient: ALICE, sender: HUB_A, txHash: 'AB'.repeat(32) })
    expect(localStorage.getItem(`bad-bridge:trips:${LIVE_ID}`)).toContain('"id":11')
  })

  it('refetches owned kids after a send', async () => {
    const chain = everyStage()
    chain.owned.set(HUB_A, [10])
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper, hub } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => ({ owned: useOwnedKids(), send: useSendKids() }), { wrapper })
    await waitFor(() => expect(result.current.owned.data).toBeDefined())
    const before = hub.ownedKids.mock.calls.length
    await act(() => result.current.send.run([10], ALICE))
    await waitFor(() => expect(hub.ownedKids.mock.calls.length).toBeGreaterThan(before))
  })

  it('rejects with a BridgeError and remembers nothing when the send fails', async () => {
    const chain = everyStage()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    hubWriter.send.mockRejectedValueOnce(new BridgeError('UserRejected'))
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => useSendKids(), { wrapper })
    await act(() => expect(result.current.run([10], ALICE)).rejects.toMatchObject({ code: 'UserRejected' }))
    await waitFor(() => expect(result.current.error?.code).toBe('UserRejected'))
    expect(rememberedTrip(LIVE_ID, 10)).toBeUndefined()
  })

  it('tracks the stage while a send runs and passes each one to onStage', async () => {
    const chain = everyStage()
    chain.owned.set(HUB_A, [10])
    const hubWriter = fakeHubWriter(chain, HUB_A)
    let finish: () => void = () => undefined
    hubWriter.send.mockImplementationOnce((_ids, _recipient, options) => {
      options?.onStage?.('simulating')
      options?.onStage?.('signing')
      return new Promise((resolve) => {
        finish = () => {
          options?.onStage?.('broadcasting')
          resolve({ txHash: 'AB'.repeat(32), height: NOW_HEIGHT })
        }
      })
    })
    const heard: string[] = []
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => useSendKids({ onStage: (s) => heard.push(s) }), { wrapper })
    expect(result.current.stage).toBeNull()

    let sent: Promise<unknown> = Promise.resolve()
    act(() => {
      sent = result.current.run([10], ALICE)
    })
    await waitFor(() => expect(result.current.stage).toBe('signing'))
    expect(result.current.status).toBe('pending')
    await act(async () => {
      finish()
      await sent
    })
    expect(heard).toEqual(['simulating', 'signing', 'broadcasting'])
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.stage).toBeNull()
  })

  it('clears the stage when the send fails', async () => {
    const chain = everyStage()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    hubWriter.send.mockImplementationOnce((_ids, _recipient, options) => {
      options?.onStage?.('signing')
      return Promise.reject(new BridgeError('UserRejected'))
    })
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => useSendKids(), { wrapper })
    await act(() => expect(result.current.run([10], ALICE)).rejects.toMatchObject({ code: 'UserRejected' }))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.stage).toBeNull()
  })

  it('rejects without a Hub wallet', async () => {
    const { wrapper } = fakeBridge(everyStage())
    const { result } = renderHook(() => useSendKids(), { wrapper })
    await act(() => expect(result.current.run([10], ALICE)).rejects.toBeInstanceOf(BridgeError))
  })
})

describe('useClaimKids', () => {
  it('shows claimed kids home at once, then re-reads them to confirm', async () => {
    const chain = everyStage()
    const ethWriter = fakeEthWriter(chain, BOB) // anyone can claim; it mints to the proven recipient
    const { wrapper, eth } = fakeBridge(chain, { ethWriter })
    const { result } = renderHook(() => ({ list: useTrips({ eth: ALICE }), one: useTrip(3), claim: useClaimKids() }), { wrapper })
    await waitFor(() => expect(result.current.list.data && result.current.one.data).toBeTruthy())
    expect(result.current.one.data?.stage).toBe('ready')
    const reads = eth.kidStatus.mock.calls.length

    // stall the confirming re-read, so only the optimistic update can explain what shows
    eth.kidStatus.mockImplementation(() => new Promise(() => undefined))
    await act(() => result.current.claim.run([3]))
    expect(ethWriter.claim).toHaveBeenCalledWith([3], { onStage: expect.any(Function) as unknown })
    await waitFor(() => expect(result.current.one.data).toMatchObject({ stage: 'home-eth', owner: ALICE }))
    expect(result.current.list.data?.find((t) => t.tokenId === 3)).toMatchObject({ stage: 'home-eth', owner: ALICE })
    expect(result.current.list.data?.[0]?.stage).not.toBe('home-eth') // re-sorted: home kids go last

    // the claimed kid is re-read, even though polls skip kids that look minted
    await waitFor(() => expect(eth.kidStatus.mock.calls.length).toBeGreaterThan(reads))
    expect(eth.kidStatus.mock.calls.slice(reads).some(([ids]) => ids.includes(3))).toBe(true)
  })

  it('confirms the claim from chain', async () => {
    const chain = everyStage()
    const { wrapper } = fakeBridge(chain, { ethWriter: fakeEthWriter(chain, ALICE) })
    const { result } = renderHook(() => ({ one: useTrip(3), claim: useClaimKids() }), { wrapper })
    await waitFor(() => expect(result.current.one.data?.stage).toBe('ready'))
    await act(() => result.current.claim.run([3]))
    await waitFor(() => expect(result.current.one.isFetching).toBe(false))
    expect(result.current.one.data).toMatchObject({ stage: 'home-eth', owner: ALICE })
    expect(chain.owners.get(3)).toBe(ALICE)
  })

  it("puts a kid back to ready if the chain says the claim didn't mint it", async () => {
    const chain = everyStage()
    const ethWriter = fakeEthWriter(chain, ALICE)
    ethWriter.claim.mockResolvedValueOnce({ txHash: `0x${'ee'.repeat(32)}`, claimed: [] }) // mined, minted nothing
    const { wrapper } = fakeBridge(chain, { ethWriter })
    const { result } = renderHook(() => ({ one: useTrip(3), claim: useClaimKids() }), { wrapper })
    await waitFor(() => expect(result.current.one.data?.stage).toBe('ready'))
    await act(() => result.current.claim.run([3]))
    await waitFor(() => expect(result.current.one.data?.stage).toBe('ready'))
  })

  it('tracks the stage while a claim runs and passes each one to onStage', async () => {
    const chain = everyStage()
    const ethWriter = fakeEthWriter(chain, ALICE)
    let finish: () => void = () => undefined
    ethWriter.claim.mockImplementationOnce((ids, options) => {
      options?.onStage?.('signing')
      options?.onStage?.('confirming')
      return new Promise((resolve) => {
        finish = () => resolve({ txHash: `0x${'cd'.repeat(32)}`, claimed: [...ids] })
      })
    })
    const heard: string[] = []
    const { wrapper } = fakeBridge(chain, { ethWriter })
    const { result } = renderHook(() => useClaimKids({ onStage: (s) => heard.push(s) }), { wrapper })
    let claimed: Promise<unknown> = Promise.resolve()
    act(() => {
      claimed = result.current.run([3])
    })
    await waitFor(() => expect(result.current.stage).toBe('confirming'))
    await act(async () => {
      finish()
      await claimed
    })
    expect(heard).toEqual(['signing', 'confirming'])
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.stage).toBeNull()
  })

  it('rejects without an Ethereum wallet', async () => {
    const { wrapper } = fakeBridge(everyStage())
    const { result } = renderHook(() => useClaimKids(), { wrapper })
    await act(() => expect(result.current.run([3])).rejects.toBeInstanceOf(BridgeError))
  })
})

describe('useSendEstimate', () => {
  it('simulates the picked kids once, whatever order they were picked in', async () => {
    const chain = everyStage()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result, rerender } = renderHook(({ ids }: { ids: KidId[] }) => useSendEstimate(ids, ALICE), {
      wrapper,
      initialProps: { ids: [11, 10] },
    })
    expect(await loaded(result)).toMatchObject({ gas: 200_000, denom: 'uatom' })
    rerender({ ids: [10, 11] })
    expect(result.current.data).toBeDefined()
    expect(hubWriter.simulateSend).toHaveBeenCalledTimes(1)
    expect(hubWriter.simulateSend).toHaveBeenCalledWith([10, 11], ALICE)
  })

  it('is idle until there are kids and a recipient', () => {
    const chain = everyStage()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper } = fakeBridge(chain, { hubWriter })
    renderHook(() => [useSendEstimate([], ALICE), useSendEstimate([1], null)], { wrapper })
    expect(hubWriter.simulateSend).not.toHaveBeenCalled()
  })
})


describe('useSendKids: fresh light client check', () => {
  it.each(['clientExpired', 'clientRetired'] as const)('blocks a send when %s changes after the screen check', async (field) => {
    const chain = fakeChain()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => ({ send: useSendKids(), sanity: useConfigSanity() }), { wrapper })
    await waitFor(() => expect(result.current.sanity.data?.ok).toBe(true))
    chain[field] = true
    await act(() => expect(result.current.send.run([1], ALICE)).rejects.toMatchObject({ code: 'Unknown' }))
    expect(hubWriter.send).not.toHaveBeenCalled()
  })

  it.each(['upgrade', 'unlock', 'unreadable'] as const)('blocks a send when escrow authority is %s', async (power) => {
    const chain = fakeChain()
    if (power === 'upgrade') chain.contracts.set(LIVE.hub.escrow!, { codeId: 750, admin: HUB_A })
    if (power === 'unlock') chain.emergencyAdmin = HUB_A
    if (power === 'unreadable') chain.fail.escrowAdmin = networkError()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => useSendKids(), { wrapper })
    await act(() => expect(result.current.run([1], ALICE)).rejects.toBeInstanceOf(BridgeError))
    expect(hubWriter.send).not.toHaveBeenCalled()
  })
  it('refuses when the client froze after health was read, and never touches the wallet', async () => {
    const chain = fakeChain()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper, eth } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => ({ send: useSendKids(), health: useHealth() }), { wrapper })
    await waitFor(() => expect(result.current.health.data?.frozen).toBe(false))

    chain.client = { ...chain.client, frozen: true }
    const calls = eth.client.mock.calls.length
    await act(() => expect(result.current.send.run([1], ALICE)).rejects.toMatchObject({ code: 'ClientFrozen' }))
    expect(eth.client.mock.calls.length).toBeGreaterThan(calls)
    expect(hubWriter.send).not.toHaveBeenCalled()
    // the banner catches up without waiting for the next poll
    await waitFor(() => expect(result.current.health.data?.frozen).toBe(true))
  })

  it('refuses when the client can\'t be read, as Network, and never touches the wallet', async () => {
    const chain = fakeChain()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => useSendKids(), { wrapper })
    chain.fail.client = networkError()
    await act(() => expect(result.current.run([1], ALICE)).rejects.toMatchObject({ code: 'Network' }))
    expect(hubWriter.send).not.toHaveBeenCalled()
  })

  it('sends when the client is live', async () => {
    const chain = fakeChain()
    const hubWriter = fakeHubWriter(chain, HUB_A)
    const { wrapper } = fakeBridge(chain, { hubWriter })
    const { result } = renderHook(() => useSendKids(), { wrapper })
    await act(() => expect(result.current.run([1], ALICE)).resolves.toMatchObject({ height: NOW_HEIGHT }))
    expect(hubWriter.send).toHaveBeenCalledTimes(1)
  })
})

describe('useTrustFacts', () => {
  const REECE = 'cosmos1reece3m8g4m3d0qrpj93rnnseudnpzhrey64rr'

  it('reads the escrow and collection admins and whether the router is upgradeable', async () => {
    const chain = fakeChain()
    chain.contracts.set(LIVE.hub.escrow ?? '', { codeId: 750, admin: REECE })
    chain.contracts.set(LIVE.hub.cw721, { codeId: 431, admin: null })
    chain.proxies.set(LIVE.eth.router.toLowerCase(), BOB)
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrustFacts(), { wrapper })
    expect(await loaded(result)).toEqual({
      escrow: { codeId: 750, admin: REECE },
      collection: { codeId: 431, admin: null },
      routerUpgradeable: true,
      emergencyAdmin: null,
    })
    expect(result.current.error).toBeNull()
  })

  it('leaves a fact it couldn\'t read undefined, and says why', async () => {
    const chain = fakeChain()
    chain.contracts.set(LIVE.hub.escrow ?? '', { codeId: 750, admin: null })
    chain.fail.proxyImplementation = networkError()
    const { wrapper } = fakeBridge(chain)
    const { result } = renderHook(() => useTrustFacts(), { wrapper })
    // the cw721 isn't in the fake chain, so its read fails too
    expect(await loaded(result)).toEqual({ escrow: { codeId: 750, admin: null }, collection: undefined, routerUpgradeable: undefined, emergencyAdmin: null })
    expect(result.current.error).not.toBeNull()
  })

  it('has no escrow or router facts before the bridge is live', async () => {
    const chain = fakeChain()
    chain.contracts.set(NOT_LIVE.hub.cw721, { codeId: 434, admin: 'cosmos1s8qx0zvz8yd6e4x0mqmqf7fr9vvfn6226hkvrq' })
    const { wrapper, eth } = fakeBridge(chain, { deployment: NOT_LIVE })
    const { result } = renderHook(() => useTrustFacts(), { wrapper })
    expect(await loaded(result)).toEqual({
      escrow: null,
      collection: { codeId: 434, admin: 'cosmos1s8qx0zvz8yd6e4x0mqmqf7fr9vvfn6226hkvrq' },
      routerUpgradeable: null,
      emergencyAdmin: null,
    })
    expect(eth.proxyImplementation).not.toHaveBeenCalled()
  })
})

describe('useClaimEstimate', () => {
  it('prices exactly the kids asked for, and one typical kid for an empty list', async () => {
    const chain = fakeChain({ gasPrice: 2_000_000_000n })
    chain.proven.set(3, ALICE).set(5, ALICE)
    const { wrapper, eth } = fakeBridge(chain)
    const { result } = renderHook(() => ({ two: useClaimEstimate([5, 3]), none: useClaimEstimate([]) }), { wrapper })
    expect(await loaded({ get current() { return result.current.two } })).toEqual({ gas: 109_000, gasPrice: '2000000000', fee: '218000000000000', simulated: true })
    expect(await loaded({ get current() { return result.current.none } })).toMatchObject({ gas: 79_000, fee: '158000000000000' })
    expect(eth.estimateClaim).toHaveBeenCalledWith([3, 5])
    expect(eth.estimateClaim).toHaveBeenCalledWith([])
  })

  it('stays idle before the bridge is live', () => {
    const { wrapper, eth } = fakeBridge(fakeChain(), { deployment: NOT_LIVE })
    const { result } = renderHook(() => useClaimEstimate([1]), { wrapper })
    expect(result.current.data).toBeUndefined()
    expect(eth.estimateClaim).not.toHaveBeenCalled()
  })
})
