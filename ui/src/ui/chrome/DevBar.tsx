import { useState } from 'react'
import { useDemoControls } from '../../chain/demo/controls'
import type { BridgeErrorCode } from '../../chain/types'
import { href, type Route } from '../../router'
import './DevBar.css'

const JUMPS: readonly { label: string; route: Route }[] = [
  { label: 'bridge', route: { name: 'bridge' } },
  { label: 'crossing', route: { name: 'crossing' } },
  { label: 'my eth kids', route: { name: 'kids' } },
  { label: 'kid #8783', route: { name: 'kid', id: 8783 } },
  { label: 'about', route: { name: 'about' } },
]

const FAILURES: readonly BridgeErrorCode[] = [
  'UserRejected',
  'InsufficientFunds',
  'AlreadyBridged',
  'NotOwner',
  'ZeroRecipient',
  'BadRecipient',
  'WrongCollection',
  'BadTokenId',
  'NotProven',
  'WrongChain',
  'Network',
  'Unknown',
]

const HALF_HOUR = 30 * 60_000

/** The mockup's jump bar, wired to the demo sim. Renders nothing outside demo mode. */
export function DevBar({ route }: { route: Route }) {
  const demo = useDemoControls()
  const [open, setOpen] = useState(false)
  if (!demo) return null
  const s = demo.snapshot
  const here = href(route)
  return (
    <nav className="mock" aria-label="Demo controls">
      <span>demo · jump to</span>
      {JUMPS.map((j) => (
        <a key={j.label} href={href(j.route)} aria-current={href(j.route) === here ? 'page' : undefined}>
          {j.label}
        </a>
      ))}
      <button type="button" onClick={() => demo.skip()} disabled={s.pending === 0}>
        skip ahead
      </button>
      <button type="button" aria-expanded={open} aria-controls="demo-more" onClick={() => setOpen(!open)}>
        {open ? 'less' : 'more'}
      </button>
      {open && (
        <div className="more" id="demo-more">
          <button type="button" onClick={() => demo.advance(HALF_HOUR)}>
            +30 min
          </button>
          <button type="button" aria-pressed={s.paused} onClick={() => demo.setPaused(!s.paused)}>
            paused
          </button>
          <button type="button" aria-pressed={s.frozen} onClick={() => demo.setFrozen(!s.frozen)}>
            frozen
          </button>
          <button type="button" aria-pressed={s.offline} onClick={() => demo.setOffline(!s.offline)}>
            offline
          </button>
          <select
            aria-label="Fail the next write with"
            value={s.failNext ?? ''}
            onChange={(e) => demo.setFailNext((e.target.value || null) as BridgeErrorCode | null)}
          >
            <option value="">no failure</option>
            {FAILURES.map((code) => (
              <option key={code} value={code}>
                fail: {code}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={s.hubWallet.status === 'connected'}
            onClick={() => demo.setWallet('hub', s.hubWallet.status !== 'connected')}
          >
            hub wallet
          </button>
          <button
            type="button"
            aria-pressed={s.ethWallet.status === 'connected'}
            onClick={() => demo.setWallet('eth', s.ethWallet.status !== 'connected')}
          >
            eth wallet
          </button>
          <button type="button" aria-pressed={s.ethWrongChain} onClick={() => demo.setWrongChain(!s.ethWrongChain)}>
            wrong chain
          </button>
          <button type="button" onClick={() => demo.reset()}>
            reset
          </button>
          <span className="stat">
            hub {s.hubHeight.toLocaleString('en-US')} · eth sees {s.clientHeight.toLocaleString('en-US')}
            {s.paused && ' · paused'}
          </span>
        </div>
      )}
    </nav>
  )
}
