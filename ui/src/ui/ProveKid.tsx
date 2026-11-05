import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { useBridge } from '../chain/context'
import { PROVE_NEEDED, type ProveStage } from '../chain/prove'
import { isLive, type Deployment } from '../config/deployments'
import type { ProofQuote, ProofRequestProgress } from '../chain/succinct/client'
import { BridgeError, type EthAddress, type KidId } from '../chain/types'
import { formatUnits, type Hex } from 'viem'
import { ConnectButton } from './Connect'
import { ErrorNote } from './ErrorNote'
import { ExtLink } from './ExtLink'
import { GetProveButton } from './GetProve'
import { clockTime, kidList } from './format'
import { Sheet } from './Sheet'
import { useToast, type Toast } from './Toasts'

// Mirrors Claim.tsx's useClaimFlow/ClaimButton pattern, for the browser-only "prove my own kids" flow
// (issue #8): own kids only, any number of them together in one batch, same wallet that would eventually
// submitBatch it.

/** Succinct's explorer page for one proof request. */
const PROVE_REQUEST_URL = 'https://explorer.succinct.xyz/request'

// COPY: live Succinct request status
const REQUEST_STATUS_LABEL: Readonly<Record<ProofRequestProgress['fulfillmentStatus'], string>> = {
  requested: 'Waiting for a prover to pick it up',
  assigned: 'A prover is working on it',
  fulfilled: 'Proof ready',
  unfulfillable: 'No prover could fulfill it',
}

/** Live status of the running Succinct proof request, with a link to watch it on their explorer. */
export function ProveProgress({ flow }: { flow: ProveFlow }) {
  const [recoveryLink, setRecoveryLink] = useState('')
  const recoveryInput = useId()
  if (flow.quote) {
    return (
      <Sheet open onClose={() => flow.confirmQuote(false)} title="Confirm proof cost">
        <p>This proof can spend up to <b>{formatUnits(flow.quote.maxCost, 18)} PROVE</b> from your Succinct account.</p>
        <p className="hint">Submitting it to Ethereum later also needs a network fee. Cancelling here spends nothing.</p>
        <button type="button" className="btn eth" onClick={() => flow.confirmQuote(true)}>Approve this maximum</button>
      </Sheet>
    )
  }
  const request = flow.request
  if (!flow.pending && flow.saved) {
    const { at, requestId } = flow.saved
    if (flow.saved.requestMayBeSubmitted && !requestId) {
      const recoveredId = parseRequestId(recoveryLink)
      return (
        <div className="hint" role="status">
          <p>Succinct may have received your paid request, but its reply was lost. Check your wallet’s requests on <ExtLink href="https://explorer.succinct.xyz">Succinct</ExtLink> before paying again.</p>
          <label htmlFor={recoveryInput}>Request id or explorer link</label>
          <div className="lookup">
            <input id={recoveryInput} value={recoveryLink} onChange={(e) => setRecoveryLink(e.target.value)} autoComplete="off" spellCheck={false} />
            <button type="button" className="btn eth ghost small" disabled={!recoveredId} onClick={() => recoveredId && void flow.resume(recoveredId)}>Resume this proof</button>
          </div>
          <button type="button" className="btn ghost small" onClick={flow.clearUnknownRequest}>I checked Succinct: no request was created</button>
        </div>
      )
    }
    return (
      <p className="hint" role="status">
        Proof started at {clockTime(new Date(at), new Date())}.{' '}
        <button type="button" className="btn eth ghost small" onClick={() => void flow.resume()}>Resume proving</button>{' '}
        {requestId && <ExtLink href={`${PROVE_REQUEST_URL}/${requestId}`}>Watch on Succinct</ExtLink>}
      </p>
    )
  }
  if (!flow.pending || !request) return null
  return (
    <p className="hint">
      {REQUEST_STATUS_LABEL[request.fulfillmentStatus]}.{' '}
      <ExtLink href={`${PROVE_REQUEST_URL}/${request.requestId}`}>Watch on Succinct</ExtLink>
    </p>
  )
}

/** The toast once one or more kids' proofs land on Ethereum. `ids` is whichever ones actually made it into
 * the batch (see ProveKidsResult.proved) — can be fewer than what was asked for. */
