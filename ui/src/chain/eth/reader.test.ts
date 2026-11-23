import { createPublicClient, decodeFunctionData, getAddress, HttpRequestError, type Hex } from 'viem'
import { mainnet } from 'viem/chains'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEPLOYMENTS, type Deployment } from '../../config/deployments'
import { BridgeError } from '../types'
import { bridgeAbi } from './abi'
import { typicalClaimGas } from './gas'
import { blockscoutClaimTx, blockscoutHeldKids, blockscoutTxStatus, createEthReader, EIP1967_IMPLEMENTATION_SLOT, isContractCode } from './reader'
import { ALICE, BOB, BRIDGE, ESCROW, FAKE_GAS, FakeChain, LIGHT_CLIENT, ROUTER } from './testing/fakeChain'

const deployment = DEPLOYMENTS['reece-test']
const notLive: Deployment = { ...deployment, eth: { ...deployment.eth, bridge: null } }

let chain: FakeChain
const reader = (d: Deployment = deployment, chunkSize?: number) =>
  createEthReader(d, { client: createPublicClient({ chain: mainnet, transport: chain.publicTransport() }), chunkSize })

beforeEach(() => {
  chain = new FakeChain()
})

describe('client', () => {
  it('reads the height and frozen flag through bridge.lightClient()', async () => {
    chain.latestHeight = 33_200_123n
    expect(await reader().client()).toEqual({ latestHeight: 33_200_123, frozen: false })
    chain.frozen = true
    expect(await reader().client()).toEqual({ latestHeight: 33_200_123, frozen: true })
  })
})

describe('kidStatus', () => {
  beforeEach(() => {
    chain.proven.set(2, ALICE).set(3, ALICE).set(4, BOB)
    chain.owners.set(2, ALICE).set(3, BOB)
  })

  it('maps zero proven and nonexistent owners to null, and keys every requested id', async () => {
    const status = await reader().kidStatus([1, 2, 3, 4, 2])
    expect([...status.keys()]).toEqual([1, 2, 3, 4])
    expect(status.get(1)).toEqual({ proven: null, owner: null })
    expect(status.get(2)).toEqual({ proven: ALICE, owner: ALICE })
    // owner can differ from the proven recipient once the kid trades
    expect(status.get(3)).toEqual({ proven: ALICE, owner: BOB })
    expect(status.get(4)).toEqual({ proven: BOB, owner: null })
  })

  it('batches through Multicall3, chunked', async () => {
    const status = await reader(deployment, 2).kidStatus([1, 2, 3, 4, 5])
    expect(status.size).toBe(5)
    expect(chain.publicLog.filter((m) => m === 'eth_call')).toHaveLength(3)
  })

  it('does nothing for no ids', async () => {
    expect((await reader().kidStatus([])).size).toBe(0)
    expect(chain.publicLog).toEqual([])
  })

  it('throws Network when ownerOf fails any other way', async () => {
    chain.brokenOwnerOf.add(2)
    await expect(reader().kidStatus([1, 2])).rejects.toMatchObject({ code: 'Network', tokenId: 2 })
  })

  it('rejects ids that aren\'t u32', async () => {
    for (const id of [-1, 1.5, 2 ** 32, Number.NaN]) {
      await expect(reader().kidStatus([id])).rejects.toMatchObject({ code: 'BadTokenId' })
    }
  })
})

describe('isContract', () => {
  it('is false for empty code and EIP-7702 delegations, true for real code', async () => {
    chain.code.set(ALICE.toLowerCase(), '0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a')
    chain.code.set(BRIDGE.toLowerCase(), '0x6080604052')
    expect(await reader().isContract(BOB)).toBe(false)
    expect(await reader().isContract(ALICE)).toBe(false)
    expect(await reader().isContract(BRIDGE)).toBe(true)
  })

  it('only treats a 23-byte 0xef0100 designator as a delegation', () => {
    expect(isContractCode(undefined)).toBe(false)
    expect(isContractCode('0x')).toBe(false)
    expect(isContractCode('0xEF01008A67B5020EE254EF48E3B6A04927F39BAF7E408A')).toBe(false)
    expect(isContractCode('0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a00')).toBe(true)
    expect(isContractCode('0xef0100')).toBe(true)
  })
})

