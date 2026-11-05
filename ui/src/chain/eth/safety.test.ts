import { bytesToHex, createPublicClient, encodeAbiParameters, keccak256 } from 'viem'
import { mainnet } from 'viem/chains'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEPLOYMENTS } from '../../config/deployments'
import { proofHeader, type ProofHeader } from '../hub/prove'
import { createEthReader } from './reader'
import { BOB, FakeChain } from './testing/fakeChain'

vi.mock('../hub/prove', () => ({ proofHeader: vi.fn() }))
const now = 1_800_000_000n
let chain: FakeChain
function header(ageSeconds: bigint): ProofHeader {
  const h = { timestampNs: (now - ageSeconds) * 1_000_000_000n, appHash: new Uint8Array(32).fill(1), nextValidatorsHash: new Uint8Array(32).fill(2) }
  chain.consensusHash = keccak256(encodeAbiParameters(
    [{ type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [h.timestampNs, bytesToHex(h.appHash), bytesToHex(h.nextValidatorsHash)],
  ))
  vi.mocked(proofHeader).mockResolvedValue(h)
  return h
}
const reader = () => createEthReader(DEPLOYMENTS['reece-test'], { client: createPublicClient({ chain: mainnet, transport: chain.publicTransport() }) })

beforeEach(() => {
  chain = new FakeChain()
  chain.timestamp = now
  vi.spyOn(Date, 'now').mockReturnValue(Number(now) * 1000)
  vi.mocked(proofHeader).mockReset()
})

describe('send eligibility of the immutable light client', () => {
  it('anchors the timestamp and treats the exact trust-period boundary as expired', async () => {
    header(1_209_599n)
    expect(await reader().clientSafety()).toEqual({ expired: false, frozen: false, retired: false })
    header(1_209_600n)
    expect(await reader().clientSafety()).toEqual({ expired: true, frozen: false, retired: false })
  })

  it('rejects a forged recent Hub timestamp instead of extending the trust period', async () => {
    const h = header(1_209_600n)
    vi.mocked(proofHeader).mockResolvedValue({ ...h, timestampNs: now * 1_000_000_000n })
    await expect(reader().clientSafety()).rejects.toMatchObject({ code: 'Network' })
  })

  it('detects router retirement and freezing without depending on a pruned Hub header', async () => {
    chain.currentClient = BOB
    expect(await reader().clientSafety()).toEqual({ expired: false, frozen: false, retired: true })
    chain.frozen = true
    expect((await reader().clientSafety()).frozen).toBe(true)
    expect(proofHeader).not.toHaveBeenCalled()
  })

  it('does not let a stale Ethereum block extend the trust period', async () => {
    header(1_209_600n)
    chain.timestamp = now - 3_600n
    expect((await reader().clientSafety()).expired).toBe(true)
  })
})
