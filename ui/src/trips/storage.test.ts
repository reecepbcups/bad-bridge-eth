import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rememberedDetails,
  rememberedTrip,
  rememberedTrips,
  rememberTrips,
  resetTripStorage,
  subscribeRemembered,
} from './storage'
import { breakLocalStorage } from './fakes'

const ALICE = '0x00000000000000000000000000000000000A11CE'
const HASH = 'ab'.repeat(32)
const T0 = Date.parse('2026-09-27T17:00:00Z')

beforeEach(() => {
  localStorage.clear()
  resetTripStorage()
})

afterEach(() => {
  localStorage.clear()
  resetTripStorage()
})

describe('remembered trips', () => {
  it('stores send details and reads them back after a reload', () => {
    rememberTrips('demo', [{ id: 7, txHash: HASH, height: 100, recipient: ALICE, sender: 'cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl', sentAt: T0 }])
    resetTripStorage() // a reload: only localStorage survives
    expect(rememberedTrips('demo')).toEqual([7])
    expect(rememberedTrip('demo', 7)).toEqual({
      id: 7,
      txHash: HASH.toUpperCase(),
      height: 100,
      recipient: ALICE,
      sender: 'cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl',
      sentAt: T0,
    })
  })

  it('keeps one entry per kid, oldest first, merging new facts in', () => {
    rememberTrips('demo', [3, 1])
    rememberTrips('demo', [{ id: 3, height: 50 }, 2])
    expect(rememberedTrips('demo')).toEqual([3, 1, 2])
    expect(rememberedTrip('demo', 3)).toEqual({ id: 3, height: 50 })
  })

  it('returns the same array until something changes', () => {
    rememberTrips('demo', [1])
    const first = rememberedTrips('demo')
    rememberTrips('demo', [1])
    expect(rememberedTrips('demo')).toBe(first)
    rememberTrips('demo', [2])
    expect(rememberedTrips('demo')).not.toBe(first)
  })

  it('keeps deployments apart', () => {
    rememberTrips('demo', [1])
    rememberTrips('reece-test', [2])
    expect(rememberedTrips('demo')).toEqual([1])
    expect(rememberedTrips('reece-test')).toEqual([2])
  })

  it('reads Phase 0 bare ids and drops junk', () => {
    localStorage.setItem(
      'bad-bridge:trips:demo',
      JSON.stringify([5, -1, 1.5, 'x', null, { id: 6, height: -3, txHash: 'nope', recipient: '0x12', sentAt: 'soon' }, { id: 2 ** 32 }]),
    )
    expect(rememberedDetails('demo')).toEqual([{ id: 5 }, { id: 6 }])
  })

  it('survives unparseable storage', () => {
    localStorage.setItem('bad-bridge:trips:demo', '{not json')
    expect(rememberedTrips('demo')).toEqual([])
    localStorage.setItem('bad-bridge:trips:reece-test', '{"id":1}')
    expect(rememberedTrips('reece-test')).toEqual([])
  })

  it('caps how much it keeps', () => {
    rememberTrips('demo', Array.from({ length: 600 }, (_, i) => i))
    const ids = rememberedTrips('demo')
    expect(ids).toHaveLength(500)
    expect(ids[0]).toBe(100)
  })

  it('notifies subscribers, including for writes from another tab', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRemembered(listener)
    rememberTrips('demo', [1])
    expect(listener).toHaveBeenCalledTimes(1)

    localStorage.setItem('bad-bridge:trips:demo', JSON.stringify([1, 9]))
    window.dispatchEvent(new StorageEvent('storage', { key: 'bad-bridge:trips:demo' }))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(rememberedTrips('demo')).toEqual([1, 9])

    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('works for this tab when localStorage throws on every call', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(rememberedTrips('demo')).toEqual([])
    expect(() => rememberTrips('demo', [4])).not.toThrow()
    expect(rememberedTrips('demo')).toEqual([4])
    rememberTrips('demo', [5])
    expect(rememberedTrips('demo')).toEqual([4, 5])
  })

  it('merges unsaved trips when reads work but writes fail', () => {
    localStorage.setItem('bad-bridge:trips:demo', JSON.stringify([1]))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    rememberTrips('demo', [2])
    rememberTrips('demo', [3])
    expect(rememberedTrips('demo')).toEqual([1, 2, 3])
  })

  it('works for this tab when window.localStorage itself throws', () => {
    const restore = breakLocalStorage()
    try {
      expect(() => rememberTrips('demo', [{ id: 4, height: 10 }])).not.toThrow()
      expect(rememberedTrip('demo', 4)).toEqual({ id: 4, height: 10 })
    } finally {
      restore()
    }
  })
})
