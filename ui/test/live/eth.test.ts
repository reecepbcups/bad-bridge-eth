// Read-only mainnet checks of the Ethereum adapter against reece-test: #2 and #3 bridged, #1 still on the Hub.

import { fromBech32 } from '@cosmjs/encoding'
import { bytesToHex, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { createEthReader, KID_STATUS_CHUNK } from '../../src/chain/eth/reader'
import { createHubReader } from '../../src/chain/hub'
import { DEPLOYMENTS } from '../../src/config/deployments'
import { readSendSanity } from '../../src/trips/sanity'

const d = DEPLOYMENTS['reece-test']
const reader = createEthReader(d)
const hub = createHubReader(d)
// bridged #2 and #3 to itself. An EIP-7702-delegated EOA, so it has code but isn't a contract.
const REECE = getAddress('0xd2c392084761cb6e44c544b6f39dcc001fde9775')
// the block the #3 send landed in on the Hub
const SEND_HEIGHT_3 = 33_092_463

describe('eth reader on mainnet (reece-test)', () => {
  it('kidStatus: #2 and #3 proven and minted to Reece, #1 untouched', async () => {
    const status = await reader.kidStatus([1, 2, 3])
    expect(status.get(1)).toEqual({ proven: null, owner: null })
    expect(status.get(2)).toEqual({ proven: REECE, owner: REECE })
    expect(status.get(3)).toEqual({ proven: REECE, owner: REECE })
  })

  it('kidStatus: several full multicall chunks in one go', async () => {
    const ids = Array.from({ length: 3 * KID_STATUS_CHUNK }, (_, i) => i + 1)
    const status = await reader.kidStatus(ids)
    expect(status.size).toBe(ids.length)
    const bridged = [...status].filter(([, s]) => s.proven !== null || s.owner !== null).map(([id]) => id)
    expect(bridged).toEqual([2, 3])
  })

  it('client: past the #3 send, not frozen', async () => {
    const client = await reader.client()
    expect(client.latestHeight).toBeGreaterThan(SEND_HEIGHT_3)
    expect(client.frozen).toBe(false)
  })

  it('bridgeEscrow: the bech32-decoded escrow', async () => {
    expect(await reader.bridgeEscrow()).toBe(bytesToHex(fromBech32(d.hub.escrow ?? '').data))
  })

  it('isContract: false for a 7702-delegated EOA, true for the bridge', async () => {
    expect(await reader.isContract(REECE)).toBe(false)
    expect(await reader.isContract(d.eth.bridge ?? '0x')).toBe(true)
  })

  it('bridgeWiring: the pinned Eureka router, client cosmoshub-0, the configured light client, following cosmoshub-4', async () => {
    expect(await reader.bridgeWiring()).toEqual({
      router: '0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7',
      clientId: 'cosmoshub-0',
      lightClient: d.eth.lightClient,
      chainId: 'cosmoshub-4',
    })
  })

  it('the whole startup check passes against mainnet', async () => {
    expect(await readSendSanity(d, hub, reader)).toEqual({ ok: true, status: 'ok', problems: [] })
  })

  it('proxyImplementation: the Eureka router is an upgradeable proxy; the bridge is not', async () => {
    expect(await reader.proxyImplementation(d.eth.router)).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(await reader.proxyImplementation(d.eth.bridge ?? '0x')).toBeNull()
  })

  it('estimateClaim: typical for kids that are already minted, and a live gas price', async () => {
    const one = await reader.estimateClaim([])
    expect(one).toMatchObject({ gas: 79_000, simulated: false })
    expect(BigInt(one.gasPrice)).toBeGreaterThan(0n)
    // #2 is minted, so claim(2) reverts and the estimate falls back
    expect(await reader.estimateClaim([2, 3])).toMatchObject({ gas: 109_000, simulated: false })
  })
})
