import { createContext, useContext } from 'react'
import type { BridgeErrorCode } from '../types'
import type { DemoChain, DemoSnapshot } from './sim'

/** Knobs for design review and e2e. Only exists under DemoBridgeProvider. */
export interface DemoControls {
  /** Current sim state: clock, heights, toggles, wallets. */
  snapshot: DemoSnapshot
  /** Jump to the next relay for a sent kid. False if nothing can happen. */
  skip(): boolean
  /** Move the virtual clock forward. */
  advance(ms: number): void
  /** Stop or start the virtual clock. */
  setPaused(on: boolean): void
  /** Freeze the light client: no relays or proofs, sends should be disabled, claims still work. */
  setFrozen(on: boolean): void
  /** Fail every read with Network. */
  setOffline(on: boolean): void
  /** Make the next write that can fail with `code` fail with it, once. null clears it. */
  setFailNext(code: BridgeErrorCode | null): void
  /** Connect or disconnect a wallet instantly, skipping the prompt. */
  setWallet(chain: DemoChain, connected: boolean): void
  /** Put the Ethereum wallet on another network: wrongChain shows, claims fail with WrongChain. */
  setWrongChain(on: boolean): void
  /** Back to the seeded state. */
  reset(): void
}

export const DemoControlsContext = createContext<DemoControls | null>(null)

/** The demo knobs, or null outside demo mode. */
export function useDemoControls(): DemoControls | null {
  return useContext(DemoControlsContext)
}