export function provenToast(ids: readonly KidId[]): Toast {
  return {
    tone: 'ok',
    title: `Proved ${ids.length > 3 ? `${ids.length} kids` : kidList(ids)}`,
    body: 'The proof landed on Ethereum. It can be claimed now.',
  }
}

const SELF_PROVING_KEY = (d: Deployment) =>
  `bad-bridge:self-proving:${d.id}:${d.hub.chainId}:${d.hub.escrow}:${d.eth.chainId}:${d.eth.bridge?.toLowerCase()}`
/** An attempt without a paid request may expire; paid requests stay recoverable. */
const SELF_PROVING_TTL_MS = 60 * 60_000

/** A "Prove it" that was started and hasn't finished. Survives a reload. */
export interface SelfProving {
  /** Prevent an old page's cancelled run from clearing a newer attempt. */
  attemptId?: string
  ids: readonly KidId[]
  at: number
  /** Known once Succinct has taken the request; lets a reload pick it up instead of paying again. */
  requestId?: Hex
  /** The request may have been accepted even if its response never reached this browser. */
  requestMayBeSubmitted?: boolean
  height?: string
  consensusState?: { timestamp: string; root: Hex; nextValidatorsHash: Hex }
}

function loadSelfProving(deployment: Deployment): SelfProving | null {
  try {
    const raw = window.localStorage.getItem(SELF_PROVING_KEY(deployment))
    const v = raw ? (JSON.parse(raw) as Partial<SelfProving>) : null
    if (!v || !Array.isArray(v.ids) || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at <= 0) return null
    const ids = v.ids.filter((n): n is KidId => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff)
    if (ids.length === 0) return null
    const requestId = typeof v.requestId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.requestId) ? v.requestId : null
    const requestMayBeSubmitted = v.requestMayBeSubmitted === true
    if (!requestId && !requestMayBeSubmitted && Date.now() - v.at >= SELF_PROVING_TTL_MS) return null
    const cs = v.consensusState
    const hasCheckpoint = typeof v.height === 'string' && /^[1-9]\d{0,19}$/.test(v.height)
      && cs && typeof cs.timestamp === 'string' && /^\d{1,39}$/.test(cs.timestamp)
      && typeof cs.root === 'string' && /^0x[0-9a-fA-F]{64}$/.test(cs.root)
      && typeof cs.nextValidatorsHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(cs.nextValidatorsHash)
    if ((requestId || requestMayBeSubmitted) && !hasCheckpoint) return null
    return { ids, at: v.at, ...(typeof v.attemptId === 'string' && { attemptId: v.attemptId }), ...(requestId && { requestId }), ...(requestMayBeSubmitted && { requestMayBeSubmitted }), ...(hasCheckpoint && { height: v.height, consensusState: cs }) }
  } catch {
    return null
  }
}

function saveSelfProving(deployment: Deployment, value: SelfProving | null): void {
  try {
    const key = SELF_PROVING_KEY(deployment)
    const encoded = value ? JSON.stringify(value) : null
    if (encoded) window.localStorage.setItem(key, encoded)
    else window.localStorage.removeItem(key)
    if (window.localStorage.getItem(key) !== encoded) throw new Error('storage did not retain proof recovery data')
  } catch (cause) {
    throw new BridgeError('Unknown', 'This browser could not save proof recovery data. Enable site storage before requesting a paid proof.', { cause })
  }
}

export interface ProveFlow {
  run: (ids: readonly KidId[], expectedRecipients?: ReadonlyMap<KidId, EthAddress>) => Promise<void>
  pending: boolean
  /** The kids the running (or last) prove batch was asked for. */
  proving: readonly KidId[]
  stage: ProveStage | null
  /** The Succinct request while proving, with the network's own status for it. */
  request: ProofRequestProgress | null
  failure: { error: BridgeError; ids: readonly KidId[] } | null
  /** Started earlier (maybe before a reload) and not finished. */
  saved: SelfProving | null
  quote: ProofQuote | null
  confirmQuote: (accepted: boolean) => void
  /** A pasted id recovers an accepted request whose response was lost. */
  resume: (requestId?: Hex) => Promise<void>
  clearUnknownRequest: () => void
}

