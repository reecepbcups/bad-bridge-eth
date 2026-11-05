import { useRef } from 'react'
import { useBridge } from '../../chain/context'
import type { KidId } from '../../chain/types'
import { href } from '../../router'
import { useHealth, useTrip } from '../../trips/hooks'
import { ClaimButton, useClaimFlow } from '../Claim'
import { Card } from '../chrome/Card'
import { ErrorNote } from '../ErrorNote'
import { ExtLink } from '../ExtLink'
import { blockNumber, dateTime, shortAddress, shortHash } from '../format'
import { useFocusWhenDone } from '../hooks'
import { KidArt } from '../KidArt'
import { isKidId } from '../lookup'
import { ProveBalanceNote, ProveButton, ProveFailure, ProveProgress, useProveFlow } from '../ProveKid'
import { ShareLink } from '../ShareLink'
import { StageList } from '../StageList'
import { STAGE_PILL } from '../stages'
import { SwitchChain } from '../SwitchChain'
import { useTitle } from '../useTitle'
import './tracker.css'

// One kid's trip, for anyone: the owner, a friend holding a share link, or a curious stranger.

const LEDE: Readonly<Record<string, string>> = {
  'home-hub': "Still on the Cosmos Hub. It hasn't been sent across.",
  locked: 'Locked in the Hub escrow, waiting for Ethereum to catch up.',
  'catching-up': 'On the bridge: waiting for Ethereum to catch up to the Hub.',
  crossing: 'On the bridge.',
  proving: 'On the bridge: Ethereum caught up, and the proof is being made.',
  ready: 'Made it across! The proof landed on Ethereum, so it can be claimed.',
  'home-eth': 'Home on Ethereum.',
}

export function KidView({ id }: { id: KidId }) {
  const { deployment } = useBridge()
  const real = isKidId(id, deployment.collectionSize)
  useTitle(real ? `#${id}` : 'No such kid')
  if (!real) return <NoSuchKid id={id} />
  return <Kid id={id} />
}

function NoSuchKid({ id }: { id: KidId }) {
  const { deployment } = useBridge()
  return (
    <Card>
      <h2 tabIndex={-1}>There's no kid #{id}</h2>
      <p className="lede">
        {deployment.collectionName} run from #1 to #{deployment.collectionSize}. <a href="#/kids">Look up another</a>
        {/* COPY: no such kid */}
      </p>
    </Card>
  )
}

