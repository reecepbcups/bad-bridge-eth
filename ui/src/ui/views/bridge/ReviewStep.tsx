import { useIsMutating } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useBridge } from '../../../chain/context'
import { recipientMsg } from '../../../chain/encode-recipient'
import { checkRecipient, type RecipientCheck } from '../../../chain/eth/recipient'
import { MAX_KIDS_PER_SEND, type EthAddress, type KidId, type SendStage } from '../../../chain/types'
import { sharedHost } from '../../../config/host'
import { navigate } from '../../../router'
import { useConfigSanity, useHealth, useSendEstimate, useSendKids } from '../../../trips/hooks'
import { ConnectButton } from '../../Connect'
import { CostList } from '../../CostList'
import { ErrorNote } from '../../ErrorNote'
import { errorCopy } from '../../errors'
import { formatFee, kidWord } from '../../format'
import { useIsContract } from '../../hooks'
import { KidArt } from '../../KidArt'
import { useToast } from '../../Toasts'
import { useTitle } from '../../useTitle'
import { useFlow } from './flow'
import './review.css'

// COPY: recipient validation lines
const BAD_ADDRESS: Readonly<Record<Exclude<RecipientCheck, { ok: true }>['reason'], string>> = {
  format: "That doesn't look like an Ethereum address (0x + 40 characters).",
  zero: "That's the zero address. Kids sent there are gone forever.",
  checksum: "The capital letters don't match this address's checksum, so there may be a typo. Copy it again from your wallet.",
  burn: "That's a burn or system address, not a wallet. Kids sent there are gone forever.",
}

const CHECKING_SEND = 'Checking the send with the Hub…'

// COPY: shared-host guard
const SHARED_HOST =
  "Sending is off on this web address: it's shared with other sites, and any of them could tamper with this page. Open the bridge from its own address instead."

// COPY: send progress (button labels and the line under them)
/** The Send button while a send runs, from the Hub writer's progress. */
const SEND_LABEL: Readonly<Record<SendStage, (wallet: string) => string>> = {
  simulating: () => 'Checking…',
  signing: (wallet) => `Check ${wallet}…`,
  broadcasting: () => 'Sending…',
}

/** The line under the button while a send runs. */
const SEND_HINT: Readonly<Record<SendStage, (wallet: string) => string>> = {
  simulating: () => CHECKING_SEND,
  signing: (wallet) => `Approve it in ${wallet}. Once signed, it lands on the Hub in a few seconds.`,
  broadcasting: () => 'Signed. Waiting for the Hub to put it in a block…',
}

/** "0x8f3a 41b7 e2D0 …": the whole checksummed address in groups of four, easy to compare by eye. */
export function chunkAddress(address: string): string {
  return `0x${(address.slice(2).match(/.{1,4}/g) ?? []).join(' ')}`
}