// COPY: prove-my-kids progress (button label and status line)
const STAGE_LABEL: Readonly<Record<ProveStage, string>> = {
  'finding-proof': 'Finding the proof…',
  'uploading-stdin': 'Uploading…',
  'requesting-proof': 'Requesting a proof…',
  proving: 'Proving…',
  signing: 'Check your wallet…',
  confirming: 'Submitting…',
}

/** `onProved` runs after a batch lands, so the page can re-read where the kids are now. */
export function useProveFlow(onProved?: () => void): ProveFlow {
  const { proveKid, deployment } = useBridge()
  const toast = useToast()
  const [saved, setSaved] = useState<SelfProving | null>(() => loadSelfProving(deployment))
  const [proving, setProving] = useState<readonly KidId[]>([])
  const [stage, setStage] = useState<ProveStage | null>(null)
  const [request, setRequest] = useState<ProofRequestProgress | null>(null)
  const [failure, setFailure] = useState<ProveFlow['failure']>(null)
  const [quote, setQuote] = useState<ProofQuote | null>(null)
  const quoteReply = useRef<((accepted: boolean) => void) | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; quoteReply.current?.(false) }
  }, [])

  const confirmQuote = (accepted: boolean) => {
    quoteReply.current?.(accepted)
    quoteReply.current = null
    setQuote(null)
  }
  const mark = (next: SelfProving | null) => {
    saveSelfProving(deployment, next)
    setSaved(next)
  }
  const clearAttempt = (attempt: SelfProving) => {
    if (loadSelfProving(deployment)?.attemptId !== attempt.attemptId) return
    mark(null)
  }
  const finish = () => {
    running.current = false
    setProving([])
    setStage(null)
    setRequest(null)
  }

  const run = async (ids: readonly KidId[], expectedRecipients?: ReadonlyMap<KidId, EthAddress>) => {
    if (!proveKid || ids.length === 0 || running.current) return
    const previous = loadSelfProving(deployment) ?? saved
    if (previous?.requestId || previous?.requestMayBeSubmitted) {
      setSaved(previous)
      setFailure({ error: new BridgeError('Unknown', 'resume the saved proof before starting another paid request'), ids })
      return
    }
    running.current = true
    setProving(ids)
    setStage(null)
    setRequest(null)
    setFailure(null)
    const started: SelfProving = { attemptId: crypto.randomUUID(), ids, at: Date.now() }
    let unfulfillable = false
    try {
      mark(started)
      const result = await proveKid.proveKids(ids, {
        expectedRecipients,
        onStage: setStage,
        confirmQuote: (next) => !mounted.current ? Promise.resolve(false) : new Promise((resolve) => {
          quoteReply.current = resolve
          setQuote(next)
        }),
        onPrepared: (height, cs) => {
          if (!mounted.current) throw new BridgeError('UserRejected', 'the proving page was closed before submission')
          started.height = height.toString()
          started.consensusState = { ...cs, timestamp: cs.timestamp.toString() }
          mark({ ...started })
        },
        onRequestSubmitting: () => {
          if (!mounted.current) throw new BridgeError('UserRejected', 'the proving page was closed before submission')
          // Mark before the HTTP call: losing its response must not authorize a second purchase.
          mark({ ...started, requestMayBeSubmitted: true })
          started.requestMayBeSubmitted = true
        },
        onProgress: (p) => {
          setRequest(p)
          unfulfillable = p.fulfillmentStatus === 'unfulfillable'
          if (p.requestId !== started.requestId) {
            started.requestId = p.requestId
            mark({ ...started })
          }
        },
      })
      clearAttempt(started)
      toast(provenToast(result.proved))
      onProved?.()
    } catch (e) {
      setFailure({ error: e as BridgeError, ids })
      if ((!started.requestId && !started.requestMayBeSubmitted) || unfulfillable) {
        try { clearAttempt(started) } catch { /* No paid request remains; retain the original storage error. */ }
      } else {
        // Keep the id visible even if storage became unavailable after Succinct accepted it.
        setSaved({ ...started })
      }
    } finally {
      finish()
    }
  }

  const resume = async (recoveredId?: Hex) => {
    if (!proveKid || !saved || running.current) return
    const { ids, height, consensusState } = saved
    const requestId = saved.requestId ?? recoveredId
    if (!requestId) {
      if (!saved.requestMayBeSubmitted) return run(ids)
      return
    }
    if (!height || !consensusState) return
    running.current = true
    setProving(ids)
    setStage(null)
    setRequest(null)
    setFailure(null)
    let unfulfillable = false
    try {
      mark({ ...saved, requestId })
      const { txHash } = await proveKid.submitRequest(requestId, {
        height: BigInt(height), consensusState: { ...consensusState, timestamp: BigInt(consensusState.timestamp) },
        onStage: setStage,
        onProgress: (p) => {
          setRequest(p)
          unfulfillable = p.fulfillmentStatus === 'unfulfillable'
        },
      })
      clearAttempt(saved)
      toast({ tone: 'ok', title: 'Proof submitted', body: `The proof landed on Ethereum (${txHash.slice(0, 10)}…). Ready kids can be claimed now.` })
      onProved?.()
    } catch (e) {
      setFailure({ error: e as BridgeError, ids })
      if (unfulfillable) {
        try { clearAttempt(saved) } catch { /* Keep recovery data if storage cannot clear it. */ }
      }
    } finally {
      finish()
    }
  }
  const clearUnknownRequest = () => {
    if (!saved || saved.requestId || running.current) return
    try { clearAttempt(saved); setFailure(null) } catch (e) { setFailure({ error: e as BridgeError, ids: saved.ids }) }
  }
  return { run, pending: proving.length > 0, proving, stage, request, failure, saved, quote, confirmQuote, resume, clearUnknownRequest }
}

