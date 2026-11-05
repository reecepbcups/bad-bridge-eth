import { describe, expect, it } from 'vitest'
import { deriveStage } from '../../trips/derive'
import type { Stage } from '../../trips/types'
import { BridgeError } from '../types'
import { DEMO_ETH, DEMO_HUB } from './seed'
import { DemoSim, INSTANT } from './sim'

const stageOf = (sim: DemoSim, id: number): Stage =>
  deriveStage({
    record: sim.record(id),
    sendHeight: sim.sendInfo(id)?.height ?? null,
    client: sim.client(),
    eth: sim.kidStatus([id]).get(id) ?? null,
  })

const newSim = () => new DemoSim({ paused: true, timeline: INSTANT })

describe('DemoSim', () => {
  it('walks a send through every stage', () => {
    const sim = newSim()
    expect(stageOf(sim, 9176)).toBe('home-hub')

    const { height } = sim.commitSend(DEMO_HUB, [9176, 6413], DEMO_ETH)
    expect(height).toBe(sim.hubHeight)
    expect(sim.ownedKids(DEMO_HUB)).not.toContain(9176)
    expect(stageOf(sim, 9176)).toBe('catching-up')

    expect(sim.skip()).toBe(true) // relay: client passes Hs
    expect(sim.client().latestHeight).toBeGreaterThan(height)
    expect(stageOf(sim, 9176)).toBe('proving')

    expect(sim.skip()).toBe(false) // nobody proves it but you
    expect(sim.prove([9176, 6413])).toEqual([9176, 6413])
    expect(stageOf(sim, 9176)).toBe('ready')

    sim.claim([9176, 6413])
    expect(stageOf(sim, 9176)).toBe('home-eth')
    expect(sim.kidStatus([6413]).get(6413)?.owner).toBe(DEMO_ETH)
  })

  it('never proves on its own, and holds relays and proofs while frozen', () => {
    const sim = newSim()
    sim.commitSend(DEMO_HUB, [9176], DEMO_ETH)
    expect(() => sim.prove([9176])).toThrow(/nothing to prove/)
    sim.setFrozen(true)
    expect(sim.skip()).toBe(false)
    sim.setFrozen(false)
    sim.skip()
    sim.advance(60 * 60_000)
    expect(stageOf(sim, 9176)).toBe('proving')
    sim.setFrozen(true)
    expect(() => sim.prove([9176])).toThrow(expect.objectContaining({ code: 'ClientFrozen' }) as Error)
  })

  it('rejects sends the escrow would reject', () => {
    const sim = newSim()
    expect(() => sim.simulateSend(DEMO_HUB, [9176], `0x${'0'.repeat(40)}`)).toThrow(BridgeError)
    expect(() => sim.simulateSend(DEMO_HUB, [8073], DEMO_ETH)).toThrow(/AlreadyBridged/)
    expect(() => sim.claim([9176])).toThrow(/NotProven/)
  })

  it('injects a failure once, only where it can happen', () => {
    const sim = newSim()
    sim.setFailNext('UserRejected')
    expect(() => sim.simulateSend(DEMO_HUB, [9176], DEMO_ETH)).not.toThrow() // wallets reject at signing, not simulation
    expect(() => sim.commitSend(DEMO_HUB, [9176], DEMO_ETH)).toThrow(expect.objectContaining({ code: 'UserRejected' }) as Error)
    expect(sim.getSnapshot().failNext).toBeNull()
    expect(() => sim.commitSend(DEMO_HUB, [9176], DEMO_ETH)).not.toThrow()
  })
})
