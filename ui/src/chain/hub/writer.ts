// The HubWriter core: one tx, one MsgExecuteContract per kid, simulate before anything touches the wallet.
// Plain factory (no React, no graz) so tests and the live suite can drive it without a wallet.

import { fromBase64, toBase64, toHex } from '@cosmjs/encoding'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm'
import type { OfflineSigner } from '@cosmjs/proto-signing'
import { accountFromAny } from '@cosmjs/stargate'
import { QueryAccountRequest, QueryAccountResponse } from 'cosmjs-types/cosmos/auth/v1beta1/query'
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys'
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing'
import { SimulateRequest, SimulateResponse } from 'cosmjs-types/cosmos/tx/v1beta1/service'
import { AuthInfo, Fee, Tx, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx'
import { sha256 } from 'viem'
import { recordActivity } from '../../activity/storage'
import type { Deployment } from '../../config/deployments'
import {
  BridgeError,
  stageReporter,
  type EthAddress,
  type HubAddress,
  type HubWriter,
  type KidId,
  type SendEstimate,
  type SendResult,
  type SendStage,
} from '../types'
import { checkRecipient } from '../eth/recipient'
import { buildNudgeMsg, buildSendMsgs, MSG_TRANSFER, NUDGE_MEMO, type ExecuteEncodeObject, type TransferEncodeObject } from './encode'
import { chainLogToBridgeError, toHubError, walletErrorToBridgeError } from './errors'
import { abciQuery, lookupTx } from './reader'
import { createTransport, EndpointError, type Transport, type TransportOptions } from './transport'

/** Gas limit = simulated gas × 1.4. */
export const GAS_MULTIPLIER_TENTHS = 14n
/** Fee = gas limit × feemarket price × 1.5. */
export const PRICE_HEADROOM_TENTHS = 15n
/** Used when the feemarket query fails. The Hub's floor on 2026-09-27. Headroom still applies. */
export const FALLBACK_GAS_PRICE = '0.005'
/** A feemarket price above this is clamped to it: 10× the flat 0.005 the Hub has sat at, so a lying endpoint can't inflate the fee. */
export const MAX_GAS_PRICE = '0.05'
/** A send_nft simulates to ~223k gas. More than 600k per kid plus 300k means the endpoint is lying: refuse. */
export const MAX_GAS_PER_KID = 600_000n
export const MAX_GAS_BASE = 300_000n
/** The most a send may cost, in the fee denom's smallest unit: 0.25 ATOM plus 0.05 ATOM per kid. Above it: FeeTooHigh. */
export const MAX_FEE_BASE = 250_000n
export const MAX_FEE_PER_KID = 50_000n
/** A MsgTransfer simulates to ~120k gas. More means the endpoint is lying: refuse. */
export const MAX_NUDGE_GAS = 400_000n
/** The most the nudge's own network fee may be: 0.05 ATOM, on top of the 0.001 ATOM it sends. Above it: FeeTooHigh. */
export const MAX_NUDGE_FEE = 50_000n

const SECP256K1_PUBKEY = '/cosmos.crypto.secp256k1.PubKey'
// sdk ErrTxInMempoolCache: the same bytes were already accepted, e.g. by an earlier endpoint that then timed out
const TX_IN_MEMPOOL = 19

export interface HubWriterConfig {
  deployment: Deployment
  /** The signing account. */
  address: HubAddress
  /**
   * The wallet's signer, or a function that fetches it. Only touched after a simulate succeeds. Omit it for a
   * simulate-only writer (send() then rejects).
   */
  signer?: OfflineSigner | (() => Promise<OfflineSigner>)
  /** The account's 33-byte secp256k1 pubkey, from the wallet. Lets a never-used account simulate. Falls back to the chain's. */
  pubkey?: Uint8Array
  transport?: TransportOptions
  /** How often to look for the tx after broadcast. Default 2.5s. */
  pollMs?: number
  /** Give up waiting for inclusion after this long. Default 120s. */
  inclusionTimeoutMs?: number
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
}

interface AccountInfo {
  accountNumber: bigint
  sequence: number
  /** On-chain pubkey, if the account has ever signed. */
  pubkey: Uint8Array | null
}

interface Prepared {
  msgs: ExecuteEncodeObject[]
  account: AccountInfo
  estimate: SendEstimate
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Decimal string → (numerator, 10^scale). Only plain non-negative decimals. */
export function parseDecimal(s: string): { num: bigint; den: bigint } | null {
  const m = /^(\d+)(?:\.(\d{1,36}))?$/.exec(s.trim())
  if (!m?.[1]) return null
  const frac = m[2] ?? ''
  return { num: BigInt(m[1] + frac), den: 10n ** BigInt(frac.length) }
}

/** ceil(gasUsed × 1.4) and ceil(gas × price × 1.5), exact. */
export function computeFee(gasUsed: bigint, gasPrice: string): { gas: bigint; fee: bigint } {
  const price = parseDecimal(gasPrice)
  if (!price || price.num === 0n) throw new BridgeError('Unknown', `bad gas price "${gasPrice}"`)
  const gas = (gasUsed * GAS_MULTIPLIER_TENTHS + 9n) / 10n
  const numer = gas * price.num * PRICE_HEADROOM_TENTHS
  const denom = price.den * 10n
  return { gas, fee: (numer + denom - 1n) / denom }
}

/** `price`, or throws FeeTooHigh if it's above MAX_GAS_PRICE: a feemarket price that high needs a real fee, not a silently capped one. */
export function clampGasPrice(price: string): string {
  const p = parseDecimal(price)
  const max = parseDecimal(MAX_GAS_PRICE)
  if (!p || !max) return MAX_GAS_PRICE
  if (p.num * max.den > max.num * p.den) {
    throw new BridgeError('FeeTooHigh', `feemarket gas price ${price} is above the ${MAX_GAS_PRICE} ceiling`)
  }
  return price
}

/**
 * Refuses a simulate or fee a real send could never need. The wallet signs the fee as given (preferNoSetFee), so
 * this is what stands between a lying Hub endpoint and an absurd fee.
 */
export function checkFee(kids: number, gasUsed: bigint, fee: bigint, denom: string): void {
  const n = BigInt(kids)
  const maxGas = n * MAX_GAS_PER_KID + MAX_GAS_BASE
  if (gasUsed > maxGas) throw new BridgeError('FeeTooHigh', `the Hub simulated ${gasUsed} gas for ${kids} kids; more than ${maxGas} means something's off`)
  const maxFee = MAX_FEE_BASE + n * MAX_FEE_PER_KID
  if (fee > maxFee) throw new BridgeError('FeeTooHigh', `fee ${fee}${denom} for ${kids} kids is over the ${maxFee}${denom} ceiling`)
}

/** checkFee's nudge equivalent: one fixed-size MsgTransfer, so no per-kid scaling. */
export function checkNudgeFee(gasUsed: bigint, fee: bigint, denom: string): void {
  if (gasUsed > MAX_NUDGE_GAS) throw new BridgeError('FeeTooHigh', `the Hub simulated ${gasUsed} gas for the speed-up transfer; more than ${MAX_NUDGE_GAS} means something's off`)
  if (fee > MAX_NUDGE_FEE) throw new BridgeError('FeeTooHigh', `fee ${fee}${denom} for the speed-up transfer is over the ${MAX_NUDGE_FEE}${denom} ceiling`)
}

/** Finds the BaseAccount fields inside BaseAccount or any vesting wrapper (REST JSON). */
function findBaseAccount(v: unknown, depth = 0): Record<string, unknown> | null {
  if (!isRecord(v) || depth > 4) return null
  if ('account_number' in v && 'sequence' in v) return v
  for (const child of Object.values(v)) {
    const found = findBaseAccount(child, depth + 1)
    if (found) return found
  }
  return null
}

function parseRestAccount(body: unknown): AccountInfo {
  const base = findBaseAccount(isRecord(body) ? body.account : null)
  if (!base) throw new EndpointError('account: unexpected shape')
  const { account_number: n, sequence: s, pub_key: pk } = base
  if (typeof n !== 'string' || !/^\d+$/.test(n) || typeof s !== 'string' || !/^\d+$/.test(s)) {
    throw new EndpointError('account: bad number or sequence')
  }
  let pubkey: Uint8Array | null = null
  if (isRecord(pk) && pk['@type'] === SECP256K1_PUBKEY && typeof pk.key === 'string') pubkey = fromBase64(pk.key)
  return { accountNumber: BigInt(n), sequence: Number(s), pubkey }
}

async function getAccount(t: Transport, address: HubAddress): Promise<AccountInfo> {
  return t.run('account', {
    rest: async (base, http) => parseRestAccount(await http.get(`${base}/cosmos/auth/v1beta1/accounts/${address}`)),
    async rpc(base, http) {
      const data = toHex(QueryAccountRequest.encode({ address }).finish())
      const res = QueryAccountResponse.decode(await abciQuery(http, base, '/cosmos.auth.v1beta1.Query/Account', data))
      if (!res.account) throw new EndpointError('account: empty answer')
      const acc = accountFromAny(res.account)
      const pubkey = acc.pubkey?.type === 'tendermint/PubKeySecp256k1' && typeof acc.pubkey.value === 'string' ? fromBase64(acc.pubkey.value) : null
      return { accountNumber: acc.accountNumber, sequence: acc.sequence, pubkey }
    },
  })
}

/** The tx the SDK simulates: real messages, real sequence and pubkey, empty signature (simulate doesn't verify it). */
export function simulationTxBytes(msgs: readonly ExecuteEncodeObject[], pubkey: Uint8Array, sequence: number): Uint8Array {
  const tx = Tx.fromPartial({
    body: TxBody.fromPartial({
      messages: msgs.map((m) => ({ typeUrl: m.typeUrl, value: MsgExecuteContract.encode(m.value).finish() })),
      memo: '',
    }),
    authInfo: AuthInfo.fromPartial({
      fee: Fee.fromPartial({}),
      signerInfos: [
        {
          publicKey: { typeUrl: SECP256K1_PUBKEY, value: PubKey.encode({ key: pubkey }).finish() },
          sequence: BigInt(sequence),
          modeInfo: { single: { mode: SignMode.SIGN_MODE_UNSPECIFIED } },
        },
      ],
    }),
    signatures: [new Uint8Array()],
  })
  return Tx.encode(tx).finish()
}

/** simulationTxBytes's nudge equivalent: the same empty-signature shape, around one MsgTransfer. */
export function transferSimulationTxBytes(msg: TransferEncodeObject['value'], pubkey: Uint8Array, sequence: number): Uint8Array {
  const tx = Tx.fromPartial({
    body: TxBody.fromPartial({
      messages: [{ typeUrl: MSG_TRANSFER, value: MsgTransfer.encode(msg).finish() }],
      memo: NUDGE_MEMO,
    }),
    authInfo: AuthInfo.fromPartial({
      fee: Fee.fromPartial({}),
      signerInfos: [
        {
          publicKey: { typeUrl: SECP256K1_PUBKEY, value: PubKey.encode({ key: pubkey }).finish() },
          sequence: BigInt(sequence),
          modeInfo: { single: { mode: SignMode.SIGN_MODE_UNSPECIFIED } },
        },
      ],
    }),
    signatures: [new Uint8Array()],
  })
  return Tx.encode(tx).finish()
}

async function simulateGas(t: Transport, txBytes: Uint8Array): Promise<bigint> {
  return t.run('simulate', {
    async rest(base, http) {
      const body = await http.post(`${base}/cosmos/tx/v1beta1/simulate`, { tx_bytes: toBase64(txBytes) })
      const used = isRecord(body) && isRecord(body.gas_info) ? body.gas_info.gas_used : undefined
      if (typeof used !== 'string' || !/^\d+$/.test(used)) throw new EndpointError('simulate: no gas_used')
      return BigInt(used)
    },
    async rpc(base, http) {
      const data = toHex(SimulateRequest.encode({ txBytes }).finish())
      const res = SimulateResponse.decode(await abciQuery(http, base, '/cosmos.tx.v1beta1.Service/Simulate', data))
      if (!res.gasInfo) throw new EndpointError('simulate: no gas info')
      return res.gasInfo.gasUsed
    },
  })
}

/**
 * Feemarket base price for `denom`, clamped to MAX_GAS_PRICE, or FALLBACK_GAS_PRICE if it can't be read.
 * Headroom is applied by computeFee.
 */
export async function gasPrice(t: Transport, denom: string): Promise<string> {
  let price: string
  try {
    price = await t.run('gas price', {
      async rest(base, http) {
        const body = await http.get(`${base}/feemarket/v1/gas_price/${denom}`)
        const price = isRecord(body) && isRecord(body.price) ? body.price : {}
        const ok = price.denom === denom && typeof price.amount === 'string' && (parseDecimal(price.amount)?.num ?? 0n) > 0n
        if (!ok) throw new EndpointError('gas price: unexpected shape')
        return price.amount as string
      },
    })
  } catch {
    return FALLBACK_GAS_PRICE
  }
  return clampGasPrice(price)
}

type Broadcast = { accepted: true } | { accepted: false; code: number; log: string }

function checkTxResult(code: unknown, log: unknown): Broadcast {
  const c = typeof code === 'number' ? code : 0
  if (c === 0 || c === TX_IN_MEMPOOL) return { accepted: true }
  return { accepted: false, code: c, log: typeof log === 'string' && log ? log : `CheckTx code ${c}` }
}

async function broadcastSync(t: Transport, txBytes: Uint8Array): Promise<Broadcast> {
  const tx = toBase64(txBytes)
  return t.run('broadcast', {
    async rest(base, http) {
      const body = await http.post(`${base}/cosmos/tx/v1beta1/txs`, { tx_bytes: tx, mode: 'BROADCAST_MODE_SYNC' })
      const r = isRecord(body) && isRecord(body.tx_response) ? body.tx_response : null
      if (!r) throw new EndpointError('broadcast: no tx_response')
      return checkTxResult(r.code, r.raw_log)
    },
    async rpc(base, http) {
      const r = await http.rpc(base, 'broadcast_tx_sync', { tx })
      if (!isRecord(r)) throw new EndpointError('broadcast_tx_sync: no result')
      return checkTxResult(r.code, r.log)
    },
  })
}

export function createHubWriter(config: HubWriterConfig): HubWriter {
  const { deployment, address } = config
  const hub = deployment.hub
  const t = createTransport(hub, config.transport)
  const sleep = config.sleep ?? config.transport?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = config.pollMs ?? 2_500
  const inclusionTimeoutMs = config.inclusionTimeoutMs ?? 120_000
  const strip = (u: string) => u.replace(/\/+$/, '')

  async function signer(): Promise<OfflineSigner> {
    const s = config.signer
    if (!s) throw new BridgeError('Unknown', 'no Hub wallet signer: connect a wallet first')
    return typeof s === 'function' ? s() : s
  }

  async function pubkeyFor(account: AccountInfo): Promise<Uint8Array> {
    if (config.pubkey) return config.pubkey
    if (account.pubkey) return account.pubkey
    // a connected wallet answers getAccounts() without a prompt
    try {
      const acc = (await (await signer()).getAccounts()).find((a) => a.address === address)
      if (acc) return acc.pubkey
    } catch {
      // fall through
    }
    throw new BridgeError('Unknown', `no public key for ${address}: connect the wallet that owns it`)
  }

  async function prepare(ids: readonly KidId[], recipient: EthAddress): Promise<Prepared> {
    if (!hub.escrow) throw new BridgeError('NotLive', `${deployment.collectionName} has no escrow on the Hub yet`)
    // buildSendMsgs only checks format/zero; layer on the burn/precompile check too, so the send path can't be
    // reached with a recipient the lookup page would have refused
    const check = checkRecipient(recipient)
    if (!check.ok) {
      if (check.reason === 'zero') throw new BridgeError('ZeroRecipient', 'recipient is the zero address')
      if (check.reason === 'burn') throw new BridgeError('BurnRecipient', 'recipient is a burn or precompile address: a kid sent there could never move again')
      throw new BridgeError('BadRecipient', `recipient fails ${check.reason} validation`)
    }
    // validates ids and recipient (20 bytes, not zero) before any network or wallet
    const msgs = buildSendMsgs(address, hub.cw721, hub.escrow, ids, recipient)
    const account = await getAccount(t, address)
    const pubkey = await pubkeyFor(account)
    const [used, price] = await Promise.all([
      simulateGas(t, simulationTxBytes(msgs, pubkey, account.sequence)),
      gasPrice(t, hub.gasDenom),
    ])
    const { gas, fee } = computeFee(used, price)
    checkFee(msgs.length, used, fee, hub.gasDenom)
    return { msgs, account, estimate: { gas: Number(gas), amount: fee.toString(), denom: hub.gasDenom } }
  }

  async function prepareNudge(sourceClientId: string, recipient: EthAddress): Promise<{ msg: TransferEncodeObject; account: AccountInfo; estimate: SendEstimate }> {
    const msg = buildNudgeMsg(address, sourceClientId, hub.gasDenom, recipient, Date.now())
    const account = await getAccount(t, address)
    const pubkey = await pubkeyFor(account)
    const [used, price] = await Promise.all([
      simulateGas(t, transferSimulationTxBytes(msg.value, pubkey, account.sequence)),
      gasPrice(t, hub.gasDenom),
    ])
    const { gas, fee } = computeFee(used, price)
    checkNudgeFee(used, fee, hub.gasDenom)
    return { msg, account, estimate: { gas: Number(gas), amount: fee.toString(), denom: hub.gasDenom } }
  }

  async function waitForInclusion(hash: string, ids: readonly KidId[], timeoutMs: number): Promise<SendResult | null> {
    const deadline = Date.now() + timeoutMs
    const rest = hub.rest.map(strip)
    const rpc = hub.rpc.map(strip)
    for (;;) {
      const seen = await lookupTx(t.http, rest, rpc, hash, deadline)
      if (seen.found) {
        if (seen.code !== 0) throw chainLogToBridgeError(seen.log || `tx ${hash} failed with code ${seen.code}`, ids)
        return { txHash: hash, height: seen.height }
      }
      if (Date.now() + pollMs > deadline) return null
      await sleep(pollMs)
    }
  }

  async function sendTx(ids: readonly KidId[], recipient: EthAddress, report: (stage: SendStage) => void): Promise<SendResult> {
    report('simulating')
    let prepared: Prepared
    try {
      prepared = await prepare(ids, recipient)
    } catch (e) {
      // a failed simulate never reaches the wallet
      throw toHubError(e, ids)
    }

    let txBytes: Uint8Array
    try {
      const wallet = await signer()
      report('signing')
      const client = await SigningCosmWasmClient.offline(wallet)
      const fee = { amount: [{ denom: prepared.estimate.denom, amount: prepared.estimate.amount }], gas: String(prepared.estimate.gas) }
      const raw = await client.sign(address, prepared.msgs, fee, '', {
        accountNumber: prepared.account.accountNumber,
        sequence: prepared.account.sequence,
        chainId: hub.chainId,
      })
      txBytes = TxRaw.encode(raw).finish()
    } catch (e) {
      throw walletErrorToBridgeError(e)
    }

    report('broadcasting')
    const hash = sha256(txBytes).slice(2).toUpperCase()
    recordActivity(deployment.id, { action: 'send', hash, kids: [...ids] })
    try {
      const sent = await broadcastSync(t, txBytes)
      if (!sent.accepted) throw chainLogToBridgeError(sent.log, ids)
    } catch (e) {
      if (!(e instanceof BridgeError && e.code === 'Network')) throw toHubError(e, ids)
      // every endpoint failed to answer, but one may still have taken it: look before giving up
      const landed = await waitForInclusion(hash, ids, Math.min(inclusionTimeoutMs, 30_000))
      if (landed) return landed
      throw new BridgeError('Network', `couldn't broadcast tx ${hash}; check an explorer before trying again (${e.detail ?? ''})`)
    }

    try {
      const landed = await waitForInclusion(hash, ids, inclusionTimeoutMs)
      if (landed) return landed
    } catch (e) {
      throw toHubError(e, ids)
    }
    throw new BridgeError('Network', `tx ${hash} was accepted but isn't in a block after ${Math.round(inclusionTimeoutMs / 1000)}s; check an explorer before trying again`)
  }

  /** sendTx's nudge equivalent: same simulate → sign → broadcast → wait shape, around one MsgTransfer. */
  async function nudgeTx(sourceClientId: string, recipient: EthAddress, report: (stage: SendStage) => void): Promise<SendResult> {
    report('simulating')
    let prepared: { msg: TransferEncodeObject; account: AccountInfo; estimate: SendEstimate }
    try {
      prepared = await prepareNudge(sourceClientId, recipient)
    } catch (e) {
      throw toHubError(e)
    }

    let txBytes: Uint8Array
    try {
      const wallet = await signer()
      report('signing')
      const client = await SigningCosmWasmClient.offline(wallet)
      const fee = { amount: [{ denom: prepared.estimate.denom, amount: prepared.estimate.amount }], gas: String(prepared.estimate.gas) }
      const raw = await client.sign(address, [prepared.msg], fee, NUDGE_MEMO, {
        accountNumber: prepared.account.accountNumber,
        sequence: prepared.account.sequence,
        chainId: hub.chainId,
      })
      txBytes = TxRaw.encode(raw).finish()
    } catch (e) {
      throw walletErrorToBridgeError(e)
    }

    report('broadcasting')
    const hash = sha256(txBytes).slice(2).toUpperCase()
    recordActivity(deployment.id, { action: 'nudge', hash })
    try {
      const sent = await broadcastSync(t, txBytes)
      if (!sent.accepted) throw chainLogToBridgeError(sent.log)
    } catch (e) {
      if (!(e instanceof BridgeError && e.code === 'Network')) throw toHubError(e)
      const landed = await waitForInclusion(hash, [], Math.min(inclusionTimeoutMs, 30_000))
      if (landed) return landed
      throw new BridgeError('Network', `couldn't broadcast tx ${hash}; check an explorer before trying again (${e.detail ?? ''})`)
    }

    try {
      const landed = await waitForInclusion(hash, [], inclusionTimeoutMs)
      if (landed) return landed
    } catch (e) {
      throw toHubError(e)
    }
    throw new BridgeError('Network', `tx ${hash} was accepted but isn't in a block after ${Math.round(inclusionTimeoutMs / 1000)}s; check an explorer before trying again`)
  }

  return {
    address,

    async simulateSend(ids, recipient) {
      try {
        return (await prepare(ids, recipient)).estimate
      } catch (e) {
        throw toHubError(e, ids)
      }
    },

    async send(ids, recipient, options) {
      const stage = stageReporter(options?.onStage)
      try {
        return await sendTx(ids, recipient, stage.report)
      } finally {
        stage.done()
      }
    },

    async nudge(sourceClientId, recipient, options) {
      const stage = stageReporter(options?.onStage)
      try {
        return await nudgeTx(sourceClientId, recipient, stage.report)
      } finally {
        stage.done()
      }
    },
  }
}