const REQUEST_ID_RE = /0x[0-9a-fA-F]{64}/

/** Pulls a request id out of whatever was pasted: the bare id, or Succinct's explorer URL for it. */
export function parseRequestId(input: string): Hex | null {
  const m = REQUEST_ID_RE.exec(input)
  return m ? (m[0].toLowerCase() as Hex) : null
}

/**
 * For a proof that was requested but never submitted (e.g. the page was reloaded while proving): paste its
 * Succinct request id and this waits for it, then submits it. Hub height is only needed when Ethereum's client
 * has moved on since the proof was made.
 */
export function ResumeProof({ onProved }: { onProved?: () => void }) {
  const { proveKid } = useBridge()
  const toast = useToast()
  const idInput = useId()
  const heightInput = useId()
  const [value, setValue] = useState('')
  const [height, setHeight] = useState('')
  const [stage, setStage] = useState<ProveStage | null>(null)
  const [request, setRequest] = useState<ProofRequestProgress | null>(null)
  const [error, setError] = useState<BridgeError | null>(null)
  const [pending, setPending] = useState(false)
  if (!proveKid) return null

  const requestId = parseRequestId(value)
  const heightNum = height.trim() === '' ? undefined : /^\d+$/.test(height.trim()) ? BigInt(height.trim()) : null
  const bad = value.trim() !== '' && !requestId
  const onSubmit = async () => {
    if (!requestId || heightNum === null || pending) return
    setPending(true)
    setError(null)
    setRequest(null)
    try {
      const { txHash } = await proveKid.submitRequest(requestId, { height: heightNum, onStage: setStage, onProgress: setRequest })
      toast({ tone: 'ok', title: 'Proof submitted', body: `The proof landed on Ethereum (${txHash.slice(0, 10)}…). Ready kids can be claimed now.` })
      setValue('')
      onProved?.()
    } catch (e) {
      setError(e as BridgeError)
    } finally {
      setPending(false)
      setStage(null)
    }
  }
  return (
    <details className="hint">
      <summary>Advanced: submit a proof you already requested</summary>
      <div className="lookup">
        <label className="hint full" htmlFor={idInput}>
          Succinct request id or explorer link
        </label>
        <input
          id={idInput}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… or https://explorer.succinct.xyz/request/0x…"
          aria-invalid={bad}
        />
        <label className="hint full" htmlFor={heightInput}>
          Hub height (optional, only if Ethereum's client has moved past it)
        </label>
        <input id={heightInput} type="text" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} autoComplete="off" />
        <button
          type="button"
          className="btn eth ghost"
          disabled={!requestId || heightNum === null}
          aria-disabled={pending || undefined}
          onClick={() => void onSubmit()}
        >
          {pending && stage ? STAGE_LABEL[stage] : 'Submit this proof'}
        </button>
      </div>
      {bad && (
        <p className="hint bad" role="alert">
          That doesn't look like a request id. It's 0x followed by 64 hex characters.
        </p>
      )}
      {pending && request && (
        <p className="hint">
          {REQUEST_STATUS_LABEL[request.fulfillmentStatus]}.{' '}
          <ExtLink href={`${PROVE_REQUEST_URL}/${request.requestId}`}>Watch on Succinct</ExtLink>
        </p>
      )}
      {error && <ErrorNote error={error} action="prove" />}
    </details>
  )
}

