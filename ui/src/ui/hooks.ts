// Small UI-only hooks. Chain reads go through useBridge(); trip state comes from src/trips/hooks.ts.

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useBridge } from '../chain/context'
import { toBridgeError, type EthAddress, type KidId } from '../chain/types'
import type { QueryState } from '../trips/types'

/** eth.isContract(address): drives the "that's a contract" warning on the review screen. Idle for null. */
export function useIsContract(address: EthAddress | null): QueryState<boolean> {
  const { deployment, eth } = useBridge()
  const q = useQuery({
    queryKey: ['bridge', deployment.id, 'ui', 'is-contract', address?.toLowerCase()],
    enabled: address !== null,
    staleTime: 5 * 60_000,
    queryFn: () => (address ? eth.isContract(address) : Promise.resolve(false)),
  })
  return {
    data: q.data,
    error: q.error ? toBridgeError(q.error) : null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    refetch: () => void q.refetch(),
  }
}

/** eth.claimTx(id): the mint tx for the kid page's Etherscan link. Idle until `minted`, or when the reader can't look it up. */
export function useClaimTx(id: KidId, minted: boolean): QueryState<string | null> {
  const { deployment, eth } = useBridge()
  const q = useQuery({
    queryKey: ['bridge', deployment.id, 'ui', 'claim-tx', id],
    enabled: minted && eth.claimTx !== undefined,
    // a mint tx never changes; retry later only while Blockscout hasn't indexed it
    staleTime: Infinity,
    queryFn: () => (eth.claimTx ? eth.claimTx(id) : Promise.resolve(null)),
  })
  return {
    data: q.data,
    error: q.error ? toBridgeError(q.error) : null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    refetch: () => void q.refetch(),
  }
}

/**
 * "Now" on the Hub: the latest block's time. Chain-relative copy ("sent 22 min ago") uses it, so it agrees
 * with the chain even when the viewer's clock is off. undefined until the first read.
 */
export function useHubNow(): Date | undefined {
  const { deployment, hub } = useBridge()
  const q = useQuery({
    queryKey: ['bridge', deployment.id, 'ui', 'hub-now'],
    refetchInterval: 30_000,
    queryFn: async () => (await hub.latestBlock()).time,
  })
  return q.data
}

// ---- prefers-reduced-motion ----

const REDUCE = '(prefers-reduced-motion: reduce)'

function subscribeMotion(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCE)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

const getReduced = () => window.matchMedia(REDUCE).matches

/** True when the OS asks for less motion: no walking, no bobbing, no wiggles. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, getReduced, () => false)
}

// ---- a slow wall clock, for "checked 2 min ago" ----

let clockNow = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | undefined

function subscribeClock(onChange: () => void): () => void {
  clockListeners.add(onChange)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const l of clockListeners) l()
    }, 15_000)
  }
  return () => {
    clockListeners.delete(onChange)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}

const getClock = () => clockNow

/** Wall-clock ms, updated every 15 seconds. */
export function useWallClock(): number {
  return useSyncExternalStore(subscribeClock, getClock, getClock)
}

/** Wall-clock ms when `value` last changed (by identity), or null before it has one. */
export function useChangedAt(value: unknown): number | null {
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => {
    if (value === undefined) return
    // in a callback, not the effect body, so it doesn't cascade a render
    const t = setTimeout(() => setAt(Date.now()), 0)
    return () => clearTimeout(t)
  }, [value])
  return at
}

// ---- focus ----

/**
 * Moves focus to the current view's h2 when `key` changes (a route or a bridge step), so screen readers
 * and keyboards land on the new content. Not on first render: page load keeps the browser's own focus.
 */
export function useFocusHeadingOnChange(key: string): void {
  const previous = useRef<string | null>(null)
  useEffect(() => {
    const before = previous.current
    previous.current = key
    if (before === null || before === key) return
    const h2 = document.querySelector<HTMLElement>('#main h2')
    if (!h2) return
    if (!h2.hasAttribute('tabindex')) h2.setAttribute('tabindex', '-1')
    h2.focus({ preventScroll: true })
    if (h2.getBoundingClientRect().top < 0) h2.scrollIntoView({ block: 'start' })
  }, [key])
}

/**
 * Focuses `target` once `done` turns true after `armed` was seen, if focus was lost to <body> meanwhile: the
 * button that had it went away (a Claim button, once its kid is home). Focus somewhere else is left alone.
 */
export function useFocusWhenDone(armed: boolean, done: boolean, target: RefObject<HTMLElement | null>): void {
  const wasArmed = useRef(false)
  useEffect(() => {
    if (armed) wasArmed.current = true
  }, [armed])
  useEffect(() => {
    if (!done || !wasArmed.current) return
    wasArmed.current = false
    const active = document.activeElement
    if (active && active !== document.body) return
    target.current?.focus()
  }, [done, target])
}

// ---- clipboard ----

/** Copies text; `copied` flips on for a couple of seconds. Resolves false when the clipboard isn't available. */
export function useCopy(): { copy: (text: string) => Promise<boolean>; copied: boolean } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(t)
  }, [copied])
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      return true
    } catch {
      return false
    }
  }, [])
  return { copy, copied }
}