function Kid({ id }: { id: KidId }) {
  const { deployment, hubWallet, ethWallet } = useBridge()
  const trip = useTrip(id)
  const health = useHealth()
  const claim = useClaimFlow()
  const prove = useProveFlow()
  const heading = useRef<HTMLHeadingElement>(null)
  const t = trip.data
  // claimed here: the Claim button goes away when it lands
  useFocusWhenDone(claim.claiming.includes(id), t?.stage === 'home-eth', heading)
  const { explorer } = deployment
  const sent = t && t.stage !== 'home-hub'
  const opensea = t?.stage === 'home-eth' ? explorer.opensea(id) : null
  const token = t?.stage === 'home-eth' ? explorer.ethToken(id) : null
  // "Owner now" only says something when the kid changed hands after landing
  const owner = t?.owner && (!t.recipient || t.owner.toLowerCase() !== t.recipient.toLowerCase()) ? t.owner : null

  return (
    <Card>
      <div className="kid-head">
        <KidArt id={id} size={110} eager />
        <div>
          <h2 tabIndex={-1} ref={heading}>
            #{id}
          </h2>
          {t ? (
            <span className={STAGE_PILL[t.stage].className}>{STAGE_PILL[t.stage].label}</span>
          ) : (
            <span className="pill skeleton-pill" aria-hidden="true">
              &nbsp;
            </span>
          )}
        </div>
      </div>

      {!t && trip.error && <ErrorNote error={trip.error} action="read" onRetry={trip.refetch} live={false} />}
      {!t && !trip.error && <KidSkeleton id={id} />}

      {t && trip.error && <ErrorNote error={trip.error} action="read" onRetry={trip.refetch} live={false} />}
      {t && (
        <>
          <p className="lede">
            {LEDE[t.stage]}
            {t.stage === 'home-hub' && hubWallet.status === 'connected' && (
              <>
                {' '}
                If it's yours, send it from <a href="#/">Bridge a kid</a>.
              </>
            )}
          </p>
          {t.stage === 'ready' && (
            <div className="row start">
              <ClaimButton ids={[id]} flow={claim}>
                {`Claim #${id}`}
              </ClaimButton>
              <span className="hint">
                Anyone can claim; it always goes to <span className="nowrap">{t.recipient ? shortAddress(t.recipient) : 'its recipient'}</span>.
              </span>
            </div>
          )}
          {t.stage === 'ready' && ethWallet.wrongChain && <SwitchChain />}
          {claim.failure && <ErrorNote error={claim.failure.error} action="claim" walletName={ethWallet.walletName} tokenId={id} />}
          {!deployment.demo && t.stage === 'proving' && (
            <div className="row start">
              <ProveButton ids={[id]} expectedRecipients={t.recipient ? new Map([[id, t.recipient]]) : undefined} flow={prove}>
                Prove it yourself
              </ProveButton>
              <span className="hint">Proves it now, from your wallet.</span>
            </div>
          )}
          {!deployment.demo && t.stage === 'proving' && <ProveBalanceNote />}
          {t.stage === 'proving' && ethWallet.wrongChain && <SwitchChain />}
          <ProveProgress flow={prove} />
          <ProveFailure flow={prove} />
          {sent && <StageList facts={t} health={health.data} />}

          <dl className="facts">
            {t.recipient && (
              <>
                <dt>Headed to</dt>
                <dd>
                  <ExtLink className="mono" href={explorer.ethAddress(t.recipient)}>
                    {t.recipient}
                  </ExtLink>
                  <br />
                  <a href={href({ name: 'kids', address: t.recipient })}>Every kid headed there</a>
                </dd>
              </>
            )}
            {t.sendTx && (
              <>
                <dt>Sent</dt>
                <dd>
                  {t.sentAt && <>{dateTime(t.sentAt)} · </>}
                  <ExtLink className="mono nowrap" href={explorer.hubTx(t.sendTx)}>
                    {shortHash(t.sendTx)}
                  </ExtLink>
                  {t.sendHeight !== undefined && <> · Hub block {blockNumber(t.sendHeight)}</>}
                </dd>
              </>
            )}
            {t.sender && (
              <>
                <dt>Sent by</dt>
                <dd>
                  <ExtLink className="mono nowrap" href={explorer.hubAccount(t.sender)}>
                    {shortAddress(t.sender)}
                  </ExtLink>
                </dd>
              </>
            )}
            {owner && (
              <>
                <dt>Owner now</dt>
                <dd>
                  <ExtLink className="mono" href={explorer.ethAddress(owner)}>
                    {owner}
                  </ExtLink>
                  <span className="hint"> (it changed hands after landing)</span>
                </dd>
              </>
            )}
          </dl>

          {(token || opensea) && (
            <div className="row start">
              {token && (
                <ExtLink className="btn ghost" href={token}>
                  Etherscan
                </ExtLink>
              )}
              {opensea && (
                <ExtLink className="btn ghost" href={opensea}>
                  OpenSea
                </ExtLink>
              )}
            </div>
          )}
        </>
      )}

      <div className="row foot">
        <a href="#/kids">← Back to the tracker</a>
        <ShareLink hash={href({ name: 'kid', id })} />
      </div>
    </Card>
  )
}

/** Roughly the shape of a sent kid's page, so the real one doesn't shove the footer around when it lands. */
function KidSkeleton({ id }: { id: KidId }) {
  return (
    <>
      <p className="sr-only" role="status">
        Looking for #{id}…
      </p>
      <div className="kid-skeleton skeleton" aria-hidden="true">
        <span className="bar" />
        <span className="skel-steps">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="skel-step">
              <span className="art" />
              <span className="bar title" />
              <span className="bar" />
              <span className="bar short" />
            </span>
          ))}
        </span>
        <span className="skel-facts">
          {[0, 1, 2].map((i) => (
            <span key={i} className="skel-fact">
              <span className="bar label" />
              <span className="bar" />
              <span className="bar short" />
            </span>
          ))}
        </span>
        <span className="skel-btns">
          <span className="bar" />
          <span className="bar" />
        </span>
      </div>
    </>
  )
}
