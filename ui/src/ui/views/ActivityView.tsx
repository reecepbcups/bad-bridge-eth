import { useActivityLog, useActivityStatus } from '../../activity/hooks'
import { ACTION_CHAIN, type Activity, type ActivityAction, type ActivityChain } from '../../activity/storage'
import { useBridge } from '../../chain/context'
import { Card } from '../chrome/Card'
import { ExtLink } from '../ExtLink'
import { dateTime, kidList, shortHash } from '../format'
import { KidDoodle } from '../KidArt'
import { useTitle } from '../useTitle'
import './activity.css'

const PROVE_REQUEST_URL = 'https://explorer.succinct.xyz/request'

// COPY: activity rows
const ACTION_LABEL: Readonly<Record<ActivityAction, string>> = {
  send: 'Send kids to escrow',
  nudge: 'Nudge',
  claim: 'Claim',
  'submit-proof': 'Submit proof',
  'buy-prove': 'Buy PROVE',
  'deposit-prove': 'Deposit PROVE',
  'sign-proof-request': 'Sign proof request',
  'sign-prove-permit': 'Sign PROVE permit',
}

const CHAIN_LABEL: Readonly<Record<ActivityChain, string>> = { hub: 'Hub', eth: 'Ethereum', succinct: 'Succinct' }

/** Everything this browser signed for this deployment, newest first, with live status from chain. */
export function ActivityView() {
  useTitle('Activity')
  const log = useActivityLog()
  return (
    <Card>
      <h2 tabIndex={-1}>Activity</h2>
      <p className="lede">Everything you've signed here, from this browser. Statuses come straight from the chain.</p>
      {log.length === 0 ? (
        <div className="empty">
          <KidDoodle id={7} />
          <div>
            <b>Nothing signed yet</b>
            <span>
              Sends, proofs and claims you sign here show up in this list. Start from <a href="#/">Bridge a kid</a>.
            </span>
          </div>
        </div>
      ) : (
        <ol className="activity">
          {[...log].reverse().map((entry) => (
            <Row key={entry.hash ?? `${entry.action}:${entry.at}`} entry={entry} />
          ))}
        </ol>
      )}
      <p className="note">Only this browser's own record. Clearing site data forgets it, but nothing on chain changes.</p>
    </Card>
  )
}

function Row({ entry }: { entry: Activity }) {
  const { deployment } = useBridge()
  const status = useActivityStatus(entry)
  const chain = ACTION_CHAIN[entry.action]
  const { hash, requestId, kids } = entry
  return (
    <li className="activity-row">
      <span className="when">{dateTime(new Date(entry.at))}</span>
      <span className={`where ${chain}`}>{CHAIN_LABEL[chain]}</span>
      <b className="what">{ACTION_LABEL[entry.action]}</b>
      {kids && kids.length > 0 && <span className="kids">{kidList(kids)}</span>}
      <span className={`pill status ${status ?? 'checking'}`}>{status ?? 'checking…'}</span>
      {hash && (
        <ExtLink className="mono" href={chain === 'hub' ? deployment.explorer.hubTx(hash) : deployment.explorer.ethTx(hash)}>
          {shortHash(hash)}
        </ExtLink>
      )}
      {requestId && (
        <ExtLink className="mono" href={`${PROVE_REQUEST_URL}/${requestId}`}>
          {shortHash(requestId)}
        </ExtLink>
      )}
    </li>
  )
}
