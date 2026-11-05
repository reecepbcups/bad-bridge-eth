import { fromHex, toBase64, toUtf8 } from '@cosmjs/encoding'
import {
  QueryContractInfoRequest,
  QueryContractInfoResponse,
  QueryRawContractStateRequest,
  QueryRawContractStateResponse,
  QuerySmartContractStateRequest,
  QuerySmartContractStateResponse,
} from 'cosmjs-types/cosmwasm/wasm/v1/query'
import { describe, expect, it } from 'vitest'
import { isBridgeError, type BridgeErrorCode } from '../types'
import {
  bridgeEvent,
  chainError,
  CW721,
  ESCROW,
  hash,
  json,
  mockFetch,
  RECIPIENT,
  REECE,
  REST,
  restTx,
  RPC_A,
  RPC_B,
  rpcError,
  rpcResult,
  rpcTx,
  sendNftEvent,
  smartContract,
  smartMsg,
  testDeployment,
  TX2,
  type Req,
} from './fixtures'
import { createHubReader } from './reader'

const fast = { retries: 0, sleep: () => Promise.resolve() }

describe('emergency-unlock admin', () => {
  it.each([null, '', toBase64(toUtf8(JSON.stringify(REECE)))])('reads raw admin independently of contract_info (%s)', async (data) => {
    const { hub } = reader(({ url }) => {
      expect(url.pathname).toContain(`/contract/${ESCROW}/raw/YWRtaW4=`)
      return json({ data })
    })
    expect(await hub.escrowAdmin()).toBe(data ? REECE : null)
  })

  it('falls back to the protobuf raw query when REST is unavailable', async () => {
    const { hub } = reader(({ url, body }) => {
      if (url.origin === REST) return new Response('down', { status: 503 })
      const params = (body as { params: { path: string; data: string } }).params
      expect(params.path).toBe('/cosmwasm.wasm.v1.Query/RawContractState')
      const req = QueryRawContractStateRequest.decode(fromHex(params.data))
      expect(req.address).toBe(ESCROW)
      expect(new TextDecoder().decode(req.queryData)).toBe('admin')
      const value = toBase64(QueryRawContractStateResponse.encode({ data: toUtf8(JSON.stringify(REECE)) }).finish())
      return rpcResult({ response: { code: 0, value } })
    })
    expect(await hub.escrowAdmin()).toBe(REECE)
  })

  it('does not mistake malformed stored data for renunciation', async () => {
    const { hub } = reader(() => json({ data: toBase64(toUtf8('null')) }))
    await expect(hub.escrowAdmin()).rejects.toMatchObject({ code: 'Unknown' })
  })
})

function reader(route: (req: Req) => Response | Promise<Response>, overrides = {}) {
  const { fetch, calls } = mockFetch(route)
  return { hub: createHubReader(testDeployment(overrides), { ...fast, fetch }), calls }
}

async function codeOf(p: Promise<unknown>): Promise<BridgeErrorCode | 'resolved'> {
  try {
    await p
    return 'resolved'
  } catch (e) {
    if (!isBridgeError(e)) throw e
    return e.code
  }
}

/** A REST tx search answer for `query`. */
function searchAnswer(req: Req, pages: Record<string, ReturnType<typeof restTx>[]>, total?: number) {
  const page = req.url.searchParams.get('page') ?? '1'
  const txs = pages[page] ?? []
  return json({ txs: [], tx_responses: txs, pagination: null, total: String(total ?? Object.values(pages).flat().length) })
}

