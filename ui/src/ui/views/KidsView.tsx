import { useId, useRef, useState } from 'react'
import { useBridge } from '../../chain/context'
import { href, navigate } from '../../router'
import { POLL_MS, useHealth, useRememberedTrips, useTrips } from '../../trips/hooks'
import type { EthAddress, KidId } from '../../chain/types'
import type { Health, Trip, TripQuery } from '../../trips/types'
import { CLAIM_BATCH_CAP, ClaimButton, claimingHint, useClaimFlow, type ClaimFlow } from '../Claim'
import { Card } from '../chrome/Card'
import { ErrorNote } from '../ErrorNote'
import { ExtLink } from '../ExtLink'
import { blockNumber, dateTime, kidWord, shortAddress, timeAgo } from '../format'
import { useFocusWhenDone, useHubNow } from '../hooks'
import { KidArt, KidDoodle } from '../KidArt'
import { parseLookup, type Lookup } from '../lookup'
import { ProveBalanceNote, ProveButton, ProveFailure, ProveProgress, ResumeProof, useProveFlow, type ProveFlow } from '../ProveKid'
import { ShareLink } from '../ShareLink'
import { SpeedUp } from '../SpeedUp'
import { Scene } from '../Scene'
import { StageList, TrackBar } from '../StageList'
import { inFlight, slowestStage, STAGE_LINE, STAGE_PILL } from '../stages'
import { SwitchChain } from '../SwitchChain'
import { useTitle } from '../useTitle'
import './tracker.css'

// Two tabs off one list of kids headed to an address (or sent by one).
// Crossing: everything still on the bridge, with the Ethereum client progress. My Eth kids: the ones home on Ethereum.
// #/crossing and #/kids use the connected wallets plus kids this browser sent; add /<address> to look one address up.

export type KidsMode = 'crossing' | 'home'

