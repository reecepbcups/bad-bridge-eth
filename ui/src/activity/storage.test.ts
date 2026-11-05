import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { breakLocalStorage } from '../trips/fakes'
import { activityLog, MAX_ACTIVITY, parseActivity, recordActivity, resetActivityStorage, subscribeActivity } from './storage'

const HUB_HASH = 'ab'.repeat(32)
const ETH_HASH = `0x${'CD'.repeat(32)}`
const KEY = 'bad-bridge:activity:demo'
const T0 = Date.parse('2026-09-27T17:00:00Z')

beforeEach(() => {
  localStorage.clear()
  resetActivityStorage()
})

afterEach(() => {
  localStorage.clear()
  resetActivityStorage()
})

describe('parseActivity', () => {
  it.each([
    ['a Hub send, hash uppercased', { action: 'send', at: T0, hash: HUB_HASH, kids: [1, 2] }, { action: 'send', at: T0, hash: HUB_HASH.toUpperCase(), kids: [1, 2] }],
    ['an Eth claim, hash lowercased', { action: 'claim', at: T0, hash: ETH_HASH }, { action: 'claim', at: T0, hash: ETH_HASH.toLowerCase() }],
    ['a signature with no request id', { action: 'sign-prove-permit', at: T0 }, { action: 'sign-prove-permit', at: T0 }],
    ['a signature with a request id', { action: 'sign-proof-request', at: T0, requestId: ETH_HASH }, { action: 'sign-proof-request', at: T0, requestId: ETH_HASH.toLowerCase() }],
    ['bad and duplicate kids dropped', { action: 'claim', at: T0, hash: ETH_HASH, kids: [3, 3, -1, 1.5, 'x', 2 ** 32] }, { action: 'claim', at: T0, hash: ETH_HASH.toLowerCase(), kids: [3] }],
    ['an Eth hash on a Hub action', { action: 'send', at: T0, hash: ETH_HASH }, null],
    ['a Hub hash on an Eth action', { action: 'claim', at: T0, hash: HUB_HASH }, null],
    ['a tx with no hash', { action: 'nudge', at: T0 }, null],
    ['an unknown action', { action: 'drain', at: T0, hash: HUB_HASH }, null],
    ['an inherited key as action', { action: 'toString', at: T0 }, null],
    ['no time', { action: 'sign-prove-permit' }, null],
    ['a negative time', { action: 'sign-prove-permit', at: -1 }, null],
    ['not an object', 'send', null],
    ['null', null, null],
  ])('%s', (_name, raw, want) => {
    expect(parseActivity(raw)).toEqual(want)
  })

  it('caps kids at 50', () => {
    const kids = Array.from({ length: 80 }, (_, i) => i)
    expect(parseActivity({ action: 'send', at: T0, hash: HUB_HASH, kids })?.kids).toHaveLength(50)
  })
})

describe('activity log', () => {
  it('stores entries and reads them back after a reload, oldest first', () => {
    recordActivity('demo', { action: 'claim', hash: ETH_HASH, kids: [7], at: T0 + 1 })
    recordActivity('demo', { action: 'send', hash: HUB_HASH, kids: [7], at: T0 })
    resetActivityStorage()
    expect(activityLog('demo').map((a) => a.action)).toEqual(['send', 'claim'])
  })

  it('stamps entries with the current time by default', () => {
    vi.useFakeTimers({ now: T0 })
    try {
      recordActivity('demo', { action: 'sign-prove-permit' })
      expect(activityLog('demo')).toEqual([{ action: 'sign-prove-permit', at: T0 }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one entry per tx hash, merging fields', () => {
    recordActivity('demo', { action: 'send', hash: HUB_HASH, at: T0 })
    recordActivity('demo', { action: 'send', hash: HUB_HASH, kids: [4], at: T0 })
    expect(activityLog('demo')).toEqual([{ action: 'send', hash: HUB_HASH.toUpperCase(), kids: [4], at: T0 }])
  })

  it('ignores invalid entries', () => {
    recordActivity('demo', { action: 'claim', hash: 'nope' })
    expect(activityLog('demo')).toEqual([])
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it(`keeps only the newest ${MAX_ACTIVITY}`, () => {
    for (let i = 0; i < MAX_ACTIVITY + 5; i++) recordActivity('demo', { action: 'sign-prove-permit', at: T0 + i })
    const log = activityLog('demo')
    expect(log).toHaveLength(MAX_ACTIVITY)
    expect(log[0]?.at).toBe(T0 + 5)
    expect((JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown[]).length).toBe(MAX_ACTIVITY)
  })

  it('drops garbage from storage and keeps the valid entries', () => {
    localStorage.setItem(KEY, JSON.stringify([{ action: 'send', at: T0, hash: HUB_HASH }, { action: 'evil' }, 42, null]))
    expect(activityLog('demo')).toEqual([{ action: 'send', at: T0, hash: HUB_HASH.toUpperCase() }])
    localStorage.setItem('bad-bridge:activity:reece-test', '{not json')
    expect(activityLog('reece-test')).toEqual([])
  })

  it('returns the same array until something changes', () => {
    recordActivity('demo', { action: 'sign-prove-permit', at: T0 })
    const first = activityLog('demo')
    expect(activityLog('demo')).toBe(first)
    recordActivity('demo', { action: 'sign-prove-permit', at: T0 + 1 })
    expect(activityLog('demo')).not.toBe(first)
  })

  it('keeps deployments apart', () => {
    recordActivity('demo', { action: 'send', hash: HUB_HASH, at: T0 })
    expect(activityLog('reece-test')).toEqual([])
  })

  it("merges another tab's write instead of clobbering it", () => {
    recordActivity('demo', { action: 'send', hash: HUB_HASH, at: T0 })
    // another tab appended while this one wasn't listening
    const other = [...(JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown[]), { action: 'claim', hash: ETH_HASH, at: T0 + 1 }]
    localStorage.setItem(KEY, JSON.stringify(other))
    recordActivity('demo', { action: 'sign-prove-permit', at: T0 + 2 })
    expect(activityLog('demo').map((a) => a.action)).toEqual(['send', 'claim', 'sign-prove-permit'])
  })

  it('reloads and notifies on a storage event from another tab', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeActivity(listener)
    activityLog('demo')
    localStorage.setItem(KEY, JSON.stringify([{ action: 'sign-prove-permit', at: T0 }]))
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(activityLog('demo')).toHaveLength(1)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('still works for this tab when storage throws', () => {
    const undo = breakLocalStorage()
    try {
      expect(() => recordActivity('demo', { action: 'send', hash: HUB_HASH, at: T0 })).not.toThrow()
      expect(activityLog('demo')).toHaveLength(1)
    } finally {
      undo()
    }
  })
})
