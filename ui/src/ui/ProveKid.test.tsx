import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEPLOYMENTS } from '../config/deployments'
import { BridgeError, type ConsensusStateArgs } from '../chain/types'
import type { ProveKidsOptions, SubmitRequestOptions } from '../chain/prove'
import { ProveProgress, useProveFlow, type SelfProving } from './ProveKid'

const fixture = vi.hoisted(() => ({ proveKids: vi.fn(), submitRequest: vi.fn(), toast: vi.fn(), deployment: {} }))
vi.mock('../chain/context', () => ({ useBridge: () => ({ deployment: fixture.deployment, proveKid: fixture }) }))
vi.mock('./Toasts', () => ({ useToast: () => fixture.toast }))
const requestId = `0x${'ab'.repeat(32)}` as const
const cs: ConsensusStateArgs = { timestamp: 123n, root: `0x${'11'.repeat(32)}`, nextValidatorsHash: `0x${'22'.repeat(32)}` }

beforeEach(() => {
  localStorage.clear()
  fixture.deployment = DEPLOYMENTS['reece-test']
  fixture.proveKids.mockReset()
  fixture.submitRequest.mockReset()
  fixture.toast.mockReset()
})
afterEach(() => vi.restoreAllMocks())

async function paidFailure(code: 'Network' | 'UserRejected' = 'Network') {
  fixture.proveKids.mockImplementation((_ids: number[], options: ProveKidsOptions) => {
    options.onPrepared?.(1000n, cs)
    options.onProgress?.({ requestId, fulfillmentStatus: 'assigned' })
    return Promise.reject(new BridgeError(code, 'retryable failure after payment'))
  })
  const hook = renderHook(() => useProveFlow())
  await act(() => hook.result.current.run([1]))
  return hook
}

it.each(['Network', 'UserRejected'] as const)('retains a paid request after %s and resumes its original checkpoint after reload', async (code) => {
  const first = await paidFailure(code)
  expect(first.result.current.saved?.requestId).toBe(requestId)
  first.unmount()
  const key = localStorage.key(0)!
  const saved = JSON.parse(localStorage.getItem(key)!) as SelfProving
  saved.at = Date.now() - 2 * 60 * 60_000 // paid requests do not expire after an hour
  localStorage.setItem(key, JSON.stringify(saved))
  fixture.submitRequest.mockResolvedValue({ txHash: '0x1234' })
  const next = renderHook(() => useProveFlow())
  await act(() => next.result.current.resume())
  expect(fixture.submitRequest).toHaveBeenCalledWith(requestId, expect.objectContaining({ height: 1000n, consensusState: cs }))
  expect(fixture.proveKids).toHaveBeenCalledTimes(1)
  expect(next.result.current.saved).toBeNull()
  expect(localStorage.getItem(key)).toBeNull()
})

it('keeps the saved request when resubmission fails and refuses to overwrite it with another paid request', async () => {
  const { result } = await paidFailure()
  fixture.submitRequest.mockRejectedValue(new BridgeError('Network', 'temporary RPC failure'))
  await act(() => result.current.resume())
  expect(result.current.saved?.requestId).toBe(requestId)
  await act(() => result.current.run([2]))
  expect(fixture.proveKids).toHaveBeenCalledTimes(1)
  expect(result.current.saved?.ids).toEqual([1])
})

it('keeps deployments on the same Hub separate', async () => {
  const first = await paidFailure()
  first.unmount()
  fixture.deployment = { ...DEPLOYMENTS['reece-test'], eth: { ...DEPLOYMENTS['reece-test'].eth, bridge: `0x${'33'.repeat(20)}` } }
  const next = renderHook(() => useProveFlow())
  expect(next.result.current.saved).toBeNull()
})

it('forgets a terminal unfulfillable request so the user can try again', async () => {
  const { result } = await paidFailure()
  fixture.submitRequest.mockImplementation((_id: string, options: SubmitRequestOptions) => {
    options.onProgress?.({ requestId, fulfillmentStatus: 'unfulfillable' })
    return Promise.reject(new BridgeError('Unknown', 'unfulfillable'))
  })
  await act(() => result.current.resume())
  expect(result.current.saved).toBeNull()
})

it('shows the exact maximum and waits for approval before continuing', async () => {
  let approved: boolean | undefined
  fixture.proveKids.mockImplementation(async (_ids: number[], options: ProveKidsOptions) => {
    approved = await options.confirmQuote?.({ maxCost: 338n * 10n ** 15n })
    throw new BridgeError('UserRejected', 'cancelled')
  })
  function Example() {
    const flow = useProveFlow()
    return <><button onClick={() => void flow.run([1])}>Start</button><ProveProgress flow={flow} /></>
  }
  render(<Example />)
  await userEvent.click(screen.getByRole('button', { name: 'Start' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('0.338 PROVE')
  expect(approved).toBeUndefined()
  await userEvent.click(screen.getByRole('button', { name: 'Approve this maximum' }))
  await waitFor(() => expect(approved).toBe(true))
  expect(localStorage.length).toBe(0)
})

it.each(['throws', 'ignores'] as const)('does not start proving when browser storage %s recovery data', async (mode) => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    if (mode === 'throws') throw new DOMException('quota exceeded', 'QuotaExceededError')
  })
  const { result } = renderHook(() => useProveFlow())
  await act(() => result.current.run([1]))
  expect(fixture.proveKids).not.toHaveBeenCalled()
  expect(result.current.failure?.error.message).toContain('could not save proof recovery data')
  expect(result.current.pending).toBe(false)
})

