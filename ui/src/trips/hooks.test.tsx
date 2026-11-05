import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useBridge } from '../chain/context'
import { useDemoControls } from '../chain/demo/controls'
import { DEMO_ETH, DEMO_HUB } from '../chain/demo/seed'
import { demoWrapper } from '../test/demo'
import { useClaimKids, useConfigSanity, useHealth, useOwnedKids, useSendKids, useTrips } from './hooks'
import { resetTripStorage } from './storage'

// The pattern for hook tests: renderHook over demoWrapper(), then waitFor the query to settle.
// hooks.fake.test.tsx covers failures and edge cases over a hand-rolled chain.

beforeEach(() => {
  localStorage.clear()
  resetTripStorage()
})

describe('trip hooks over the demo adapter', () => {
  it('finds the mockup trips by Ethereum address, ready first', async () => {
    const { result } = renderHook(() => useTrips({ eth: DEMO_ETH }), { wrapper: demoWrapper() })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.map((t) => [t.tokenId, t.stage])).toEqual([
      [9254, 'ready'],
      [8783, 'proving'],
      [8073, 'home-eth'],
    ])
  })

  it("lists the Hub wallet's kids, still-home ones first", async () => {
    const { result } = renderHook(() => useOwnedKids(), { wrapper: demoWrapper() })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const trips = result.current.data ?? []
    expect(trips.map((t) => t.tokenId)).toEqual([663, 3838, 4801, 6413, 9176, 8073])
    expect(trips.at(-1)).toMatchObject({ stage: 'home-eth', sender: DEMO_HUB })
  })

  it('reports health and passes the config sanity check', async () => {
    const { result } = renderHook(() => ({ health: useHealth(), sanity: useConfigSanity() }), { wrapper: demoWrapper() })
    await waitFor(() => expect(result.current.sanity.data).toBeDefined())
    await waitFor(() => expect(result.current.health.data).toBeDefined())
    expect(result.current.sanity.data).toEqual({ ok: true, status: 'ok', problems: [] })
    expect(result.current.health.data).toMatchObject({ lagBlocks: 100, lagMinutes: 10, frozen: false, stale: false })
  })

  it('walks a send through every stage to home', async () => {
    const { result } = renderHook(
      () => ({ send: useSendKids(), claim: useClaimKids(), trips: useTrips({ ids: [9176] }, { live: true }), controls: useDemoControls(), bridge: useBridge() }),
      { wrapper: demoWrapper() },
    )
    const stage = () => result.current.trips.data?.[0]?.stage
    await waitFor(() => expect(stage()).toBe('home-hub'))

    await act(() => result.current.send.run([9176], DEMO_ETH))
    await waitFor(() => expect(stage()).toBe('catching-up'))
    expect(result.current.trips.data?.[0]).toMatchObject({ recipient: DEMO_ETH, sender: DEMO_HUB })

    act(() => void result.current.controls?.skip()) // relay: the client passes Hs
    await waitFor(() => expect(stage()).toBe('proving'))

    await act(() => result.current.bridge.proveKid!.proveKids([9176])) // "Prove it"
    await waitFor(() => expect(stage()).toBe('ready'))

    await act(() => result.current.claim.run([9176]))
    await waitFor(() => expect(result.current.trips.data?.[0]).toMatchObject({ stage: 'home-eth', owner: DEMO_ETH }))
  })
})