describe('ownedKids', () => {
  it('pages through tokens {owner, start_after, limit: 100} until an empty page, keeping canonical u32s, ascending', async () => {
    const pages: Record<string, string[]> = {
      '': ['1', '10', '100', '2'],
      '2': ['3', '07', 'abc', '4294967296'],
      '4294967296': [],
    }
    const { hub, calls } = reader(({ url }) => {
      const msg = smartMsg(url) as { tokens: { owner: string; start_after?: string; limit: number } }
      expect(smartContract(url)).toBe(CW721)
      expect(msg.tokens.owner).toBe(REECE)
      expect(msg.tokens.limit).toBe(100)
      return json({ data: { tokens: pages[msg.tokens.start_after ?? ''] ?? [] } })
    })
    await expect(hub.ownedKids(REECE)).resolves.toEqual([1, 2, 3, 10, 100])
    expect(calls.map((c) => (smartMsg(c.url) as { tokens: { start_after?: string } }).tokens.start_after)).toEqual([
      undefined,
      '2',
      '4294967296',
    ])
  })

  it('falls back to RPC abci_query when REST is down', async () => {
    const { hub, calls } = reader(({ url, body }) => {
      if (url.origin === REST) return new Response('down', { status: 503 })
      const params = (body as { params: { path: string; data: string } }).params
      expect(params.path).toBe('/cosmwasm.wasm.v1.Query/SmartContractState')
      const req = QuerySmartContractStateRequest.decode(fromHex(params.data))
      expect(req.address).toBe(CW721)
      const q = JSON.parse(new TextDecoder().decode(req.queryData)) as { tokens: { start_after?: string } }
      const tokens = q.tokens.start_after ? [] : ['5']
      const value = toBase64(QuerySmartContractStateResponse.encode({ data: toUtf8(JSON.stringify({ tokens })) }).finish())
      return rpcResult({ response: { code: 0, log: '', value } })
    })
    await expect(hub.ownedKids(REECE)).resolves.toEqual([5])
    expect(calls.filter((c) => c.url.origin === RPC_A)).toHaveLength(2)
  })

  it('rejects a malformed owner without asking the chain', async () => {
    const { hub, calls } = reader(() => json({}))
    await expect(codeOf(hub.ownedKids("cosmos1' OR 1=1"))).resolves.toBe('Unknown')
    await expect(codeOf(hub.ownedKids('osmo1reece3m8g4m3d0qrpj93rnnseudnpzhrdcnq6t'))).resolves.toBe('Unknown')
    expect(calls).toHaveLength(0)
  })
})

describe('escrow reads', () => {
  it('record: hex → checksummed recipient; null → null', async () => {
    const { hub } = reader(({ url }) => {
      const msg = smartMsg(url) as { record: { token_id: number } }
      expect(smartContract(url)).toBe(ESCROW)
      return json({ data: msg.record.token_id === 2 ? 'd2c392084761cb6e44c544b6f39dcc001fde9775' : null })
    })
    await expect(hub.record(2)).resolves.toEqual({ tokenId: 2, recipient: RECIPIENT })
    await expect(hub.record(1)).resolves.toBeNull()
  })

  it('allRecords: pages `pending` by 500 until a short page', async () => {
    const all = Array.from({ length: 501 }, (_, i) => ({ token_id: i * 2 + 1, eth_recipient: 'd2c392084761cb6e44c544b6f39dcc001fde9775' }))
    const { hub, calls } = reader(({ url }) => {
      const { pending } = smartMsg(url) as { pending: { start_after: number | null; limit: number } }
      expect(pending.limit).toBe(500)
      const from = pending.start_after === null ? 0 : all.findIndex((r) => r.token_id === pending.start_after) + 1
      return json({ data: all.slice(from, from + 500) })
    })
    const records = await hub.allRecords()
    expect(records).toHaveLength(501)
    expect(records[500]).toEqual({ tokenId: 1001, recipient: RECIPIENT })
    expect(calls.map((c) => (smartMsg(c.url) as { pending: { start_after: number | null } }).pending.start_after)).toEqual([null, 999])
  })

  it('escrowCw721 reads config {}', async () => {
    const { hub } = reader(({ url }) => {
      expect(smartMsg(url)).toEqual({ config: {} })
      return json({ data: CW721 })
    })
    await expect(hub.escrowCw721()).resolves.toBe(CW721)
  })

  it('contract errors come back as BridgeErrors, not retried', async () => {
    const { hub, calls } = reader(() => chainError('Error parsing into type escrow::msg::QueryMsg: unknown variant: query wasm contract failed'))
    await expect(codeOf(hub.escrowCw721())).resolves.toBe('Unknown')
    expect(calls).toHaveLength(1)
  })

  it('every escrow read is NotLive without an escrow; cw721 reads still work', async () => {
    const { hub, calls } = reader(() => json({ data: { tokens: [] } }), { escrow: null })
    const escrowReads: Array<() => Promise<unknown>> = [
      () => hub.record(1),
      () => hub.allRecords(),
      () => hub.sendInfo(1),
      () => hub.sendsBy(REECE),
      () => hub.escrowCw721(),
    ]
    for (const read of escrowReads) await expect(codeOf(read())).resolves.toBe('NotLive')
    expect(calls).toHaveLength(0)
    await expect(hub.ownedKids(REECE)).resolves.toEqual([])
  })
})