export function KidsView({ address, mode }: { address?: string; mode: KidsMode }) {
  const { deployment, hubWallet, ethWallet } = useBridge()
  const remembered = useRememberedTrips()
  const connectedEth = ethWallet.status === 'connected' ? ethWallet.address : undefined
  const connectedHub = hubWallet.status === 'connected' ? hubWallet.address : undefined

  const lookup: Lookup | null = address ? parseLookup(address, deployment.hub.bech32Prefix, deployment.collectionSize) : null
  const query: TripQuery = lookup
    ? lookup.kind === 'eth'
      ? { eth: lookup.address }
      : lookup.kind === 'hub'
        ? { hub: lookup.address }
        : {}
    : { eth: connectedEth, hub: connectedHub, ids: remembered.length > 0 ? remembered : undefined }
  const active = Boolean(query.eth || query.hub || query.ids?.length)
  const trips = useTrips(query, { live: mode === 'crossing' })
  const health = useHealth()
  const flow = useClaimFlow()
  const prove = useProveFlow(() => trips.refetch())
  // kids claimed from this page, kept here: a claim can re-key the list and remount its rows
  const [claimed, setClaimed] = useState<readonly KidId[]>([])
  const heading = useRef<HTMLHeadingElement>(null)
  const claim: ClaimFlow = {
    ...flow,
    run: (ids) => {
      setClaimed(ids)
      return flow.run(ids)
    },
  }

  const target = lookup && (lookup.kind === 'eth' || lookup.kind === 'hub') ? lookup.address : null
  const mine = !target || [connectedEth, connectedHub].some((a) => a?.toLowerCase() === target.toLowerCase())
  const shareAddress = target ?? connectedEth ?? connectedHub

  const all = trips.data ?? []
  const onBridge = all.filter((t) => t.stage !== 'home-eth' && t.stage !== 'home-hub')
  const list = mode === 'crossing' ? onBridge : all.filter((t) => t.stage === 'home-eth')
  useFocusWhenDone(flow.pending, mode === 'crossing' && claimed.length > 0 && claimed.every((id) => !list.some((t) => t.tokenId === id)), heading)
  const ready = list.filter((t) => t.stage === 'ready')
  const claimableNow = ready.slice(0, CLAIM_BATCH_CAP)
  const crossingTrips = list.filter((t) => inFlight(t.stage))
  const crossing = crossingTrips.length
  // kids in one send usually share a recipient; if they don't, this speeds up whichever one's address it is
  const crossingRecipient = crossingTrips.find((t) => t.recipient)?.recipient ?? null
  // the group moves at its slowest kid's pace
  const groupStage = slowestStage(crossingTrips)
  const lead = crossingTrips.find((t) => t.stage === groupStage)
  const groupFacts = lead && {
    ...lead,
    stuck: crossingTrips.some((t) => t.stuck && t.stage === lead.stage),
  }
  // Nudging only helps until Ethereum's light client has caught up. Past `proving` it's already caught up.
  const nudgeHelps = crossingTrips.some((t) => t.stage !== 'proving')
  const provingTrips = list.filter((t) => t.stage === 'proving')
  // one proof/one submitBatch tx covers however many records are in it, at close to the cost of one
  const provingRecipients = new Map(provingTrips.filter((t) => t.recipient).map((t) => [t.tokenId, t.recipient as EthAddress]))
  const crossingView = mode === 'crossing'
  const title = crossingView
    ? mine
      ? 'Crossing'
      : `Crossing for ${shortAddress(target ?? '')}`
    : mine
      ? 'My Eth kids'
      : `Eth kids for ${shortAddress(target ?? '')}`
  useTitle(title)
  const opensea = crossingView ? null : deployment.explorer.openseaCollection()

  return (
    <Card>
      {opensea ? (
        <div className="row start">
          <h2 tabIndex={-1} ref={heading}>{title}</h2>
          <ExtLink className="btn ghost small" href={opensea}>
            OpenSea
          </ExtLink>
        </div>
      ) : (
        <h2 tabIndex={-1} ref={heading}>{title}</h2>
      )}
      <p className="lede">
        {crossingView
          ? 'Kids on their way to Ethereum. Close this tab if you like, they will be waiting here.'
          : lookup?.kind === 'hub'
            ? 'Every kid this Hub address sent that is home on Ethereum.'
            : mine
              ? 'Every kid of yours that is home on Ethereum.'
              : 'Every kid home on Ethereum at this address.'}
      </p>
      {/* key remounts the box when the known identity changes (e.g. lazy wallet connect), so it picks up the new initial value */}
      <LookupBox key={address ?? connectedEth ?? ''} initial={address ?? connectedEth ?? ''} mode={mode} />

      {lookup?.kind === 'bad' && (
        <p className="hint bad" role="alert">
          {lookup.message}
        </p>
      )}

      {!active && lookup?.kind !== 'bad' && (
        <div className="empty">
          <KidDoodle id={3} />
          <div>
            <b>Who are we looking for?</b>
            <span>Connect a wallet, or paste an Ethereum address, a Hub address or a kid number above.</span>
          </div>
        </div>
      )}

      {active && !trips.data && trips.error && (
        <ErrorNote error={trips.error} action="read" onRetry={trips.refetch} live={false} />
      )}
      {active && !trips.data && !trips.error && <LoadingRows />}

      {trips.data && list.length === 0 && (
        <div className="empty">
          <KidDoodle id={5} />
          <div>
            <b>{crossingView ? 'Nothing crossing' : 'No kids home on Ethereum'} {lookup ? 'for this address' : 'yet'}</b>
            <span>
              {mine ? (
                crossingView ? (
                  <>
                    Send one from <a href="#/">Bridge a kid</a>.
                  </>
                ) : (
                  <>
                    Nothing home yet. Send one from <a href="#/">Bridge a kid</a>.
                  </>
                )
              ) : (
                'Nothing has been sent to or from this address.'
              )}
            </span>
          </div>
        </div>
      )}

      {!crossingView && onBridge.length > 0 && (
        <p className="note nudge">
          {onBridge.length} {kidWord(onBridge.length)} crossing{' '}
          <a className="btn ghost small" href={href({ name: 'crossing', address })}>
            See crossing
          </a>
        </p>
      )}

      {crossingView && groupFacts && crossingRecipient && (
        <>
          <Scene ids={crossingTrips.map((t) => t.tokenId)} stage={groupFacts.stage} />
          <StageList
            facts={groupFacts}
            health={health.data}
            kids={crossing}
            speedUp={nudgeHelps && <SpeedUp recipient={crossingRecipient} n={crossing} />}
          />
          {health.data && (
            <p className="muted mono heights">
              Hub block {blockNumber(health.data.hubHeight)} · Ethereum has seen {blockNumber(health.data.clientHeight)}
            </p>
          )}
        </>
      )}

      {list.length > 0 && (
        <>
          <div className="row">
            <div className="summary">
              {crossing > 0 && <span className="pill crossing">{crossing} crossing</span>}
              {ready.length > 0 && <span className="pill ready">{ready.length} ready</span>}
            </div>
            {ready.length > 1 && (
              <ClaimButton ids={claimableNow.map((t) => t.tokenId)} flow={claim}>
                {ready.length > CLAIM_BATCH_CAP
                  ? `Claim ${CLAIM_BATCH_CAP} of ${ready.length}`
                  : ready.length === 2
                    ? 'Claim both'
                    : `Claim all ${ready.length}`}
              </ClaimButton>
            )}
            {!deployment.demo && provingTrips.length > 1 && (
              <ProveButton ids={provingTrips.map((t) => t.tokenId)} expectedRecipients={provingRecipients} flow={prove}>
                {/* one proof covers the whole batch, at close to the cost of proving just one */}
                {provingTrips.length === 2 ? 'Prove both' : `Prove all ${provingTrips.length}`}
              </ProveButton>
            )}
          </div>
          {!deployment.demo && provingTrips.length > 0 && <ProveBalanceNote />}
          {ready.length > 0 && ethWallet.wrongChain && <SwitchChain />}
          {ready.length > 0 && !ethWallet.wrongChain && ethWallet.status !== 'connected' && (
            <p className="hint">Connect an Ethereum wallet to claim. Anyone can claim: kids always land at the address they were sent to.</p>
          )}
          {claim.failure && (
            <ErrorNote
              error={claim.failure.error}
              action="claim"
              walletName={ethWallet.walletName}
              tokenId={claim.failure.ids.length === 1 ? claim.failure.ids[0] : undefined}
            />
          )}
          <ProveProgress flow={prove} />
          <ProveFailure flow={prove} />
          {!deployment.demo && crossingView && provingTrips.length > 0 && <ResumeProof onProved={trips.refetch} />}
          {trips.error && <ErrorNote error={trips.error} action="read" onRetry={trips.refetch} live={false} />}
          <ul className="list" aria-label="Kids on the bridge">
            {list.map((t) => (
              <TripRow
                key={t.tokenId}
                trip={t}
                health={health.data}
                claim={claim}
                prove={prove}
                claimedHere={claimed.includes(t.tokenId)}
                showStages={!crossingView}
              />
            ))}
          </ul>
          {/* always in the page, so screen readers hear each change */}
          <p className={claim.stage ? 'hint center' : 'sr-only'} role="status">
            {claim.stage ? claimingHint(claim.stage, ethWallet.walletName) : ''}
          </p>
        </>
      )}

      <div className="row foot">
        <p className="note">
          {foundBy(lookup, mine, connectedEth, connectedHub)} Checks again every {Math.round(POLL_MS / 1000)} seconds.
        </p>
        {shareAddress && <ShareLink hash={href({ name: crossingView ? 'crossing' : 'kids', address: shareAddress })} />}
      </div>
    </Card>
  )
}

