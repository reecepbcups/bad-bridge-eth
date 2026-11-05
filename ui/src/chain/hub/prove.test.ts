import { expect, it } from 'vitest'
import { proveAt } from './prove'
import { createTransport } from './transport'

it('tries the archive fallback after the primary returns the captured pruning error', async () => {
  const urls: string[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    urls.push(input instanceof Request ? input.url : input.toString())
    // Captured from Polkachu abci_query at height 10000000, 2026-11-05.
    const response = urls.length === 1
      ? { code: 7, log: 'proof is unexpectedly empty; ensure height has not been pruned: invalid request', value: null, proofOps: null }
      : { code: 0, value: btoa('a'.repeat(20)), proofOps: { ops: [{ data: '' }, { data: '' }] } }
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: { response } }))
  }) as typeof fetch
  const t = createTransport({ rest: [], rpc: ['https://primary.test', 'https://archive.test'] }, { fetch: fetchImpl, retries: 0 })
  expect((await proveAt(t, 10000000, new Uint8Array([0])))?.value).toHaveLength(20)
  expect(urls).toEqual(['https://primary.test', 'https://archive.test'])
})

it('does not retry a genuinely invalid proof query as a node availability problem', async () => {
  let calls = 0
  const fetchImpl = (() => {
    calls++
    return Promise.resolve(Response.json({ result: { response: { code: 18, log: 'invalid key' } } }))
  }) as typeof fetch
  const t = createTransport({ rest: [], rpc: ['https://primary.test', 'https://archive.test'] }, { fetch: fetchImpl, retries: 0 })
  await expect(proveAt(t, 100, new Uint8Array([0]))).rejects.toThrow('invalid key')
  expect(calls).toBe(1)
})
