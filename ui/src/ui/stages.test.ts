import { describe, expect, it } from 'vitest'
import type { Stage } from '../trips/types'
import { JOURNEY, JOURNEY_AT, lowerFirst, STAGE_LINE, TRACK_LABELS } from './stages'

const STAGES: readonly Stage[] = ['home-hub', 'locked', 'catching-up', 'crossing', 'proving', 'ready', 'home-eth']

describe('one journey vocabulary', () => {
  it('names the same four steps in the stage list and the track bar', () => {
    expect(JOURNEY).toEqual(['Sent', 'Ethereum caught up', 'Proven', 'Claimed on Ethereum'])
    expect(TRACK_LABELS).toHaveLength(JOURNEY.length)
    TRACK_LABELS.forEach((label, i) => expect(JOURNEY[i]).toContain(label))
  })

  it.each<[Stage, number]>([
    ['home-hub', 0],
    ['locked', 1],
    ['catching-up', 1],
    ['crossing', 1],
    ['proving', 2],
    ['ready', 3],
    ['home-eth', 4],
  ])('%s is on step %i', (stage, step) => {
    expect(JOURNEY_AT[stage]).toBe(step)
  })

  it('has a line for every stage, without the old jargon', () => {
    for (const stage of STAGES) {
      expect(STAGE_LINE[stage].length).toBeGreaterThan(3)
      expect(STAGE_LINE[stage]).not.toMatch(/batcher|send_nft|Eureka|Seen\b/)
    }
    expect(lowerFirst(STAGE_LINE['catching-up'])).toBe('waiting for Ethereum to catch up')
  })
})
