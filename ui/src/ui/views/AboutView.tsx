import { useState, type ReactNode } from 'react'
import { useBridge } from '../../chain/context'
import { CLAIM_GAS_EXTRA } from '../../chain/eth/gas'
import { MAX_KIDS_PER_SEND, type HubAddress, type SendStage } from '../../chain/types'
import { isLive } from '../../config/deployments'
import { useClaimEstimate, useConfigSanity, useHealth, useNudge, useTrustFacts, type TrustFacts } from '../../trips/hooks'
import { formatEth } from '../Claim'
import { Card } from '../chrome/Card'
import { ConnectButton } from '../Connect'
import { CostList } from '../CostList'
import { ErrorNote } from '../ErrorNote'
import { errorCopy } from '../errors'
import { ExtLink } from '../ExtLink'
import { aboutMinutes, blockNumber, shortAddress } from '../format'
import { useChangedAt, useWallClock } from '../hooks'
import { KidArt } from '../KidArt'
import { useToast } from '../Toasts'
import { useTitle } from '../useTitle'
import './about.css'

// Ported from the mockup's About view, with the facts fixed: one signature sends up to 50 kids, one Ethereum
// tx claims any number, and waiting times are live instead of "20–60 minutes".
// Addresses come from the active deployment. The trust list is built from live reads (useTrustFacts), so it
// says what's true of this deployment, not what we hope is true.

