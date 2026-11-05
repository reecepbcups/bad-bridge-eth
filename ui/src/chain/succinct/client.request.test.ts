import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PROOF_COST, proofQuote, requestGroth16Proof } from './client'
import { MessageReader, MessageWriter } from './wire'

const signatures = vi.hoisted(() => ({ artifact: vi.fn(), request: vi.fn() }))
vi.mock('./sign', () => ({ signCreateArtifact: signatures.artifact, signBytes: signatures.request }))
vi.mock('./zstd', () => ({ zstdCompress: (bytes: Uint8Array) => Promise.resolve(bytes) }))

function response(bytes: Uint8Array): Promise<Response> {
  const frame = new Uint8Array(bytes.length + 5)
  new DataView(frame.buffer).setUint32(1, bytes.length, false)
  frame.set(bytes, 5)
  return Promise.resolve(new Response(frame, { headers: { 'grpc-status': '0' } }))
}

function network(baseFee: string, maxPricePerPgu = '1'): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/GetProgram')) return response(new MessageWriter().message(1, new Uint8Array()).finish())
    if (url.includes('/CreateArtifact')) return response(new MessageWriter().string(1, 's3://test').string(2, 'https://spn-artifacts-mainnet.s3.amazonaws.com/test').finish())
    if (url.includes('/upload?') || url.startsWith('https://spn-artifacts-mainnet.')) return Promise.resolve(new Response(''))
    if (url.includes('/GetNonce')) return response(new MessageWriter().uint64(1, 1n).finish())
    if (url.includes('/GetProofRequestParams')) return response(new MessageWriter().string(5, maxPricePerPgu).string(6, baseFee).finish())
    if (url.includes('/GetProversByUptime')) return response(new Uint8Array())
    if (url.includes('/RequestProof')) return response(new MessageWriter().message(2, new MessageWriter().bytes32(1, new Uint8Array(32).fill(1)).finish()).finish())
    if (url.includes('/GetProofRequestStatus')) return response(new MessageWriter().enum(1, 4).finish())
    throw new Error(`unexpected request ${url}`)
  }
}

const wallet = { account: { address: `0x${'11'.repeat(20)}` } } as Parameters<typeof requestGroth16Proof>[0]['wallet']
const options = { wallet, vkHash: `0x${'22'.repeat(32)}` as const, stdinBytes: new Uint8Array([1]) }

beforeEach(() => {
  signatures.artifact.mockReset().mockResolvedValue(new Uint8Array(65))
  signatures.request.mockReset().mockResolvedValue(new Uint8Array(65))
})

describe('proof spending authorization', () => {
  it('refuses an excessive live quote before showing a confirmation or asking for signatures', async () => {
    const confirmQuote = vi.fn().mockResolvedValue(true)
    await expect(requestGroth16Proof({ ...options, fetchImpl: network('999000000000000000000'), confirmQuote })).rejects.toMatchObject({ code: 'FeeTooHigh' })
    expect(confirmQuote).not.toHaveBeenCalled()
    expect(signatures.artifact).not.toHaveBeenCalled()
    expect(signatures.request).not.toHaveBeenCalled()
  })

  it('bounds the full reservation, including gas, and rejects malformed fees', () => {
    expect(proofQuote(MAX_PROOF_COST.toString(), '0').maxCost).toBe(MAX_PROOF_COST)
    expect(() => proofQuote(MAX_PROOF_COST.toString(), '1')).toThrow('above')
    for (const price of ['-1', '1.5', 'Infinity', '', '9'.repeat(79)]) expect(() => proofQuote('0', price)).toThrow('invalid fee')
  })

  it.each([false, undefined])('does not sign without explicit quote approval (%s)', async (approved) => {
    await expect(requestGroth16Proof({
      ...options, fetchImpl: network('330000000000000000'),
      confirmQuote: approved === undefined ? undefined : () => Promise.resolve(approved),
    })).rejects.toMatchObject({ code: 'UserRejected' })
    expect(signatures.artifact).not.toHaveBeenCalled()
    expect(signatures.request).not.toHaveBeenCalled()
  })

  it('signs exactly the bounded price the user approved', async () => {
    const confirmQuote = vi.fn().mockResolvedValue(true)
    await expect(requestGroth16Proof({ ...options, fetchImpl: network('330000000000000000'), confirmQuote })).rejects.toThrow('unfulfillable')
    expect(confirmQuote).toHaveBeenCalledWith({ maxCost: 330000000010000000n })
    expect(signatures.request).toHaveBeenCalledTimes(1)
    const signed = new MessageReader(signatures.request.mock.calls[0]![1] as Uint8Array)
    expect(signed.string(17)).toBe('330000000000000000')
    expect(signed.string(18)).toBe('1')
    expect(signed.uint64(9)).toBe(10000000n)
  })

  it('persists intent after signing but before submitting, and never submits if persistence fails', async () => {
    const fetchImpl = vi.fn(network('330000000000000000'))
    const onRequestSubmitting = vi.fn(() => {
      expect(signatures.request).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls.some(([input]) => (input instanceof Request ? input.url : input.toString()).includes('/RequestProof'))).toBe(false)
      throw new Error('recovery storage unavailable')
    })
    await expect(requestGroth16Proof({
      ...options, fetchImpl, confirmQuote: () => Promise.resolve(true), onRequestSubmitting,
    })).rejects.toThrow('recovery storage unavailable')
    expect(onRequestSubmitting).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls.some(([input]) => (input instanceof Request ? input.url : input.toString()).includes('/RequestProof'))).toBe(false)
  })
})
