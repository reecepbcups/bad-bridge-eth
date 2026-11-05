import type { ReactNode } from 'react'
import { useBridge } from '../chain/context'
import type { Health, Stage } from '../trips/types'
import { ExtLink } from './ExtLink'
import { aboutMinutes, blocks, shortHash } from './format'
import { JOURNEY, JOURNEY_AT, TRACK_LABELS } from './stages'

/** What the stage list needs to know about a trip (or a group of kids sent in one tx). */
export interface StageFacts {
  stage: Stage
  sendTx?: string
  blocksToGo?: number
}

// COPY: step 2 title while the client is behind
const OUT_OF_SYNC = 'Ethereum out of sync'
// COPY: step 3 title while it waits for someone to prove it
const PROVING = 'Prove it'

/**
 * The four-step journey, with live details on the current step. `showLag` is off where the page already says
 * how far behind Ethereum is.
 */
export function StageList({
  facts,
  health,
  showLag = true,
  speedUp,
}: {
  facts: StageFacts
  health: Health | undefined
  showLag?: boolean
  /** Shown under the "Ethereum caught up" step while it's the current one. */
  speedUp?: ReactNode
}) {
  const { deployment } = useBridge()
  const at = JOURNEY_AT[facts.stage]
  // Hs unknown: it's somewhere in steps 2–3 and we don't guess which
  const current = facts.stage === 'crossing' ? [1, 2] : [at]
  // stale numbers (a failed read, or hours behind) aren't worth quoting
  const lag =
    showLag && health && !health.stale && health.lagBlocks > 0 ? `Ethereum is ${aboutMinutes(health.lagMinutes)} behind the Hub.` : null

  // COPY: stage list details
  const items: { detail: ReactNode; live?: ReactNode }[] = [
    {
      detail: facts.sendTx ? (
        <>
          Locked in the Hub escrow ·{' '}
          <ExtLink className="mono nowrap" href={deployment.explorer.hubTx(facts.sendTx)}>
            {shortHash(facts.sendTx)}
          </ExtLink>
        </>
      ) : at > 0 ? (
        'Locked in the Hub escrow.'
      ) : (
        'Waiting for the Hub to confirm the send.'
      ),
    },
    {
      detail: 'Ethereum updates its view of the Hub every so often.',
      live:
        facts.stage === 'crossing' ? (
          <>
            We couldn't find the send transaction, so we can't tell which of these two steps it's on. {lag}
          </>
        ) : facts.blocksToGo !== undefined ? (
          <>
            Ethereum client is behind {blocks(facts.blocksToGo)}. {lag}
          </>
        ) : (
          lag
        ),
    },
    {
      detail: 'Anyone can prove it from their wallet, showing Ethereum the kid left the Hub. Nobody has to trust the prover.',
    },
    {
      detail: 'Anyone can claim it, and it always lands at the address it was sent to.',
      live: facts.stage === 'ready' ? 'Proven and ready to claim.' : null,
    },
  ]

  return (
    <ol className="stages">
      {items.map((item, i) => {
        const state = i < at && !current.includes(i) ? 'done' : current.includes(i) ? 'now' : ''
        const outOfSync = i === 1 && state === 'now' && facts.blocksToGo !== undefined && facts.blocksToGo > 0
        return (
          <li key={JOURNEY[i]} className={state} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="tick" aria-hidden="true">
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span>
              <b>
                {outOfSync ? OUT_OF_SYNC : i === 2 && state === 'now' ? PROVING : JOURNEY[i]}
                {state && <span className="sr-only">{state === 'done' ? ' (done)' : ' (happening now)'}</span>}
              </b>
              <span className="d">{item.detail}</span>
              {state === 'now' && item.live && <span className="d live">{item.live}</span>}
              {state === 'now' && i === 1 && speedUp}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The tracker's four crayon segments, the same four steps as the stage list. Decorative: the pill says the same. */
export function TrackBar({ stage }: { stage: Stage }) {
  const cur = JOURNEY_AT[stage]
  return (
    <div className="trackbar" aria-hidden="true">
      <div className="track">
        {TRACK_LABELS.map((l, i) => (
          <span key={l} className={i < cur ? 'on' : i === cur ? 'cur' : undefined} />
        ))}
      </div>
      <div className="track-labels">
        {TRACK_LABELS.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </div>
  )
}
