// HubReader over REST (LCD) with the CometBFT RPC list as fallback.

import { fromBase64, fromBech32, fromHex, fromUtf8, toBase64, toHex, toUtf8 } from '@cosmjs/encoding'
import {
  QueryContractInfoRequest,
  QueryContractInfoResponse,
  QuerySmartContractStateRequest,
  QuerySmartContractStateResponse,
} from 'cosmjs-types/cosmwasm/wasm/v1/query'
import type { Deployment } from '../../config/deployments'
import {
  BridgeError,
  type ContractInfo,
  type EscrowRecord,
  type HubAddress,
  type HubBlock,
  type HubReader,
  type KidId,
  type SendInfo,
} from '../types'
import { isKidId, parseKidId, recipientFromHex } from './encode'
import { toHubError } from './errors'
import { bridgeSends, parseChainTime, parseRestSearch, parseRpcSearch, toHeight, type SearchedTx } from './events'
import { ChainError, createTransport, EndpointError, type Http, type Transport, type TransportOptions } from './transport'

const TOKENS_PAGE = 100
const PENDING_PAGE = 500
const SEARCH_PAGE = 100
/** 200 × 100 tokens, 50 × 100 txs: far past anything real, and a hard stop if an endpoint pages forever. */
const MAX_TOKEN_PAGES = 200
const MAX_SEARCH_PAGES = 50
/** One activity-log status read gives up trying more endpoints after this. */
const TX_LOOKUP_MS = 20_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** URL-safe base64 so a `/` in the encoding can't split the REST path. grpc-gateway accepts both alphabets. */
function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_')
}

/** A bech32 account or contract address with the deployment's prefix. Also keeps quotes out of tx search queries. */
export function isHubAddress(address: unknown, prefix: string): boolean {
  if (typeof address !== 'string' || !/^[a-z]+1[02-9ac-hj-np-z]{38,90}$/.test(address)) return false
  try {
    const { prefix: p, data } = fromBech32(address)
    return p === prefix && (data.length === 20 || data.length === 32)
  } catch {
    return false
  }
}

/** Smart query over REST, or abci_query on RPC. Contract errors are ChainErrors (final). */
export async function smartQuery(t: Transport, contract: string, msg: object, label: string): Promise<unknown> {
  const json = toUtf8(JSON.stringify(msg))
  return t.run(label, {
    async rest(base, http) {
      const body = await http.get(`${base}/cosmwasm/wasm/v1/contract/${contract}/smart/${base64Url(json)}`)
      if (!isRecord(body) || !('data' in body)) throw new EndpointError(`${label}: no data in response`)
      return body.data
    },
    async rpc(base, http) {
      const data = toHex(QuerySmartContractStateRequest.encode({ address: contract, queryData: json }).finish())
      const value = await abciQuery(http, base, '/cosmwasm.wasm.v1.Query/SmartContractState', data)
      const res = QuerySmartContractStateResponse.decode(value)
      try {
        return JSON.parse(fromUtf8(res.data)) as unknown
      } catch {
        throw new EndpointError(`${label}: contract answer isn't JSON`)
      }
    },
  })
}

/** abci_query; non-zero response code is a ChainError. Returns the raw response value. */
export async function abciQuery(http: Http, base: string, path: string, dataHex: string): Promise<Uint8Array> {
  const result = await http.rpc(base, 'abci_query', { path, data: dataHex, prove: false })
  const response = isRecord(result) && isRecord(result.response) ? result.response : null
  if (!response) throw new EndpointError(`${base} abci_query: no response`)
  const code = typeof response.code === 'number' ? response.code : 0
  if (code !== 0) throw new ChainError(typeof response.log === 'string' ? response.log : `abci code ${code}`, code)
  if (typeof response.value !== 'string') throw new EndpointError(`${base} abci_query: missing response value`)
  return fromBase64(response.value)
}