describe('contractInfo', () => {
  const info = (admin: string) => ({ address: ESCROW, contract_info: { code_id: '750', creator: REECE, admin, label: 'escrow' } })

  it('reads code id and admin over REST; an empty admin is null', async () => {
    const { hub } = reader(({ url }) => {
      expect(url.pathname).toBe(`/cosmwasm/wasm/v1/contract/${ESCROW}`)
      return json(info(REECE))
    })
    await expect(hub.contractInfo(ESCROW)).resolves.toEqual({ codeId: 750, admin: REECE })
    const none = reader(() => json(info('')))
    await expect(none.hub.contractInfo(ESCROW)).resolves.toEqual({ codeId: 750, admin: null })
  })

  it('falls back to abci_query on RPC', async () => {
    const { hub } = reader(({ url, body }) => {
      if (url.origin === REST) return new Response('', { status: 502 })
      const { params } = body as { params: { path: string; data: string } }
      expect(params.path).toBe('/cosmwasm.wasm.v1.Query/ContractInfo')
      expect(QueryContractInfoRequest.decode(fromHex(params.data)).address).toBe(CW721)
      const value = QueryContractInfoResponse.encode({
        address: CW721,
        contractInfo: { codeId: 431n, creator: REECE, admin: REECE, label: 'ReeceBadTest', ibcPortId: '', ibc2PortId: '' },
      }).finish()
      return rpcResult({ response: { code: 0, value: toBase64(value) } })
    })
    await expect(hub.contractInfo(CW721)).resolves.toEqual({ codeId: 431, admin: REECE })
  })

  it('refuses a malformed answer and a malformed address', async () => {
    const { hub } = reader(() => json({ contract_info: { code_id: 'x', admin: '' } }), { rpc: [] })
    await expect(codeOf(hub.contractInfo(ESCROW))).resolves.toBe('Network')
    const { hub: h2, calls } = reader(() => json(info('')))
    await expect(codeOf(h2.contractInfo('cosmos1nope'))).resolves.toBe('Unknown')
    expect(calls).toHaveLength(0)
  })
})

describe('sendInfo', () => {
  it('finds the mainnet send of #2 from its events', async () => {
    // REST finds it; RPC is still queried too (merged, deduped), but comes up empty on its own index
    const { hub, calls } = reader((req) => {
      if (req.url.origin === REST) {
        expect(req.url.pathname).toBe('/cosmos/tx/v1beta1/txs')
        expect(req.url.searchParams.get('query')).toBe(`wasm._contract_address='${ESCROW}' AND wasm.token_id='2'`)
        return searchAnswer(req, { '1': [restTx(TX2, 33092461, [sendNftEvent('2'), bridgeEvent('2')])] })
      }
      return rpcResult({ txs: [], total_count: '0' })
    })
    await expect(hub.sendInfo(2)).resolves.toEqual({
      tokenId: 2,
      txHash: TX2,
      height: 33092461,
      sender: REECE,
      recipient: RECIPIENT,
      time: new Date('2026-09-23T21:17:43Z'),
    })
    // one REST page, plus one RPC node (the other never gets asked since the first answered)
    expect(calls.map((c) => c.url.origin)).toEqual([REST, RPC_A])
  })

  it("doesn't trust a hit whose conditions matched different events", async () => {
    // #5 went into the escrow; the same tx moved some other collection's #2. The search matches, the events don't.
    const lookalike = restTx(hash(1), 100, [sendNftEvent('5'), bridgeEvent('5'), sendNftEvent('2', 1, 'cosmos1other')])
    // a failed tx never counts, even with the right events
    const failed = restTx(hash(2), 101, [bridgeEvent('2')], 5)
    // right action and id, wrong contract
    const impostor = restTx(hash(3), 102, [bridgeEvent('2', 0, REECE, 'cosmos1impostor')])
    const { hub, calls } = reader((req) => {
      if (req.url.origin === REST) return searchAnswer(req, { '1': [lookalike, failed, impostor] })
      return rpcResult({ txs: [], total_count: '0' })
    })
    await expect(hub.sendInfo(2)).resolves.toBeNull()
    // a miss on REST asks one RPC node too, since indexes differ
    expect(calls.map((c) => c.url.origin)).toEqual([REST, RPC_A])
  })

  it('falls back to RPC tx_search (no block time there)', async () => {
    const { hub } = reader((req) => {
      if (req.url.origin === REST) return new Response('nope', { status: 502 })
      const params = (req.body as { params: Record<string, string> }).params
      expect(params.query).toBe(`wasm._contract_address='${ESCROW}' AND wasm.token_id='3'`)
      return rpcResult({ txs: [rpcTx(hash(9), 33092463, [sendNftEvent('3'), bridgeEvent('3')])], total_count: '1' })
    })
    const info = await hub.sendInfo(3)
    expect(info).toMatchObject({ tokenId: 3, height: 33092463, txHash: hash(9), sender: REECE, recipient: RECIPIENT })
    expect(info?.time).toBeUndefined()
  })

  it('pages REST search results using total', async () => {
    const noise = Array.from({ length: 100 }, (_, i) => restTx(hash(100 + i), 50 + i, [sendNftEvent('4', 0, 'cosmos1x')]))
    const real = restTx(hash(7), 300, [bridgeEvent('4')])
    const { hub, calls } = reader((req) => {
      if (req.url.origin === REST) return searchAnswer(req, { '1': noise, '2': [real] }, 101)
      return rpcResult({ txs: [], total_count: '0' })
    })
    await expect(hub.sendInfo(4)).resolves.toMatchObject({ tokenId: 4, height: 300 })
    // two REST pages, then one RPC node with nothing more to add (no `page` query param on an RPC call)
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', null])
    expect(calls[0]?.url.searchParams.get('limit')).toBe('100')
  })
})