it('requires the original checkpoint to persist before reaching quote approval or a paid request', async () => {
  const setItem = localStorage.setItem.bind(localStorage)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if ((JSON.parse(value) as SelfProving).height) throw new DOMException('quota exceeded', 'QuotaExceededError')
    setItem(key, value)
  })
  const paidRequest = vi.fn()
  fixture.proveKids.mockImplementation((_ids: number[], options: ProveKidsOptions) => {
    options.onPrepared?.(1000n, cs)
    paidRequest()
    return Promise.resolve({ txHash: '0x1234', proved: [1] })
  })
  const { result } = renderHook(() => useProveFlow())
  await act(() => result.current.run([1]))
  expect(paidRequest).not.toHaveBeenCalled()
  expect(result.current.failure?.error.message).toContain('could not save proof recovery data')
})

it('retains an ambiguous paid request across reload and recovers the pasted id without paying again', async () => {
  fixture.proveKids.mockImplementation((_ids: number[], options: ProveKidsOptions) => {
    options.onPrepared?.(1000n, cs)
    options.onRequestSubmitting?.()
    return Promise.reject(new BridgeError('Network', 'RequestProof response was lost'))
  })
  const first = renderHook(() => useProveFlow())
  await act(() => first.result.current.run([1]))
  expect(first.result.current.saved).toMatchObject({ requestMayBeSubmitted: true, height: '1000' })
  first.unmount()
  const key = localStorage.key(0)!
  const saved = JSON.parse(localStorage.getItem(key)!) as SelfProving
  localStorage.setItem(key, JSON.stringify({ ...saved, at: Date.now() - 2 * 60 * 60_000 }))
  const next = renderHook(() => useProveFlow())
  await act(() => next.result.current.run([2]))
  await act(() => next.result.current.resume())
  expect(fixture.proveKids).toHaveBeenCalledTimes(1)
  expect(fixture.submitRequest).not.toHaveBeenCalled()
  fixture.submitRequest.mockResolvedValue({ txHash: '0x1234' })
  await act(() => next.result.current.resume(requestId))
  expect(fixture.submitRequest).toHaveBeenCalledWith(requestId, expect.objectContaining({ height: 1000n, consensusState: cs }))
  expect(next.result.current.saved).toBeNull()
})

it('clears a signing rejection before a paid request leaves the browser', async () => {
  fixture.proveKids.mockImplementation((_ids: number[], options: ProveKidsOptions) => {
    options.onPrepared?.(1000n, cs)
    return Promise.reject(new BridgeError('UserRejected', 'declined signature'))
  })
  const { result } = renderHook(() => useProveFlow())
  await act(() => result.current.run([1]))
  expect(result.current.saved).toBeNull()
  expect(localStorage.length).toBe(0)
})

it.each([false, true])('does not submit after navigation or erase a newer attempt (new attempt: %s)', async (newAttempt) => {
  let continueSigning: (() => void) | undefined
  const paidRequest = vi.fn()
  fixture.proveKids.mockImplementation(async (_ids: number[], options: ProveKidsOptions) => {
    options.onPrepared?.(1000n, cs)
    await new Promise<void>((resolve) => { continueSigning = resolve })
    options.onRequestSubmitting?.()
    paidRequest()
    return { txHash: '0x1234', proved: [1] }
  })
  const hook = renderHook(() => useProveFlow())
  let run: Promise<void> | undefined
  act(() => { run = hook.result.current.run([1]) })
  hook.unmount()
  const key = localStorage.key(0)!
  const saved = JSON.parse(localStorage.getItem(key)!) as SelfProving
  if (newAttempt) localStorage.setItem(key, JSON.stringify({ ...saved, attemptId: 'new-attempt', requestMayBeSubmitted: true, ids: [2] }))
  continueSigning?.()
  await act(async () => { await run })
  expect(paidRequest).not.toHaveBeenCalled()
  if (newAttempt) expect(JSON.parse(localStorage.getItem(key)!) as SelfProving).toMatchObject({ attemptId: 'new-attempt', ids: [2] })
  else expect(localStorage.length).toBe(0)
})

it('offers pasted-id recovery when Succinct accepted a request but its response was lost', async () => {
  fixture.proveKids.mockImplementation((_ids: number[], options: ProveKidsOptions) => {
    options.onPrepared?.(1000n, cs)
    options.onRequestSubmitting?.()
    return Promise.reject(new BridgeError('Network', 'reply lost'))
  })
  fixture.submitRequest.mockResolvedValue({ txHash: '0x1234' })
  function Example() {
    const flow = useProveFlow()
    return <><button onClick={() => void flow.run([1])}>Start</button><ProveProgress flow={flow} /></>
  }
  render(<Example />)
  await userEvent.click(screen.getByRole('button', { name: 'Start' }))
  expect(screen.getByRole('status')).toHaveTextContent('before paying again')
  const resume = screen.getByRole('button', { name: 'Resume this proof' })
  expect(resume).toBeDisabled()
  await userEvent.type(screen.getByRole('textbox', { name: 'Request id or explorer link' }), `https://explorer.succinct.xyz/request/${requestId}`)
  await userEvent.click(resume)
  expect(fixture.submitRequest).toHaveBeenCalledWith(requestId, expect.objectContaining({ height: 1000n, consensusState: cs }))
  expect(fixture.proveKids).toHaveBeenCalledTimes(1)
})