/** Every tx matching `query`, all pages from one endpoint (so pages can't mix two nodes' views). */
function searchCall(query: string, order: 'asc' | 'desc') {
  return {
    rest: async (base: string, http: Http): Promise<SearchedTx[]> => {
      const out: SearchedTx[] = []
      for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
        const qs = new URLSearchParams({
          query,
          page: String(page),
          limit: String(SEARCH_PAGE),
          order_by: order === 'asc' ? 'ORDER_BY_ASC' : 'ORDER_BY_DESC',
        })
        let body: unknown
        try {
          body = await http.get(`${base}/cosmos/tx/v1beta1/txs?${qs.toString()}`)
        } catch (e) {
          // an indexer that's off or pruned answers with an error; another node may have it
          if (e instanceof ChainError) throw new EndpointError(`tx search: ${e.message}`)
          throw e
        }
        const { txs, total } = parseRestSearch(body)
        out.push(...txs)
        if (txs.length === 0 || out.length >= total) break
      }
      return out
    },
    rpc: async (base: string, http: Http): Promise<SearchedTx[]> => {
      const out: SearchedTx[] = []
      for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
        const result = await http.rpc(base, 'tx_search', {
          query,
          prove: false,
          page: String(page),
          per_page: String(SEARCH_PAGE),
          order_by: order,
        })
        const { txs, total } = parseRpcSearch(result)
        out.push(...txs)
        if (txs.length === 0 || out.length >= total) break
      }
      return out
    },
  }
}

function parseBlock(header: unknown, where: string): HubBlock {
  const h = isRecord(header) ? header : {}
  const height = toHeight(h.height)
  const time = parseChainTime(h.time)
  if (height === null || !time) throw new EndpointError(`${where}: no block header`)
  return { height, time }
}

function blockCall(height: number | 'latest') {
  return {
    async rest(base: string, http: Http): Promise<HubBlock> {
      let body: unknown
      try {
        body = await http.get(`${base}/cosmos/base/tendermint/v1beta1/blocks/${height}`)
      } catch (e) {
        // pruned nodes refuse old heights; an RPC node may keep more history
        if (e instanceof ChainError) throw new EndpointError(`block ${height}: ${e.message}`)
        throw e
      }
      const block = isRecord(body) && isRecord(body.block) ? body.block : {}
      return parseBlock(block.header, `${base} block ${height}`)
    },
    async rpc(base: string, http: Http): Promise<HubBlock> {
      const result = await http.rpc(base, 'block', height === 'latest' ? {} : { height: String(height) })
      const block = isRecord(result) && isRecord(result.block) ? result.block : {}
      return parseBlock(block.header, `${base} block ${height}`)
    },
  }
}

/** contract_info's code id and admin. An empty admin means nobody can migrate the contract. */
function parseContractInfo(codeId: unknown, admin: unknown, where: string): ContractInfo {
  const id = typeof codeId === 'bigint' ? Number(codeId) : typeof codeId === 'string' && /^\d+$/.test(codeId) ? Number(codeId) : NaN
  if (!Number.isSafeInteger(id) || id <= 0 || typeof admin !== 'string') throw new EndpointError(`${where}: no contract_info`)
  return { codeId: id, admin: admin === '' ? null : admin }
}

function contractInfoCall(address: HubAddress) {
  return {
    async rest(base: string, http: Http): Promise<ContractInfo> {
      const body = await http.get(`${base}/cosmwasm/wasm/v1/contract/${address}`)
      const info = isRecord(body) && isRecord(body.contract_info) ? body.contract_info : {}
      return parseContractInfo(info.code_id, info.admin, `${base} contract ${address}`)
    },
    async rpc(base: string, http: Http): Promise<ContractInfo> {
      const data = toHex(QueryContractInfoRequest.encode({ address }).finish())
      const res = QueryContractInfoResponse.decode(await abciQuery(http, base, '/cosmwasm.wasm.v1.Query/ContractInfo', data))
      return parseContractInfo(res.contractInfo?.codeId, res.contractInfo?.admin, `${base} contract ${address}`)
    },
  }
}

function byHeightDesc(a: SendInfo, b: SendInfo): number {
  return b.height - a.height || a.tokenId - b.tokenId
}

type Lookup = { found: false } | { found: true; height: number; code: number; log: string }

const NOT_FOUND = /not found/i

/**
 * One look for a tx by hash: REST, then each RPC node. A "not found" from one endpoint doesn't mean not found
 * everywhere (indexer lag, pruning), so it keeps trying the rest instead of giving up early; `deadline` (Date.now()
 * ms) stops it from trying further endpoints once the caller's budget is spent, since each endpoint has its own
 * timeout and REST+RPC together can otherwise run well past it. Not found anywhere reachable → { found: false }.
 */