export function ReviewStep() {
  const { deployment, hubWallet, ethWallet, hubWriter } = useBridge()
  const { flow, update, restart } = useFlow()
  const toast = useToast()
  const ids = flow.picked
  const n = ids.length
  useTitle('Review and send')

  // recipient: follows the connected Ethereum wallet until the user types, unless that wallet is on another
  // network (a smart-contract wallet there may not exist at the same address on Ethereum)
  const connectedEth = ethWallet.status === 'connected' ? ethWallet.address : undefined
  const wrongChain = connectedEth !== undefined && ethWallet.wrongChain === true
  const autoFill = wrongChain ? undefined : connectedEth
  const input = flow.recipient ?? autoFill ?? ''
  const auto = flow.recipient === null && autoFill !== undefined
  const check = input.trim() ? checkRecipient(input, connectedEth) : null
  const address: EthAddress | null = check?.ok ? check.address : null

  const contract = useIsContract(address)
  const [holdsFor, setHoldsFor] = useState<string | null>(null)
  const canHold = address !== null && holdsFor === address
  // "Got it" is for one address: a different valid address un-ticks it
  const [agreedFor, setAgreedFor] = useState<{ address: EthAddress | null } | null>(null)
  if (agreedFor !== null && address !== null && agreedFor.address !== address) setAgreedFor(null)
  const agreed = agreedFor !== null

  const sanity = useConfigSanity()
  const health = useHealth()
  const estimate = useSendEstimate(ids, address)
  // the furthest the last send got: only a signed send could have landed
  const [reached, setReached] = useState<SendStage | null>(null)
  const send = useSendKids({ onStage: setReached })
  // survives an unmount/remount of this step: a send from before the remount still counts as pending
  const sendMutating = useIsMutating({ mutationKey: ['bridge', deployment.id, 'send'] }) > 0
  const sending = send.status === 'pending' || sendMutating
  const walletName = hubWallet.walletName ?? 'your wallet'
  // null only for the moment before the writer reports its first stage
  const stage: SendStage | null = sending ? (send.stage ?? 'simulating') : null

  // a stale send error shouldn't outlive the inputs it was about; useSendEstimate keys off the same two
  useEffect(() => {
    send.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(','), address])

  const inputId = useId()
  const hintId = useId()
  const whyId = useId()

  const reason = whyDisabled()
  // COPY: why Send is off (new: shared host, the 100-kid cap, stale health, stuck)
  function whyDisabled(): string | null {
    if (sharedHost(window.location)) return SHARED_HOST
    if (!hubWriter) return 'Connect your Cosmos Hub wallet first.'
    if (n === 0) return 'Pick at least one kid.'
    if (n > MAX_KIDS_PER_SEND) return `Send up to ${MAX_KIDS_PER_SEND} at a time. Take some out and send the rest after.`
    const s = sanity.data
    if (!s) return sanity.error ? "Couldn't double-check the bridge contracts, so sending is off for now." : 'Double-checking the bridge contracts…'
    if (s.status === 'not-live' || s.problems.some((p) => p.code === 'NotLive')) return "The bridge isn't open yet."
    if (!s.ok) {
      return s.status === 'unknown' || s.problems.length === 0
        ? "Couldn't double-check the bridge contracts, so sending is off for now."
        : s.problems[0]?.message ?? 'Sending is switched off: a bridge safety check failed (see the note up top).'
    }
    const h = health.data
    if (!h) return health.error ? "Can't reach Ethereum to check the bridge, so sending is off for now." : 'Checking the bridge…'
    // old numbers can't vouch for the light client: wait for a fresh read
    if (health.error) return "Can't reach the chains to check the bridge right now, so sending is off until they answer."
    if (h.frozen) return 'The bridge is stuck for now, so sending is off.'
    if (!check) return 'Add the Ethereum address your kids should land at.'
    if (!check.ok) return 'Fix the Ethereum address first.'
    if (contract.data === undefined) return contract.error ? "Couldn't check the address. Try again." : 'Checking the address…'
    if (contract.data && !canHold) return 'Tick “This address can hold NFTs” to send to a contract.'
    if (!agreed) return 'Tick “Got it, one way only” to send.'
    // an error wins over old data: the latest simulation is the one that counts
    if (estimate.error) return 'The Hub said no to this send (see above).'
    if (!estimate.data) return CHECKING_SEND
    return null
  }

  const onSend = async () => {
    // aria-disabled while sending keeps focus on the button, so the click has to be refused here
    if (reason !== null || sending || !address) return
    setReached(null)
    try {
      const result = await send.run(ids, address)
      restart()
      navigate({ name: 'crossing' })
      toast({
        tone: 'ok',
        title: `Sent! ${n} ${kidWord(n)} on the bridge`,
        link: { href: deployment.explorer.hubTx(result.txHash), label: 'See it on Mintscan' },
      })
    } catch {
      // send.error has it
    }
  }

  const onAgree = (checked: boolean) => {
    if (!checked) return setAgreedFor(null)
    // freeze an auto-filled address, so switching accounts in the wallet can't change where the kids land
    if (auto && address) update({ recipient: address })
    setAgreedFor({ address })
  }

  const unpick = (id: KidId) => {
    update((f) => ({ picked: f.picked.filter((p) => p !== id) }))
    send.reset()
  }

  const blockingError = send.error ?? estimate.error
  const blockingKid = blockingError?.tokenId
  const canUnpick =
    blockingKid !== undefined && ids.includes(blockingKid) && n > 1 && (blockingError?.code === 'AlreadyBridged' || blockingError?.code === 'NotOwner')

  // checking → "Check Keplr…" → sending → the crossing screen
  const label = stage ? SEND_LABEL[stage](walletName) : reason === CHECKING_SEND ? 'Checking…' : `Send ${n} ${kidWord(n)}`
  const mightHaveLanded = send.error !== null && reached === 'broadcasting' && !errorCopy(send.error, { action: 'send' }).safe
  const msg = address ? recipientMsg(address) : null

  return (
    <>
      <h2 tabIndex={-1}>Where do they land?</h2>
      <div className="picked" aria-label="Picked kids">
        {ids.map((id) => (
          <span key={id} className="mini">
            <KidArt id={id} size={44} decorative eager />#{id}
          </span>
        ))}
      </div>

      <div className="field">
        <label htmlFor={inputId}>Ethereum address</label>
        <input
          type="text"
          id={inputId}
          value={input}
          onChange={(e) => update({ recipient: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="0x…"
          aria-invalid={check !== null && !check.ok}
          aria-describedby={hintId}
          disabled={sending}
        />
      </div>
      {address && (
        <div className="recipient-full">
          <p className="chunks">
            <span className="sr-only">Full address: {address}</span>
            <span aria-hidden="true">{chunkAddress(address)}</span>
          </p>
          {msg && (
            <p className="hint">
              <b>Check your wallet:</b> it will show <span className="mono">msg: {msg}</span>
              {n > 1 ? ' for each kid' : ''}. It should match. Look for it in {walletName} on the send, as the msg.
              {/* COPY: wallet msg check */}
            </p>
          )}
        </div>
      )}
      <RecipientHint id={hintId} check={check} auto={auto} connected={connectedEth} walletName={ethWallet.walletName} />
      {!connectedEth && (
        <div className="row start">
          <ConnectButton chain="eth" className="btn ghost small" focusAfter={() => document.getElementById(inputId)}>
            Connect Ethereum to fill it in
          </ConnectButton>
        </div>
      )}

      {wrongChain && flow.recipient === null && (
        <>
          <div className="warn">
            <WarnIcon />
            <div>
              <b>Your wallet is on another network.</b>
              Smart-contract wallets may not exist at the same address on Ethereum.
              {/* COPY: wrong-network recipient warning */}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={false} onChange={(e) => e.target.checked && connectedEth && update({ recipient: connectedEth })} />{' '}
            It's a regular wallet: use the same address on Ethereum
          </label>
        </>
      )}

      {address && contract.data && (
        <>
          <div className="warn">
            <WarnIcon />
            <div>
              <b>That's a contract, not a wallet.</b>
              Some contracts can't hold NFTs, and a kid minted to one could be stuck for good. Only go on if you're sure
              this one can.
              {/* COPY: contract recipient warning */}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={canHold} onChange={(e) => setHoldsFor(e.target.checked ? address : null)} /> This
            address can hold NFTs
          </label>
        </>
      )}
      {address && contract.error && !contract.data && (
        <ErrorNote error={contract.error} action="read" onRetry={contract.refetch} retryLabel="Check the address again" />
      )}

      <CostList />

      <div className="warn">
        <WarnIcon />
        <div>
          <b>No take-backs.</b>
          This bridge only goes one way. Once a kid leaves the Hub, it lives on Ethereum for good. Ethereum kids trade on
          Ethereum, separately from Bad Kids on the Hub and Stargaze.
          {/* COPY: needs sign-off */}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => onAgree(e.target.checked)} /> Got it, one way only
      </label>

      {sanity.error && sanity.data?.ok !== true && (
        <ErrorNote error={sanity.error} action="read" onRetry={sanity.refetch} retryLabel="Check the contracts again" live={false} />
      )}

      {blockingError && (
        <>
          <ErrorNote
            error={blockingError}
            action="send"
            walletName={hubWallet.walletName}
            onRetry={
              canUnpick && blockingKid !== undefined
                ? () => unpick(blockingKid)
                : send.error
                  ? undefined
                  : estimate.refetch
            }
            retryLabel={canUnpick ? `Take #${blockingKid} out` : 'Check again'}
          />
          {mightHaveLanded && (
            <p className="hint">
              Before sending again, check <a href="#/crossing">Crossing</a> in case it went through.
            </p>
          )}
        </>
      )}

      <div className="row">
        <button type="button" className="btn ghost" onClick={() => update({ step: 'pick' })} disabled={sending}>
          ← Back
        </button>
        <button
          type="button"
          className="btn"
          disabled={!sending && reason !== null}
          aria-disabled={sending || undefined}
          aria-describedby={reason ? whyId : undefined}
          onClick={() => void onSend()}
        >
          {label}
        </button>
      </div>
      {reason && !sending ? (
        <p className="hint why" id={whyId}>
          {reason}
        </p>
      ) : (
        <p className="hint" role="status">
          {stage
            ? SEND_HINT[stage](walletName)
            : `${walletName === 'your wallet' ? 'Your wallet' : walletName} asks you to sign once${n === 2 ? ', for both kids' : n > 2 ? `, for all ${n} kids` : ''}.`}
          {estimate.data && !estimate.error && <> ≈ {formatFee(estimate.data)} network fee.</>}
        </p>
      )}
    </>
  )
}

function RecipientHint({
  id,
  check,
  auto,
  connected,
  walletName,
}: {
  id: string
  check: RecipientCheck | null
  auto: boolean
  connected: EthAddress | undefined
  walletName: string | undefined
}) {
  if (!check) {
    return (
      <p className="hint" id={id}>
        {connected ? 'Paste the Ethereum address your kids should land at.' : 'Connect Ethereum to fill this in, or paste any Ethereum address.'}
      </p>
    )
  }
  if (!check.ok) {
    return (
      <p className="hint bad" id={id}>
        {BAD_ADDRESS[check.reason]}
      </p>
    )
  }
  if (check.isConnected) {
    return (
      <p className="hint" id={id}>
        {auto ? `Filled in from ${walletName ?? 'your wallet'}.` : "That's your connected wallet."} The kids get minted to this
        address.
      </p>
    )
  }
  if (connected) {
    return (
      <p className="hint heads-up" id={id}>
        <b>This isn't your connected wallet.</b> Make sure you control it: the kids get minted here and can't come back.
      </p>
    )
  }
  return (
    <p className="hint" id={id}>
      The kids get minted to this address. Make sure you control it.
    </p>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 4 L37 35 L3 35 Z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <path d="M20 15 L20 24 M20 29 L20 30" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  )
}