export function AboutView() {
  const { deployment } = useBridge()
  const health = useHealth()
  const trust = useTrustFacts()
  const claimCost = useClaimEstimate([])
  useTitle('About')
  const { hub, eth, explorer } = deployment
  const source = deployment.sourceUrl.replace(/^https:\/\//, '')
  const lag = health.data && !health.data.stale ? aboutMinutes(health.data.lagMinutes) : null
  const facts = trust.data
  const collectionAdmin = facts?.collection?.admin ?? null
  const escrowAdmin = facts?.escrow?.admin ?? null
  const emergencyAdmin = facts?.emergencyAdmin
  const cost = claimCost.data
  return (
    <Card>
      <div className="about">
        <h2 tabIndex={-1}>What's the Bad Bridge?</h2>
        <p className="lede">
          A one-way bridge that moves Bad Kids from the Cosmos Hub to Ethereum. Same kid, same number, same art, new home.
        </p>
        <div className="celebrate">
          {[4801, 663, 3838].map((id) => (
            <KidArt key={id} id={id} size={110} eager />
          ))}
        </div>

        <HealthStrip />

        <h3>How it works</h3>
        <ol className="how">
          <li>
            <span className="n">1</span>
            <span className="where hub">Cosmos Hub</span>
            <b>You send your kids</b>They go into an escrow on the Hub, along with the Ethereum address they should land at.
            One signature sends up to {MAX_KIDS_PER_SEND} at a time.
            {/* COPY: how-it-works step 1 */}
          </li>
          <li>
            <span className="n">2</span>
            <span className="where mid">In between</span>
            <b>You prove they left</b>From your wallet, a zero-knowledge proof shows Ethereum that the kids really are locked on the Hub.
          </li>
          <li>
            <span className="n">3</span>
            <span className="where eth">Ethereum</span>
            <b>You claim them</b>The same kids, with the same numbers, get minted to your Ethereum address. One transaction
            claims them all.
            {/* COPY: how-it-works step 3 */}
          </li>
        </ol>

        <h3>Why you can trust it</h3>
        <TrustList facts={facts} failed={trust.error !== null} />

        <h3>What it costs</h3>
        <CostList />

        <h3>Good to know</h3>
        <div className="faq">
          <details>
            <summary>Why can't kids come back?</summary>
            <p>
              Going back would need the Hub to check proofs about Ethereum, and it can't do that today. Once a kid
              crosses, it stays on Ethereum.
            </p>
          </details>
          <details>
            <summary>Why does it take a while?</summary>
            <p>
              Ethereum only learns about new Hub blocks when IBC Eureka relays a transfer. After that, you prove
              them, and one proof covers all your waiting kids. So the wait depends on how far behind Ethereum is
              {lag ? <>: right now that's {lag}.</> : '.'}
              {/* COPY: FAQ wait time */}
            </p>
          </details>
          <details>
            <summary>Does the art change?</summary>
            <p>No. The Ethereum kid points at the same IPFS folder as the Hub kid, so the picture and traits are identical.</p>
          </details>
          <details>
            <summary>What happens to the kid on the Hub?</summary>
            <p>
              It stays locked in the escrow. Permanent locking requires both the escrow's upgrade admin and its separate
              emergency-unlock admin to be removed; the send screen checks both.
              {emergencyAdmin ? ' This escrow still has an emergency-unlock admin who can return deposited kids.' : ''}
              {collectionAdmin
                ? ` One catch: the ${deployment.collectionName} contract has an admin who could upgrade it and move kids out of the escrow (see above).${
                    escrowAdmin ? ' The escrow itself also has an admin who could upgrade it.' : ''
                  }`
                : escrowAdmin
                  ? ' One catch: this escrow has an admin who could upgrade it (see above).'
                  : ''}
              {/* COPY: FAQ the kid on the Hub */}
            </p>
          </details>
          <details>
            <summary>What does it cost?</summary>
            <p>
              One Hub transaction sends up to {MAX_KIDS_PER_SEND} kids, for a small ATOM fee. Then one Ethereum transaction
              claims them all
              {cost
                ? `: right now about ${formatEth(cost.fee)} for one kid, plus about ${formatEth((CLAIM_GAS_EXTRA * BigInt(cost.gasPrice)).toString())} for each extra kid in the same claim.`
                : ': about 79,000 gas for one kid, plus about 30,000 for each extra kid in the same claim.'}{' '}
              Proving adds about 0.33 PROVE plus about 0.002 ETH to submit it, the same for 1 kid or 50.
              {/* COPY: FAQ cost */}
            </p>
          </details>
          <details>
            <summary>Who can claim my kid?</summary>
            <p>
              Anyone. A claim always mints the kid to the address it was sent to, so it's safe for a friend (or a bot) to
              claim for you.
              {/* COPY: FAQ who can claim */}
            </p>
          </details>
          <details>
            <summary>Ethereum and Hub kids: are they the same?</summary>
            <p>
              Same number, same art, but they trade separately. An Ethereum kid trades on Ethereum marketplaces, not on
              Stargaze or other Hub marketplaces.
              {/* COPY: needs sign-off (trading disclosure) */}
            </p>
          </details>
          <details>
            <summary>I closed the tab. Where's my kid?</summary>
            <p>
              Open <a href="#/kids">My kids</a> and look up your Ethereum address, your Hub address or the kid's number.
              It works from any device.
            </p>
          </details>
        </div>

        <h3>Contracts</h3>
        <dl className="addrs">
          <dt>Escrow (Cosmos Hub)</dt>
          <dd>
            {hub.escrow ? (
              <ExtLink className="mono" href={explorer.hubContract(hub.escrow)}>
                {hub.escrow}
              </ExtLink>
            ) : (
              <span className="muted">not live yet</span>
            )}
          </dd>
          <dt>{deployment.collectionName} (Cosmos Hub)</dt>
          <dd>
            <ExtLink className="mono" href={explorer.hubContract(hub.cw721)}>
              {hub.cw721}
            </ExtLink>
          </dd>
          <dt>BadBridge (Ethereum)</dt>
          <dd>
            {eth.bridge ? (
              <ExtLink className="mono" href={explorer.ethAddress(eth.bridge)}>
                {eth.bridge}
              </ExtLink>
            ) : (
              <span className="muted">not live yet</span>
            )}
          </dd>
          <dt>OpenSea</dt>
          <dd>
            {explorer.openseaCollection() ? (
              <ExtLink href={explorer.openseaCollection() as string}>{deployment.collectionName}</ExtLink>
            ) : (
              <span className="muted">not live yet</span>
            )}
          </dd>
          <dt>Hub light client (Ethereum)</dt>
          <dd>
            <ExtLink className="mono" href={explorer.ethAddress(eth.lightClient)}>
              {eth.lightClient}
            </ExtLink>
          </dd>
          <dt>Source</dt>
          <dd>
            <ExtLink href={deployment.sourceUrl}>{source}</ExtLink>
          </dd>
        </dl>
        <ContractsCheck />
        {deployment.demo ? (
          <p className="note">
            This is the demo: nothing here touches a real chain. The addresses are the test deployment (ReeceBadTest).
          </p>
        ) : deployment.id !== 'badkids' ? (
          <p className="note">These are the test deployment ({deployment.collectionName}). The real Bad Kids addresses go here at launch.</p>
        ) : null}
      </div>
    </Card>
  )
}

/** An admin's address, short, linked to the explorer. */
function Admin({ address }: { address: HubAddress }) {
  const { deployment } = useBridge()
  return (
    <ExtLink className="mono nowrap" href={deployment.explorer.hubAccount(address)} arrow={false}>
      {shortAddress(address)}
    </ExtLink>
  )
}

function Fact({ tone = 'ok', children }: { tone?: 'ok' | 'caveat' | 'unknown'; children: ReactNode }) {
  return (
    <li className={tone === 'ok' ? undefined : tone}>
      <span>{children}</span>
    </li>
  )
}

/**
 * What a kid depends on, and who could change it, for this deployment. ✓ for facts that hold, ! for caveats,
 * built from live contract_info and proxy reads.
 */
function TrustList({ facts, failed }: { facts: TrustFacts | undefined; failed: boolean }) {
  const { deployment } = useBridge()
  const { hub, eth, collectionName } = deployment
  const test = deployment.id !== 'badkids'
  const unknown = (what: string) =>
    failed || facts ? `Couldn't check who can change ${what} just now.` : `Checking who can change ${what}…`
  const escrow = facts?.escrow
  const collection = facts?.collection
  return (
    <>
      <ul className="trust">
        <Fact>
          <b>Minting requires a proof.</b> Every kid on Ethereum is backed by a proof of the Hub's state, checked
          against the light client that IBC Eureka already runs on Ethereum.
        </Fact>
        {hub.escrow &&
          (escrow === undefined ? (
            <Fact tone="unknown">{unknown('the escrow')}</Fact>
          ) : escrow?.admin ? (
            <Fact tone="caveat">
              <b>{test ? 'This test escrow has an admin' : 'The escrow has an admin'}</b> (<Admin address={escrow.admin} />) who
              can upgrade it. An upgrade could change where kids that haven't crossed yet end up.
              {/* COPY: trust, escrow admin */}
            </Fact>
          ) : (
            <Fact>
              <b>The escrow has no upgrade admin.</b> Nobody can migrate its code.
              {/* COPY: trust, no escrow admin */}
            </Fact>
          ))}
        {hub.escrow && (facts?.emergencyAdmin === undefined ? (
          <Fact tone="unknown">{unknown("the escrow's emergency unlock authority")}</Fact>
        ) : facts.emergencyAdmin ? (
          <Fact tone="caveat"><b>The escrow has an emergency-unlock admin.</b> <Admin address={facts.emergencyAdmin} /> can
            return deposited kids, including kids already proven on Ethereum. Sending is disabled until this power is renounced.</Fact>
        ) : (
          <Fact><b>Emergency unlock is renounced.</b> The escrow's internal admin can no longer release deposited kids.</Fact>
        ))}
        {eth.bridge && (
          <>
            <Fact>
              <b>The Ethereum bridge cannot be upgraded.</b> Its owner can change royalty settings and contract metadata,
              but cannot mint a kid without a proof or change the pinned light client.
              {/* COPY: trust, BadBridge */}
            </Fact>
            <Fact tone="caveat">
              <b>It leans on IBC Eureka.</b> BadBridge checks proofs against Eureka's light client of the Hub, and Eureka's
              governance can freeze that client or replace the router's entry
              {facts?.routerUpgradeable === true
                ? ' (the Eureka router that points to it can be upgraded)'
                : facts && facts.routerUpgradeable === undefined
                  ? " (we couldn't confirm whether the Eureka router can be upgraded)"
                  : ''}
              . BadBridge keeps its original client even after a router replacement. If that pinned client expires,
              is retired, or stays frozen, unproven kids may be stranded. Already-proven kids can still be claimed.
              {/* COPY: trust, Eureka dependency */}
            </Fact>
          </>
        )}
        {collection === undefined ? (
          <Fact tone="unknown">{unknown(`the ${collectionName} contract`)}</Fact>
        ) : collection.admin ? (
          <Fact tone="caveat">
            <b>The {collectionName} contract has an admin</b> (<Admin address={collection.admin} />) who can upgrade it, and an
            upgrade could move kids out of the escrow. The bridge can't stop that.
            {/* COPY: trust, collection admin */}
          </Fact>
        ) : (
          <Fact>
            <b>The {collectionName} contract has no admin.</b> Nobody can upgrade it to move kids out of the escrow.
            {/* COPY: trust, no collection admin */}
          </Fact>
        )}
        <Fact>
          <b>The prover can't lie.</b> The worst it can do is stop. If that happens, anyone can run another one from the
          open source code.
        </Fact>
      </ul>
      {isLive(deployment) && (
        <p className="trust-note muted">
          Admins and upgradeability are read live from the chains' public endpoints, as a check on this site's settings.
          {/* COPY: trust note */}
        </p>
      )}
    </>
  )
}

/** The startup sanity check, said out loud: the contracts above are the ones the chains say they are. */
function ContractsCheck() {
  const { deployment } = useBridge()
  const sanity = useConfigSanity()
  const s = sanity.data
  if (s?.status === 'not-live') return null
  return (
    <p className={s?.ok ? 'contracts-check ok' : s?.status === 'mismatch' ? 'contracts-check bad' : 'contracts-check muted'} role="status">
      {s?.ok
        ? `✓ Checked live: the escrow only takes ${deployment.collectionName}, the Ethereum bridge only trusts this escrow, and it follows the Cosmos Hub through the light client above.`
        : s?.status === 'mismatch'
          ? "✗ These don't match what the chains say, so sending is switched off."
          : s || sanity.error
            ? "Couldn't double-check these against the chains just now."
            : 'Double-checking these against the chains…'}
      {/* COPY: contracts check */}
    </p>
  )
}

/** Live health: how far behind Ethereum is, whether the bridge is stuck, and when we last checked. */
function HealthStrip() {
  const health = useHealth()
  const checkedAt = useChangedAt(health.data)
  const now = useWallClock()
  const h = health.data
  if (!h) {
    return (
      <p className="health muted" role="status">
        {health.error ? "Can't reach the chains right now to check on the bridge." : 'Checking on the bridge…'}
      </p>
    )
  }
  const ago = checkedAt === null ? 'just now' : Math.max(0, now - checkedAt) < 60_000 ? 'just now' : `${Math.round((now - checkedAt) / 60_000)} min ago`
  return (
    <>
      <div className="health" aria-label="Bridge health">
        <span className={h.frozen ? 'dot bad' : 'dot ok'} aria-hidden="true" />
        <span>
          <b>{h.frozen ? 'Stuck' : 'Running'}</b>
          {h.frozen ? ": Ethereum has stopped accepting updates from the Hub, so new kids can't cross for now." : '.'}
        </span>
        <span>
          {health.error
            ? "Couldn't check just now, so these numbers may be old."
            : h.stale
              ? 'Ethereum is a long way behind the Hub right now.'
              : `Ethereum is ${aboutMinutes(h.lagMinutes)} behind the Hub`}
          <span className="muted mono"> ({blockNumber(h.lagBlocks)} blocks)</span>
          {/* COPY: health strip */}
        </span>
        <span className="muted heights">
          Hub block <span className="mono">{blockNumber(h.hubHeight)}</span> · Ethereum has seen{' '}
          <span className="mono">{blockNumber(h.clientHeight)}</span>
        </span>
        {!health.error && <span className="muted">checked {ago}</span>}
      </div>
      {!h.frozen && h.lagBlocks > 0 && <UpdateClient />}
    </>
  )
}

// COPY: update-client progress (button labels while a nudge send runs)
const UPDATE_LABEL: Readonly<Record<SendStage, (wallet: string) => string>> = {
  simulating: () => 'Checking…',
  signing: (wallet) => `Check ${wallet}…`,
  broadcasting: () => 'Sending…',
}

/**
 * Same nudge as the crossing screen's "Speed it up" (a small ATOM transfer that relayers watch for), offered
 * here as a general "make Ethereum catch up" action: sends to the connected Ethereum wallet's own address.
 */
function UpdateClient() {
  const { deployment, hubWallet, ethWallet } = useBridge()
  const toast = useToast()
  const [reached, setReached] = useState<SendStage | null>(null)
  const nudge = useNudge({ onStage: setReached })
  const sending = nudge.status === 'pending'
  const walletName = hubWallet.walletName ?? 'your wallet'
  const stage: SendStage | null = sending ? (nudge.stage ?? 'simulating') : null

  if (ethWallet.status !== 'connected' || !ethWallet.address) {
    return (
      <p className="hint">
        <ConnectButton chain="eth" className="btn ghost small">
          Connect Ethereum
        </ConnectButton>{' '}
        to update the light client with a small ATOM transfer.
      </p>
    )
  }
  if (hubWallet.status !== 'connected') {
    return (
      <p className="hint">
        <ConnectButton chain="hub" className="btn ghost small">
          Connect Cosmos Hub
        </ConnectButton>{' '}
        to update the light client with a small ATOM transfer.
      </p>
    )
  }

  const recipient = ethWallet.address
  const onClick = async () => {
    if (sending) return
    setReached(null)
    try {
      const result = await nudge.run(recipient)
      toast({
        tone: 'ok',
        title: 'Sent a speed-up transfer',
        link: { href: `https://explorer.skip.build/?tx_hash=${result.txHash}&chain_id=${deployment.hub.chainId}`, label: 'Track it on Skip Go' },
      })
    } catch {
      // nudge.error has it
    }
  }
  const mightHaveLanded = nudge.error !== null && reached === 'broadcasting' && !errorCopy(nudge.error, { action: 'send' }).safe

  return (
    <div className="speed-up">
      <button type="button" className="btn ghost small" disabled={sending} aria-disabled={sending || undefined} onClick={() => void onClick()}>
        {stage ? UPDATE_LABEL[stage](walletName) : 'Update Client'}
      </button>
      <p className="hint">
        Sends 0.001 ATOM to your own Ethereum address, plus a small network fee. Relayers watch for ATOM transfers
        like this one, so it can help Ethereum catch up sooner. It takes about 5
        minutes after you submit. No guarantees.
        {/* COPY: update-client hint */}
      </p>
      {nudge.error && (
        <>
          <ErrorNote error={nudge.error} action="send" walletName={hubWallet.walletName} onRetry={() => void onClick()} retryLabel="Try again" />
          {mightHaveLanded && <p className="hint">Before trying again, check an explorer in case it went through.</p>}
        </>
      )}
    </div>
  )
}
