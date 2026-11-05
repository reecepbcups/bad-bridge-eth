import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEPLOYMENTS } from '../config/deployments'
import type { EthWriterWithBatch } from './eth/writer'
import { createProveKidWriter } from './prove'

const fixture = vi.hoisted(() => ({ read: vi.fn<(client: unknown, params: { functionName: string }) => Promise<unknown>>(), header: vi.fn(), proof: vi.fn(), wait: vi.fn() }))
vi.mock('viem/actions', async (original) => ({ ...await original<typeof import('viem/actions')>(), readContract: fixture.read }))
vi.mock('./eth/client', () => ({ createEthPublicClient: () => ({}) }))
vi.mock('./hub/prove', async (original) => ({ ...await original<typeof import('./hub/prove')>(), proofHeader: fixture.header, proveAt: fixture.proof }))
vi.mock('./succinct/client', async (original) => ({ ...await original<typeof import('./succinct/client')>(), waitForProof: fixture.wait }))

const cs = { timestamp: 123n, root: `0x${'11'.repeat(32)}` as const, nextValidatorsHash: `0x${'22'.repeat(32)}` as const }
const vk = `0x${'33'.repeat(32)}` as const
const publicValues = encodeAbiParameters(parseAbiParameters('(bytes32 commitmentRoot, (bytes[] path, bytes value)[] kvPairs)'), [{ commitmentRoot: cs.root, kvPairs: [] }])
const decoded = { publicValues, proofBytes: '0x1234' }

beforeEach(() => {
  fixture.read.mockReset().mockImplementation((_client, params) => {
    if (params.functionName === 'lightClient') return Promise.resolve(`0x${'44'.repeat(20)}`)
    if (params.functionName === 'MEMBERSHIP_PROGRAM_VKEY') return Promise.resolve(vk)
    if (params.functionName === 'clientState') return Promise.resolve([0, 0, { revisionHeight: 2000n }, 0, 0, false])
    throw new Error(`unexpected read ${params.functionName}`)
  })
  fixture.header.mockReset().mockResolvedValue({ timestampNs: cs.timestamp, appHash: new Uint8Array(32).fill(0x11), nextValidatorsHash: new Uint8Array(32).fill(0x22) })
  fixture.proof.mockReset().mockResolvedValue({ value: new Uint8Array(20).fill(0x55), merkleProofBytes: new Uint8Array() })
  fixture.wait.mockReset().mockResolvedValue(decoded)
})

it('resumes at the saved checkpoint without reading a newer client height or a pruned Hub header', async () => {
  const submitBatch = vi.fn().mockResolvedValue({ txHash: '0x5678' })
  const writer = createProveKidWriter(DEPLOYMENTS['reece-test'], { submitBatch } as unknown as EthWriterWithBatch)
  await writer.submitRequest(`0x${'aa'.repeat(32)}`, { height: 1000n, consensusState: cs })
  expect(submitBatch).toHaveBeenCalledWith(1000n, cs, { vKey: vk, publicValues, proof: '0x1234' }, expect.anything())
  expect(fixture.header).not.toHaveBeenCalled()
  expect(fixture.read.mock.calls.some(([, p]) => p.functionName === 'clientState')).toBe(false)
})

it('rejects a saved checkpoint whose root differs from the proof before any transaction', async () => {
  const submitBatch = vi.fn()
  const writer = createProveKidWriter(DEPLOYMENTS['reece-test'], { submitBatch } as unknown as EthWriterWithBatch)
  await expect(writer.submitRequest(`0x${'aa'.repeat(32)}`, { height: 1000n, consensusState: { ...cs, root: vk } })).rejects.toThrow('wasn\'t made at Hub height 1000')
  expect(submitBatch).not.toHaveBeenCalled()
})

it('hands the original checkpoint to persistence before requesting a paid proof and forwards quote approval', async () => {
  const onPrepared = vi.fn()
  const confirmQuote = vi.fn().mockResolvedValue(true)
  const requestGroth16Proof = vi.fn().mockImplementation(() => {
    expect(onPrepared).toHaveBeenCalledWith(2000n, cs)
    return Promise.resolve(decoded)
  })
  const submitBatch = vi.fn().mockResolvedValue({ txHash: '0x5678' })
  const writer = createProveKidWriter(DEPLOYMENTS['reece-test'], { requestGroth16Proof, submitBatch } as unknown as EthWriterWithBatch)
  await writer.proveKids([1], { onPrepared, confirmQuote })
  expect(requestGroth16Proof.mock.calls[0]![2]).toMatchObject({ confirmQuote })
})
