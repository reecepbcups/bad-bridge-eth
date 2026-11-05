import type { Stage, Trip } from '../trips/types'

// Copy and progress numbers for each trip stage. The stage itself always comes from chain (trips/derive.ts).
// Every place a trip's progress shows uses one four-step journey: Sent → Ethereum caught up → Proven → Claimed.

/** Pill class and text for list rows. */
export const STAGE_PILL: Readonly<Record<Stage, { className: string; label: string }>> = {
  'home-hub': { className: 'pill', label: 'on the Hub' },
  locked: { className: 'pill crossing', label: 'crossing' },
  'catching-up': { className: 'pill crossing', label: 'crossing' },
  proving: { className: 'pill crossing', label: 'crossing' },
  crossing: { className: 'pill crossing', label: 'crossing' },
  ready: { className: 'pill ready', label: 'ready to claim' },
  'home-eth': { className: 'pill home', label: 'home on Ethereum' },
}

// COPY: journey steps and stage lines
/** The four steps, as the stage list titles them. The track bar uses the same words, shortened only at the end. */
export const JOURNEY = ['Sent', 'Ethereum caught up', 'Proven', 'Claimed on Ethereum'] as const
export const TRACK_LABELS = ['Sent', 'Ethereum caught up', 'Proven', 'Claimed'] as const

/** One line on where the kid is, in the journey's words: list rows, the crossing scene, the crossing screen's status. */
export const STAGE_LINE: Readonly<Record<Stage, string>> = {
  'home-hub': 'Still on the Hub',
  locked: 'Sent, in the Hub escrow',
  'catching-up': 'Waiting for Ethereum to catch up',
  crossing: 'On the bridge',
  proving: 'Ethereum caught up, waiting for you to prove it',
  ready: 'Proven, ready to claim',
  'home-eth': 'Home on Ethereum',
}

/** How far along the journey a stage is. Used to find the slowest kid in a group and to place walkers. */
export const STAGE_PROGRESS: Readonly<Record<Stage, number>> = {
  'home-hub': 0,
  locked: 1,
  'catching-up': 2,
  crossing: 2.5,
  proving: 3,
  ready: 4,
  'home-eth': 5,
}

/** Still on the bridge: sent, not yet proven. */
export function inFlight(stage: Stage): boolean {
  return stage === 'locked' || stage === 'catching-up' || stage === 'crossing' || stage === 'proving'
}

/** The least advanced stage in a group of trips (the group moves at its slowest kid's pace). */
export function slowestStage(trips: readonly Trip[]): Stage | null {
  let slowest: Stage | null = null
  for (const t of trips) if (slowest === null || STAGE_PROGRESS[t.stage] < STAGE_PROGRESS[slowest]) slowest = t.stage
  return slowest
}

/**
 * The journey step a stage is on, for the stage list and the track bar alike: steps before it are done, it's the
 * current one, and 4 means all four are done. `crossing` (send height unknown) is somewhere in steps 1–2.
 */
export const JOURNEY_AT: Readonly<Record<Stage, number>> = {
  'home-hub': 0,
  locked: 1,
  'catching-up': 1,
  crossing: 1,
  proving: 2,
  ready: 3,
  'home-eth': 4,
}

/** "Waiting for Ethereum…" → "waiting for Ethereum…", for a stage line mid-sentence. */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