// COPY: tracker footnote
/** How the list was found, so nobody's told a stranger's address is theirs. */
function foundBy(lookup: Lookup | null, mine: boolean, eth: string | undefined, hub: string | undefined): string {
  const anywhere = 'so it works from any device.'
  if (lookup?.kind === 'hub') return `Found by ${mine ? 'your ' : ''}Hub address, ${anywhere}`
  if (lookup?.kind === 'eth') return `Found by ${mine ? 'your ' : ''}Ethereum address, ${anywhere}`
  if (eth) return `Found by your Ethereum address, ${anywhere}`
  if (hub) return `Found by your Hub address, ${anywhere}`
  return 'Kids sent from this browser. Look up an address to see them from any device.'
}

function LookupBox({ initial, mode }: { initial: string; mode: KidsMode }) {
  const { deployment } = useBridge()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const errorId = useId()
  return (
    <form
      className="lookup"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const parsed = parseLookup(value, deployment.hub.bech32Prefix, deployment.collectionSize)
        if (parsed.kind === 'bad') return setError(parsed.message)
        setError(null)
        navigate(
          parsed.kind === 'kid'
            ? { name: 'kid', id: parsed.id }
            : { name: mode === 'crossing' ? 'crossing' : 'kids', address: parsed.address },
        )
      }}
    >
      <label className="hint full" htmlFor={inputId}>
        Ethereum address, Hub address or kid number
      </label>
      <input
        type="text"
        id={inputId}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder="0x…, cosmos1… or #1234"
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
      />
      <button type="submit" className="btn ghost">
        Look up
      </button>
      {error && (
        <p className="hint bad full" id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function LoadingRows() {
  return (
    <>
      <p className="sr-only" role="status">
        Looking for kids…
      </p>
      <ul className="list" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="item skeleton">
            <span className="art" />
            <span className="bar" />
            <span className="bar short" />
          </li>
        ))}
      </ul>
    </>
  )
}