describe('bridgeEscrow', () => {
  it('returns ESCROW() as lowercase hex', async () => {
    expect(await reader().bridgeEscrow()).toBe(ESCROW)
  })
})

describe('bridgeWiring', () => {
  it('reads ROUTER(), clientId(), lightClient() and the client\'s chain id', async () => {
    expect(await reader().bridgeWiring()).toEqual({ router: ROUTER, clientId: 'cosmoshub-0', lightClient: LIGHT_CLIENT, chainId: 'cosmoshub-4' })
    chain.clientChainId = 'theta-testnet-001'
    chain.clientId = 'cosmoshub-7'
    chain.router = BOB
    expect(await reader().bridgeWiring()).toEqual({ router: BOB, clientId: 'cosmoshub-7', lightClient: LIGHT_CLIENT, chainId: 'theta-testnet-001' })
  })
})

describe('hubClientId', () => {
  it('reads ROUTER().getCounterparty(clientId()).clientId', async () => {
    expect(await reader().hubClientId()).toBe('08-wasm-1369')
    chain.clientId = 'cosmoshub-7'
    chain.counterpartyClientId = '08-wasm-2'
    expect(await reader().hubClientId()).toBe('08-wasm-2')
  })
})

describe('proxyImplementation', () => {
  it('reads the EIP-1967 slot: an address when set, null when empty', async () => {
    expect(await reader().proxyImplementation(ROUTER)).toBeNull()
    chain.storage.set(ROUTER.toLowerCase(), new Map<string, Hex>([[EIP1967_IMPLEMENTATION_SLOT, `0x${'0'.repeat(24)}17fa3a98d0239a399927c7c3ccde142e08deb7b5`]]))
    expect(await reader().proxyImplementation(ROUTER)).toBe(getAddress('0x17fa3a98d0239a399927c7c3ccde142e08deb7b5'))
  })
})

describe('estimateClaim', () => {
  it('simulates when every kid can be claimed: claim() for one, claimMany for several', async () => {
    chain.proven.set(2, ALICE).set(3, BOB)
    chain.gasPrice = 3_000_000_000n
    expect(await reader().estimateClaim([2])).toEqual({ gas: Number(FAKE_GAS), gasPrice: '3000000000', fee: String(FAKE_GAS * 3_000_000_000n), simulated: true })
    expect(chain.estimates.at(-1)?.to.toLowerCase()).toBe(BRIDGE.toLowerCase())
    expect(await reader().estimateClaim([2, 3, 2])).toMatchObject({ gas: Number(FAKE_GAS), simulated: true })
    expect(chain.estimates.at(-1)?.to.toLowerCase()).toBe(BRIDGE.toLowerCase())
    expect(decodeFunctionData({ abi: bridgeAbi, data: chain.estimates.at(-1)!.data }).functionName).toBe('claimMany')
  })

  it('falls back to typical gas when a kid can\'t be claimed now, and prices one kid for an empty list', async () => {
    chain.proven.set(2, ALICE)
    chain.gasPrice = 1_000_000_000n
    // #1 isn't proven, so the strict batch reverts
    expect(await reader().estimateClaim([1, 2])).toEqual({ gas: 109_000, gasPrice: '1000000000', fee: '109000000000000', simulated: false })
    const before = chain.estimates.length
    expect(await reader().estimateClaim([])).toEqual({ gas: 79_000, gasPrice: '1000000000', fee: '79000000000000', simulated: false })
    expect(chain.estimates).toHaveLength(before)
  })

  it('typical gas: 79k for one kid, 30k per extra', () => {
    expect(typicalClaimGas(1)).toBe(79_000n)
    expect(typicalClaimGas(2)).toBe(109_000n)
    expect(typicalClaimGas(50)).toBe(1_549_000n)
  })
})