export async function lookupTx(http: Http, rest: readonly string[], rpc: readonly string[], hash: string, deadline: number): Promise<Lookup> {
  for (const base of rest) {
    if (Date.now() > deadline) return { found: false }
    try {
      const body = await http.get(`${base}/cosmos/tx/v1beta1/txs/${hash}`)
      const r = isRecord(body) && isRecord(body.tx_response) ? body.tx_response : null
      const height = toHeight(r?.height)
      if (!r || height === null) continue
      return { found: true, height, code: typeof r.code === 'number' ? r.code : 0, log: typeof r.raw_log === 'string' ? r.raw_log : '' }
    } catch (e) {
      // not found here doesn't mean not found on another endpoint; keep going (same for a genuine EndpointError)
      if (!(e instanceof ChainError && (e.code === 5 || NOT_FOUND.test(e.message)))) continue
    }
  }
  for (const base of rpc) {
    if (Date.now() > deadline) return { found: false }
    try {
      const r = await http.rpc(base, 'tx', { hash: toBase64(fromHex(hash)), prove: false })
      const height = isRecord(r) ? toHeight(r.height) : null
      const result = isRecord(r) && isRecord(r.tx_result) ? r.tx_result : null
      if (height === null || !result) continue
      return { found: true, height, code: typeof result.code === 'number' ? result.code : 0, log: typeof result.log === 'string' ? result.log : '' }
    } catch (e) {
      if (!(e instanceof EndpointError && NOT_FOUND.test(e.message))) continue
    }
  }
  return { found: false }
}