export function TripRow({
  trip,
  health,
  claim,
  prove,
  claimedHere = false,
  showStages = true,
}: {
  trip: Trip
  health: Health | undefined
  claim: ClaimFlow
  prove: ProveFlow
  /** Claimed from this page: when it lands, its Claim button goes away, so focus moves to the kid. */
  claimedHere?: boolean
  /** Off where the page already shows the stage list for the whole group. */
  showStages?: boolean
}) {
  const { deployment } = useBridge()
  const hubNow = useHubNow()
  const idLink = useRef<HTMLAnchorElement>(null)
  useFocusWhenDone(claimedHere, trip.stage === 'home-eth', idLink)
  const pill = STAGE_PILL[trip.stage]
  const token = trip.stage === 'home-eth' ? deployment.explorer.ethToken(trip.tokenId) : null
  const sent = trip.sentAt ? `Sent ${sentWhen(trip.sentAt, hubNow)}` : null
  const line = [sent, STAGE_LINE[trip.stage], trip.stuck ? 'waiting for a prover' : null].filter(Boolean).join(' · ')
  return (
    <li className="item">
      <KidArt id={trip.tokenId} size={72} decorative />
      <div className="top">
        <a className="id" href={href({ name: 'kid', id: trip.tokenId })} ref={idLink}>
          #{trip.tokenId}
        </a>
        <span className={pill.className}>{pill.label}</span>
      </div>
      <div className="act">
        {trip.stage === 'ready' && (
          <ClaimButton ids={[trip.tokenId]} flow={claim}>
            Claim
          </ClaimButton>
        )}
        {!deployment.demo && trip.stage === 'proving' && (
          <ProveButton
            ids={[trip.tokenId]}
            expectedRecipients={trip.recipient ? new Map([[trip.tokenId, trip.recipient]]) : undefined}
            flow={prove}
          >
            Prove it yourself
          </ProveButton>
        )}
        {token && (
          <ExtLink className="btn ghost" href={token} aria-label={`View #${trip.tokenId} on Etherscan`}>
            View
          </ExtLink>
        )}
      </div>
      <div className="info">
        <TrackBar stage={trip.stage} />
        <div className="meta">{line}</div>
      </div>
      {showStages && inFlight(trip.stage) && (
        <details>
          <summary>What's happening?</summary>
          <StageList facts={trip} health={health} />
        </details>
      )}
    </li>
  )
}

/** "22 min ago" for recent sends, "Sep 26, 9:12 pm" for older ones. */
function sentWhen(at: Date, now: Date | undefined): string {
  if (!now) return dateTime(at)
  const recent = now.getTime() - at.getTime() < 3 * 3_600_000
  return recent ? timeAgo(at, now) : dateTime(at)
}