describe('sendsBy', () => {
  it('emits one SendInfo per kid in a multi-kid tx, newest first', async () => {
    const older = restTx(hash(1), 200, [sendNftEvent('4'), bridgeEvent('4')], 0, '2026-09-20T00:00:00Z')
    const multi = restTx(
      hash(2),
      300,
      [sendNftEvent('9', 0), bridgeEvent('9', 0), sendNftEvent('7', 1), bridgeEvent('7', 1)],
      0,
      '2026-09-21T00:00:00.123456789Z',
    )
    // someone else's send that shares the tx: not REECE's
    const mixed = restTx(hash(3), 250, [bridgeEvent('11', 0, 'cosmos1someoneelse')])
    const { hub, calls } = reader((req) => {
      if (req.url.origin === REST) {
        expect(req.url.searchParams.get('query')).toBe(`wasm._contract_address='${ESCROW}' AND wasm.from='${REECE}'`)
        expect(req.url.searchParams.get('order_by')).toBe('ORDER_BY_DESC')
        return searchAnswer(req, { '1': [multi, mixed, older] })
      }
      return rpcResult({ txs: [], total_count: '0' })
    })
    const sends = await hub.sendsBy(REECE)
    expect(sends.map((s) => [s.tokenId, s.height])).toEqual([
      [7, 300],
      [9, 300],
      [4, 200],
    ])
    expect(sends[0]?.time?.toISOString()).toBe('2026-09-21T00:00:00.123Z')
    // one REST page, plus one RPC node queried alongside it
    expect(calls.map((c) => c.url.origin)).toEqual([REST, RPC_A])
  })
})

describe('blocks', () => {
  it('latestBlock over REST', async () => {
    const { hub } = reader(({ url }) => {
      expect(url.pathname).toBe('/cosmos/base/tendermint/v1beta1/blocks/latest')
      return json({ block: { header: { height: '33151217', time: '2026-09-27T18:13:09.138638244Z' } } })
    })
    await expect(hub.latestBlock()).resolves.toEqual({ height: 33151217, time: new Date('2026-09-27T18:13:09.138Z') })
  })

  it('block(h) falls back to RPC when REST has pruned it', async () => {
    const { hub, calls } = reader(({ url, body }) => {
      if (url.origin === REST) return chainError('height 100 is not available, lowest height is 32151299')
      if (url.origin === RPC_A) return rpcError('height 100 is not available, lowest height is 32893001')
      expect(body).toMatchObject({ method: 'block', params: { height: '100' } })
      return rpcResult({ block: { header: { height: '100', time: '2019-12-11T16:11:34Z' } } })
    })
    await expect(hub.block(100)).resolves.toEqual({ height: 100, time: new Date('2019-12-11T16:11:34Z') })
    expect(calls.map((c) => c.url.origin)).toEqual([REST, RPC_A, RPC_B])
  })

  it('every endpoint down → Network', async () => {
    const { hub } = reader(() => new Response('', { status: 504 }))
    await expect(codeOf(hub.latestBlock())).resolves.toBe('Network')
  })
})
