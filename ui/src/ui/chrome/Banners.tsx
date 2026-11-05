import { describeConfigProblem, useConfigSanity, useHealth } from '../../trips/hooks'
import type { ConfigProblem } from '../../trips/types'
import { shortAddress } from '../format'
import './Banners.css'

/** Site-wide notices: the light client is frozen, or the contracts don't match this site's settings. */
export function Banners() {
  const health = useHealth()
  const sanity = useConfigSanity()
  const frozen = health.data?.frozen === true
  const problems = (sanity.data?.problems ?? []).filter((p) => p.code !== 'NotLive')
  const warnings = sanity.data?.warnings ?? []
  if (!frozen && problems.length === 0 && warnings.length === 0) return null
  return (
    <div className="banners">
      {frozen && (
        <div className="banner paused" role="status">
          <b>The bridge is stuck for now</b>
          <span>
            Ethereum has stopped accepting updates from the Hub, so new kids can't cross and sending is off. Kids that already
            made it across can still be claimed.
            {/* COPY: paused banner */}
          </span>
        </div>
      )}
      {problems.length > 0 && (
        <div className="banner bad" role="alert">
          <b>Sending is switched off</b>
          <span>
            The bridge's send checks found a problem. New deposits are disabled until it is resolved.
            {/* COPY: config mismatch banner */}
          </span>
          <ul>
            {problems.map((p, i) => (
              <li key={`${p.code}-${i}`}>{describe(p)}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="banner warn" role="status">
          <b>The escrow still has admins</b>
          <span>
            Sending works, but these powers haven't been given up yet. Only send if you trust them.
            {/* COPY: escrow admin banner */}
          </span>
          <ul>
            {warnings.map((p, i) => (
              <li key={`${p.code}-${i}`}>{describe(p)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function describe(p: ConfigProblem): string {
  if (p.message) return p.message
  switch (p.code) {
    case 'ClientUnavailable':
    case 'EscrowAdmin':
      return describeConfigProblem(p)
    case 'EscrowCollection':
      return `The escrow accepts ${shortAddress(p.actual)}, but this site expects ${shortAddress(p.expected)}.`
    case 'BridgeEscrow':
      return `The Ethereum bridge trusts escrow ${shortAddress(p.actual)}, not this site's ${shortAddress(p.expected)}.`
    case 'NotLive':
      return "The bridge isn't deployed yet."
    case 'BridgeClient':
      return "The Ethereum bridge isn't linked to the light client this site expects."
  }
}