describe('failures', () => {
  it('throws NotLive for every bridge read when there is no bridge', async () => {
    const r = reader(notLive)
    await expect(r.client()).rejects.toMatchObject({ code: 'NotLive' })
    await expect(r.kidStatus([1])).rejects.toMatchObject({ code: 'NotLive' })
    await expect(r.bridgeEscrow()).rejects.toMatchObject({ code: 'NotLive' })
    await expect(r.bridgeWiring()).rejects.toMatchObject({ code: 'NotLive' })
    await expect(r.estimateClaim([1])).rejects.toMatchObject({ code: 'NotLive' })
    await expect(r.hubClientId()).rejects.toMatchObject({ code: 'NotLive' })
    expect(chain.publicLog).toEqual([])
  })

  it('maps transport failures to Network', async () => {
    chain.publicError = new HttpRequestError({ url: 'https://rpc.example', status: 503, body: {} })
    const r = reader()
    for (const p of [r.client(), r.kidStatus([1]), r.isContract(ALICE), r.bridgeEscrow(), r.bridgeWiring(), r.proxyImplementation(ROUTER), r.estimateClaim([1]), r.hubClientId()]) {
      const err = await p.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BridgeError)
      expect(err).toMatchObject({ code: 'Network' })
    }
  })
})

describe('blockscoutHeldKids', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('follows next_page_params and returns sorted unique ids', async () => {
    const urls: URL[] = []
    const pages = [
      json({ items: [{ id: '1870' }, { id: '7' }], next_page_params: { unique_token: 7, holder_address_hash: ALICE } }),
      json({ items: [{ id: '7' }, { id: '42' }], next_page_params: null }),
    ]
    const fetchFn = ((url: URL) => {
      urls.push(url)
      return Promise.resolve(pages.shift() as Response)
    }) as unknown as typeof fetch
    expect(await blockscoutHeldKids(fetchFn, BRIDGE, ALICE)).toEqual([7, 42, 1870])
    expect(urls[0]?.pathname).toBe(`/api/v2/tokens/${BRIDGE}/instances`)
    expect(urls[0]?.searchParams.get('holder_address_hash')).toBe(ALICE)
    expect(urls[1]?.searchParams.get('unique_token')).toBe('7')
  })

  it.each([
    ['an HTTP error', () => Promise.resolve(json({}, 503))],
    ['a malformed body', () => Promise.resolve(json({ nope: true }))],
    ['a bad token id', () => Promise.resolve(json({ items: [{ id: 'x' }] }))],
    ['a failed fetch', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('turns %s into a Network error', async (_, fetchFn) => {
    await expect(blockscoutHeldKids(fetchFn as unknown as typeof fetch, BRIDGE, ALICE)).rejects.toMatchObject({ code: 'Network' })
  })
})

describe('blockscoutTxStatus', () => {
  const HASH = `0x${'ab'.repeat(32)}` as const
  const reply = (body: unknown, status = 200) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch

  it.each([
    ['ok', 'confirmed'],
    ['error', 'failed'],
  ])('maps %s to %s', async (status, want) => {
    expect(await blockscoutTxStatus(reply({ status }), HASH)).toBe(want)
  })

  it('is a Network error when Blockscout has no answer', async () => {
    await expect(blockscoutTxStatus(reply({ message: 'Not found' }, 404), HASH)).rejects.toMatchObject({ code: 'Network' })
    await expect(blockscoutTxStatus(reply({ status: null }), HASH)).rejects.toMatchObject({ code: 'Network' })
  })
})

describe('blockscoutClaimTx', () => {
  const MINT = `0x${'cd'.repeat(32)}`
  const ZERO = `0x${'0'.repeat(40)}`
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('finds the mint across pages', async () => {
    const pages = [
      json({ items: [{ from: { hash: ALICE }, transaction_hash: `0x${'11'.repeat(32)}` }], next_page_params: { index: 3 } }),
      json({ items: [{ from: { hash: ZERO }, transaction_hash: MINT }], next_page_params: null }),
    ]
    const fetchFn = (() => Promise.resolve(pages.shift() as Response)) as unknown as typeof fetch
    expect(await blockscoutClaimTx(fetchFn, BRIDGE, 7)).toBe(MINT)
  })

  it('is null for an unminted kid', async () => {
    const fetchFn = (() => Promise.resolve(json({ message: 'Not found' }, 404))) as unknown as typeof fetch
    expect(await blockscoutClaimTx(fetchFn, BRIDGE, 7)).toBeNull()
  })

  it('turns an HTTP error into a Network error', async () => {
    const fetchFn = (() => Promise.resolve(json({}, 503))) as unknown as typeof fetch
    await expect(blockscoutClaimTx(fetchFn, BRIDGE, 7)).rejects.toMatchObject({ code: 'Network' })
  })
})
