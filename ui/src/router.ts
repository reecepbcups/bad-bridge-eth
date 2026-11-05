import { useMemo, useSyncExternalStore } from 'react'
import type { KidId } from './chain/types'

// Hash routing, so dist/ works on any static host or IPFS gateway without rewrites.
// #/  #/crossing  #/crossing/<0x…|cosmos1…>  #/kids  #/kids/<0x…|cosmos1…>  #/kid/<id>  #/about  #/activity

export type Route =
  | { name: 'bridge' }
  /** kids still on the bridge; `address` is whatever was in the URL, unvalidated */
  | { name: 'crossing'; address?: string }
  /** kids home on Ethereum; `address` as above */
  | { name: 'kids'; address?: string }
  | { name: 'kid'; id: KidId }
  | { name: 'about' }
  /** what this browser signed */
  | { name: 'activity' }
  | { name: 'not-found'; path: string }

export type RouteName = Route['name']

/** Canonical u32 decimal only, the same rule the escrow enforces ("07" and "+7" are not 7). */
function parseKidId(s: string): KidId | null {
  if (!/^(0|[1-9]\d{0,9})$/.test(s)) return null
  const n = Number(s)
  return n <= 0xffff_ffff ? n : null
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/[?].*$/, '')
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
  const [head, arg, ...rest] = parts
  if (rest.length === 0) {
    if (head === undefined) return { name: 'bridge' }
    if (head === 'about' && arg === undefined) return { name: 'about' }
    if (head === 'activity' && arg === undefined) return { name: 'activity' }
    if (head === 'crossing') return arg === undefined ? { name: 'crossing' } : { name: 'crossing', address: arg.trim() }
    if (head === 'kids') return arg === undefined ? { name: 'kids' } : { name: 'kids', address: arg.trim() }
    if (head === 'kid' && arg !== undefined) {
      const id = parseKidId(arg)
      if (id !== null) return { name: 'kid', id }
    }
  }
  return { name: 'not-found', path: path || '/' }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'bridge':
      return '#/'
    case 'crossing':
      return route.address ? `#/crossing/${encodeURIComponent(route.address)}` : '#/crossing'
    case 'kids':
      return route.address ? `#/kids/${encodeURIComponent(route.address)}` : '#/kids'
    case 'kid':
      return `#/kid/${route.id}`
    case 'about':
      return '#/about'
    case 'activity':
      return '#/activity'
    case 'not-found':
      return `#${route.path}`
  }
}

export function navigate(route: Route): void {
  location.hash = href(route)
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

const getHash = () => location.hash

/** The current route. Re-renders on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '')
  return useMemo(() => parseHash(hash), [hash])
}