export function createHubReader(deployment: Deployment, options: TransportOptions = {}): HubReader {
  const hub = deployment.hub
  const t = createTransport(hub, options)

  function escrow(): HubAddress {
    if (!hub.escrow) throw new BridgeError('NotLive', `${deployment.collectionName} has no escrow on the Hub yet`)
    return hub.escrow
  }

  /** Runs a read, and turns anything it throws into a BridgeError. */
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      throw toHubError(e)
    }
  }

  function checkAddress(address: string, what: string): void {
    if (!isHubAddress(address, hub.bech32Prefix)) {
      throw new BridgeError('Unknown', `${what} "${address}" is not a ${hub.bech32Prefix}1… address`)
    }
  }

  /**
   * Searches REST and RPC both, and merges: REST's indexer can be a partial or stale view (different node,
   * indexer lag, pruning) next to RPC's, so finding something via REST alone isn't grounds to skip RPC. Either
   * side being down just falls back to the other.
   */
  async function findSends(query: string, order: 'asc' | 'desc', keep: (s: SendInfo) => boolean): Promise<SendInfo[]> {
    const esc = escrow()
    const sendsIn = (txs: SearchedTx[]) => txs.flatMap((tx) => bridgeSends(tx, esc)).filter(keep)
    const call = searchCall(query, order)
    let rest: SendInfo[] | null = null
    try {
      rest = sendsIn(await t.run('tx search', { rest: call.rest }))
    } catch (e) {
      if (!(e instanceof BridgeError && e.code === 'Network')) throw e
    }
    let rpc: SendInfo[]
    try {
      rpc = sendsIn(await t.run('tx search', { rpc: call.rpc }))
    } catch (e) {
      // REST answered (maybe with nothing) and RPC is down: REST's view is all there is
      if (rest !== null && e instanceof BridgeError && e.code === 'Network') return rest
      throw e
    }
    if (rest === null) return rpc
    // both answered: merge and dedupe (a tx can hold more than one kid, so key on tx hash + kid)
    const merged = new Map<string, SendInfo>()
    for (const s of [...rest, ...rpc]) merged.set(`${s.txHash}:${s.tokenId}`, s)
    return [...merged.values()]
  }

  return {
    ownedKids: (owner) =>
      guard(async () => {
        checkAddress(owner, 'owner')
        const ids = new Set<KidId>()
        let startAfter: string | undefined
        for (let page = 0; page < MAX_TOKEN_PAGES; page++) {
          const msg = { tokens: { owner, ...(startAfter === undefined ? {} : { start_after: startAfter }), limit: TOKENS_PAGE } }
          const data = await smartQuery(t, hub.cw721, msg, 'owned kids')
          const tokens = isRecord(data) ? data.tokens : undefined
          if (!Array.isArray(tokens) || !tokens.every((x) => typeof x === 'string')) {
            throw new BridgeError('Unknown', 'cw721 tokens query returned something unexpected')
          }
          // ids are strings: only canonical u32 decimals are kids the escrow would take
          for (const s of tokens) {
            const id = parseKidId(s)
            if (id !== null) ids.add(id)
          }
          // cw721 MAX_LIMIT varies by version, so only an empty page means the end
          const last = tokens.at(-1)
          if (last === undefined || last === startAfter) break
          startAfter = last
        }
        return [...ids].sort((a, b) => a - b)
      }),

    record: (id) =>
      guard(async () => {
        if (!isKidId(id)) throw new BridgeError('BadTokenId', `${String(id)} is not a u32 token id`)
        const data = await smartQuery(t, escrow(), { record: { token_id: id } }, 'escrow record')
        if (data === null) return null
        const recipient = recipientFromHex(data)
        if (!recipient) throw new BridgeError('Unknown', `escrow record for #${id} isn't 20 bytes of hex: ${JSON.stringify(data)}`)
        return { tokenId: id, recipient }
      }),

    allRecords: () =>
      guard(async () => {
        const esc = escrow()
        const out: EscrowRecord[] = []
        for (;;) {
          const startAfter = out.at(-1)?.tokenId ?? null
          const data = await smartQuery(t, esc, { pending: { start_after: startAfter, limit: PENDING_PAGE } }, 'escrow records')
          if (!Array.isArray(data)) throw new BridgeError('Unknown', 'escrow pending query returned something unexpected')
          for (const r of data) {
            const tokenId = isRecord(r) ? r.token_id : undefined
            const recipient = isRecord(r) ? recipientFromHex(r.eth_recipient) : null
            const prev = out.at(-1)?.tokenId
            // strictly ascending, which also guarantees each page moves forward
            if (!isKidId(tokenId) || !recipient || (prev !== undefined && tokenId <= prev)) {
              throw new BridgeError('Unknown', `escrow pending returned a bad record: ${JSON.stringify(r)}`)
            }
            out.push({ tokenId, recipient })
          }
          if (data.length < PENDING_PAGE) return out
        }
      }),

    sendInfo: (id) =>
      guard(async () => {
        if (!isKidId(id)) throw new BridgeError('BadTokenId', `${String(id)} is not a u32 token id`)
        const query = `wasm._contract_address='${escrow()}' AND wasm.token_id='${id}'`
        const sends = await findSends(query, 'asc', (s) => s.tokenId === id)
        // a record is written once, so there's one real send; the earliest is it
        return sends.sort((a, b) => a.height - b.height)[0] ?? null
      }),

    sendsBy: (sender) =>
      guard(async () => {
        checkAddress(sender, 'sender')
        const query = `wasm._contract_address='${escrow()}' AND wasm.from='${sender}'`
        const sends = await findSends(query, 'desc', (s) => s.sender === sender)
        return sends.sort(byHeightDesc)
      }),

    latestBlock: () => guard(() => t.run('latest block', blockCall('latest'))),

    block: (height) =>
      guard(() => {
        if (!Number.isSafeInteger(height) || height <= 0) throw new BridgeError('Unknown', `bad block height ${height}`)
        return t.run(`block ${height}`, blockCall(height))
      }),

    escrowCw721: () =>
      guard(async () => {
        const data = await smartQuery(t, escrow(), { config: {} }, 'escrow config')
        if (typeof data !== 'string') throw new BridgeError('Unknown', `escrow config returned ${JSON.stringify(data)}`)
        return data
      }),

    contractInfo: (address) =>
      guard(async () => {
        checkAddress(address, 'contract')
        return t.run('contract info', contractInfoCall(address))
      }),

    txStatus: (hash) =>
      guard(async () => {
        if (!/^[0-9A-F]{64}$/.test(hash)) throw new BridgeError('Unknown', `bad Hub tx hash "${hash}"`)
        const strip = (u: string) => u.replace(/\/+$/, '')
        const seen = await lookupTx(t.http, hub.rest.map(strip), hub.rpc.map(strip), hash, Date.now() + TX_LOOKUP_MS)
        if (!seen.found) return 'pending'
        return seen.code === 0 ? 'confirmed' : 'failed'
      }),

    // the escrow checks wasmd's contract admin for EmergencyUnlock, so the CosmWasm admin is the unlock admin
    escrowAdmin: () =>
      guard(async () => {
        const info = await t.run('escrow emergency admin', contractInfoCall(escrow()))
        return info.admin
      }),
  }
}