/**
 * The connected wallet's PROVE balance on Succinct's network, read once per wallet (see
 * chain/prove.ts's proveBalance — no signature needed). `null` while loading, not yet fetched, or the read
 * failed; failures aren't surfaced here since this is only ever used for an optional "you might need PROVE"
 * hint, not something to block on.
 */
function useProveBalance(): bigint | null {
  const { proveKid } = useBridge()
  const [wei, setWei] = useState<bigint | null>(null)
  useEffect(() => {
    if (!proveKid) return
    let cancelled = false
    proveKid
      .proveBalance()
      .then((w) => {
        if (!cancelled) setWei(w)
      })
      .catch(() => {
        if (!cancelled) setWei(null)
      })
    return () => {
      cancelled = true
    }
  }, [proveKid])
  // Derived, not reset in the effect: no wallet (or a wallet whose fetch hasn't resolved yet) reads as null.
  return proveKid ? wei : null
}

/**
 * "You'll need a bit of $PROVE" — shown once the connected wallet's Succinct network balance reads back as
 * exactly zero (not while it's still loading, and not on a failed read: both are `null`, so this stays quiet
 * rather than risk a false alarm before someone's even tried proving anything).
 */
export function ProveBalanceNote() {
  const balance = useProveBalance()
  if (balance !== 0n) return null
  return (
    <p className="hint">
      Proving costs a little $PROVE on Succinct's network — looks like this wallet doesn't have any yet.{' '}
      <GetProveButton />
    </p>
  )
}

/** The "Prove it" button for one or more kids whose proof hasn't landed yet, batched into one proof and one
 * submitBatch tx. It's the only way a kid gets proven. Without a wallet it opens the connect sheet. */
export function ProveButton({
  ids,
  expectedRecipients,
  flow,
  children,
}: {
  ids: readonly KidId[]
  /** Per-id, checked against the Hub's own record before proving (see chain/prove.ts). */
  expectedRecipients?: ReadonlyMap<KidId, EthAddress>
  flow: ProveFlow
  children: string
}) {
  const { ethWallet, proveKid } = useBridge()
  // finds this button again after a connect, even if the list around it re-rendered from scratch
  const key = ids.join(' ')
  if (!proveKid) {
    return (
      <ConnectButton chain="eth" className="btn eth ghost" focusAfter={() => document.querySelector<HTMLElement>(`[data-prove="${key}"]`)}>
        {children}
      </ConnectButton>
    )
  }
  const mine = ids.some((id) => flow.proving.includes(id))
  const saved = flow.saved !== null && ids.some((id) => flow.saved?.ids.includes(id))
  return (
    <button
      type="button"
      className="btn eth ghost"
      data-prove={key}
      disabled={ethWallet.wrongChain === true}
      aria-disabled={flow.pending || undefined}
      onClick={() => {
        if (flow.pending) return
        if (saved) void flow.resume()
        else void flow.run(ids, expectedRecipients)
      }}
    >
      {mine && flow.stage ? STAGE_LABEL[flow.stage] : saved ? 'Resume proving' : children}
    </button>
  )
}

interface RegisterFlow {
  run: () => Promise<void>
  status: 'idle' | 'pending' | 'success' | 'error'
  error: BridgeError | null
}

function useRegisterFlow(): RegisterFlow {
  const { proveKid } = useBridge()
  const [status, setStatus] = useState<RegisterFlow['status']>('idle')
  const [error, setError] = useState<BridgeError | null>(null)

  const run = async () => {
    if (!proveKid || status === 'pending') return
    setStatus('pending')
    setError(null)
    try {
      await proveKid.registerProgram()
      setStatus('success')
    } catch (e) {
      setError(e as BridgeError)
      setStatus('error')
    }
  }
  return { run, status, error }
}

/** The one-click "register the prover" modal for ProgramNotRegistered — anyone can do this, it's a one-time
 * setup step, not gated to whoever built the program. */
function RegisterProgramModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ethWallet } = useBridge()
  const register = useRegisterFlow()
  return (
    <Sheet open={open} onClose={onClose} title="One-time setup needed">
      <p className="lede">
        This prover isn't registered on Succinct's network yet — a one-time step before anyone can request a
        proof from it. Anyone can register it; it doesn't have to be whoever built it.
        {/* COPY: register-program modal */}
      </p>
      {register.status === 'success' ? (
        <p className="hint">Registered. Close this and try "Prove it" again.</p>
      ) : (
        <>
          <button type="button" className="btn eth" disabled={register.status === 'pending'} onClick={() => void register.run()}>
            {register.status === 'pending' ? 'Registering…' : 'Register it'}
          </button>
          {register.error && <ErrorNote error={register.error} action="prove" walletName={ethWallet.walletName} onRetry={() => void register.run()} />}
        </>
      )}
    </Sheet>
  )
}

/**
 * A prove failure, shown the right way for what went wrong: ProgramNotRegistered gets the one-click register
 * modal (auto-opens; reopens on a fresh failure even if the last one was dismissed), anything else gets a
 * plain ErrorNote.
 */
export function ProveFailure({ flow }: { flow: ProveFlow }) {
  const { ethWallet } = useBridge()
  const failure = flow.failure
  const notRegistered = failure?.error.code === 'ProgramNotRegistered'
  const [dismissed, setDismissed] = useState(false)
  const [lastFailure, setLastFailure] = useState(failure)

  // a fresh failure (even the same code) should reopen the modal, not stay dismissed from last time — adjusted
  // during render (React's own pattern for this), not in an effect, so it takes effect in the same commit
  if (failure !== lastFailure) {
    setLastFailure(failure)
    if (notRegistered) setDismissed(false)
  }

  if (!failure) return null
  const short = /insufficient balance ([\d.]+) PROVE for request cost ([\d.]+) PROVE/i.exec(failure.error.detail ?? '')
  if (short || /insufficient balance/i.test(failure.error.detail ?? '')) {
    return (
      <div className="warn" role="alert">
        <div>
          <b>Not enough PROVE</b>
          {short
            ? `This proof costs ${short[2]} PROVE and your Succinct account has ${short[1]}. `
            : "Your Succinct account doesn't have enough PROVE for this proof. "}
          Deposit some, then try again.{' '}
          <GetProveButton className="btn eth small">Get PROVE</GetProveButton>
          {/* COPY: not enough PROVE at prove time */}
        </div>
      </div>
    )
  }
  if (notRegistered) return <RegisterProgramModal open={!dismissed} onClose={() => setDismissed(true)} />
  return (
    <ErrorNote
      error={failure.error}
      action="prove"
      walletName={ethWallet.walletName}
      tokenId={failure.ids.length === 1 ? failure.ids[0] : undefined}
    />
  )
}

export type ProveReady =
  | { status: 'skip' }
  | { status: 'connect' }
  | { status: 'loading' }
  | { status: 'short'; balance: bigint; inWallet: bigint; refetch: () => void }
  | { status: 'ok'; balance: bigint }

/**
 * Whether the connected Ethereum wallet has enough PROVE in its Succinct account to pay for a proof. 'skip'
 * where there is nothing to prove against (the demo, or a deployment with no bridge yet).
 */
export function useProveReady(): ProveReady {
  const { deployment, proveKid, ethWallet } = useBridge()
  const address = ethWallet.status === 'connected' ? ethWallet.address : undefined
  const q = useQuery({
    queryKey: ['prove-ready', address],
    enabled: Boolean(proveKid && address),
    queryFn: async () => {
      const kid = proveKid as NonNullable<typeof proveKid>
      const [network, inWallet] = await Promise.all([kid.proveBalance(), kid.walletProveBalance().catch(() => 0n)])
      return { network, inWallet }
    },
    refetchInterval: 30_000,
  })
  if (deployment.demo || !isLive(deployment)) return { status: 'skip' }
  if (!proveKid || !address) return { status: 'connect' }
  if (q.data === undefined) return { status: 'loading' }
  if (q.data.network >= PROVE_NEEDED) return { status: 'ok', balance: q.data.network }
  return { status: 'short', balance: q.data.network, inWallet: q.data.inWallet, refetch: () => void q.refetch() }
}
