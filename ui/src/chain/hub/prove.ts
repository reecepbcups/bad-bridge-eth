// A single escrow record's ICS-23 membership proof, plus the block header needed to rebuild the light
// client's ConsensusState. Ports the old Rust batcher's store_key/prove_at/header, scoped to one
// token id: the browser page only ever proves the connected wallet's own kid, never a full batch.

import { fromBase64, fromBech32, fromHex, toHex } from '@cosmjs/encoding'
import { CommitmentProof } from 'cosmjs-types/cosmos/ics23/v1/proofs'
import { MerkleProof } from 'cosmjs-types/ibc/core/commitment/v1/commitment'
import type { KidId } from '../types'
import { BridgeError } from '../types'
import { ChainError, EndpointError, type Http, type Transport } from './transport'

/** wasmd's ContractStorePrefix byte. */
const CONTRACT_STORE_PREFIX = 0x03
/** ASCII 'b': the escrow contract's pending-records Map namespace (cross-checked on-chain, BadBridge.sol's parse()). */
const RECORD_NAMESPACE = 0x62

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The 38-byte wasmd store key for one escrow record: 0x03 || escrowRaw(32) || 'b' || tokenId (u32 BE). */
export function storeKey(escrowRaw: Uint8Array, tokenId: KidId): Uint8Array {
  if (escrowRaw.length !== 32) throw new BridgeError('Unknown', `escrow address must be 32 raw bytes, got ${escrowRaw.length}`)
  const key = new Uint8Array(38)
  key[0] = CONTRACT_STORE_PREFIX
  key.set(escrowRaw, 1)
  key[33] = RECORD_NAMESPACE
  new DataView(key.buffer).setUint32(34, tokenId, false)
  return key
}

/** Decodes a bech32 contract address (any prefix) to its raw 32 bytes. */
export function escrowRaw(bech32Address: string): Uint8Array {
  const { data } = fromBech32(bech32Address)
  if (data.length !== 32) throw new BridgeError('Unknown', `"${bech32Address}" isn't a 32-byte contract address`)
  return data
}

/** An ICS-23 membership proof of one wasm store key, at a specific height. */
export interface StoreProof {
  /** The raw value at the key: the escrow record's 20-byte eth recipient. */
  value: Uint8Array
  /** ibc.core.commitment.v1.MerkleProof, protobuf-encoded — feeds straight into SP1Stdin. */
  merkleProofBytes: Uint8Array
}

/**
 * Ports hub.rs's prove_at: an ICS-23 membership proof of `key` in the wasm store, as of `height`. Tries
 * every configured RPC endpoint (the Rust service only tries the first; this is strictly safer). Returns
 * null if the key isn't in the store yet at that height — the record is newer than the light client's
 * latest height, so the caller should try again once Ethereum's light client has advanced.
 */
export async function proveAt(t: Transport, height: number, key: Uint8Array): Promise<StoreProof | null> {
  return t.run('store proof', {
    async rpc(base: string, http: Http): Promise<StoreProof | null> {
      const result = await http.rpc(base, 'abci_query', {
        path: '/store/wasm/key',
        data: toHex(key),
        height: String(height),
        prove: true,
      })
      const response = isRecord(result) && isRecord(result.response) ? result.response : null
      if (!response) throw new EndpointError(`${base} abci_query: no response`)
      const code = typeof response.code === 'number' ? response.code : 0
      if (code !== 0) {
        const log = typeof response.log === 'string' ? response.log : `abci code ${code}`
        // Historical state availability differs by node; an archive fallback may still have this height.
        if (/pruned|version does not exist|height .*not available/i.test(log)) throw new EndpointError(log)
        throw new ChainError(log, code)
      }

      const value = typeof response.value === 'string' ? fromBase64(response.value) : new Uint8Array()
      if (value.length === 0) return null

      const ops = isRecord(response.proofOps) && Array.isArray(response.proofOps.ops) ? response.proofOps.ops : null
      if (!ops || ops.length !== 2) {
        throw new BridgeError('Unknown', `${base} abci_query: expected 2 proof ops (iavl, multistore), got ${ops?.length ?? 0}`)
      }
      const proofs = ops.map((op, i) => {
        if (!isRecord(op) || typeof op.data !== 'string') throw new BridgeError('Unknown', `${base} abci_query: proof op ${i} has no data`)
        return CommitmentProof.decode(fromBase64(op.data))
      })
      const merkleProofBytes = MerkleProof.encode({ proofs }).finish()
      return { value, merkleProofBytes }
    },
  })
}

/** The block-header facts a ConsensusState is rebuilt from. */
export interface ProofHeader {
  /** Block time as nanoseconds since the epoch — ConsensusState.timestamp is uint128 nanoseconds. */
  timestampNs: bigint
  /** 32-byte app hash — ConsensusState.root. */
  appHash: Uint8Array
  /** 32-byte next validators hash — ConsensusState.nextValidatorsHash. */
  nextValidatorsHash: Uint8Array
}

/** RFC3339 with up to nanosecond fractional seconds (CometBFT's block time format) to nanoseconds since epoch. */
function rfc3339ToNanos(s: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(s)
  if (!m) throw new BridgeError('Unknown', `bad block time: ${s}`)
  const wholeSecondMs = Date.parse(`${m[1]}Z`)
  if (Number.isNaN(wholeSecondMs)) throw new BridgeError('Unknown', `bad block time: ${s}`)
  const fracNanos = (m[2] ?? '').padEnd(9, '0').slice(0, 9)
  return BigInt(wholeSecondMs / 1000) * 1_000_000_000n + BigInt(fracNanos)
}

/** Ports hub.rs's header(): the block header at `height`, trimmed to what a ConsensusState needs. */
export async function proofHeader(t: Transport, height: number): Promise<ProofHeader> {
  return t.run(`block ${height} header`, {
    async rpc(base: string, http: Http): Promise<ProofHeader> {
      const result = await http.rpc(base, 'block', { height: String(height) })
      const block = isRecord(result) && isRecord(result.block) ? result.block : null
      const header = block && isRecord(block.header) ? block.header : null
      if (!header || typeof header.time !== 'string' || typeof header.app_hash !== 'string' || typeof header.next_validators_hash !== 'string') {
        throw new EndpointError(`${base} block ${height}: no header`)
      }
      const appHash = fromHex(header.app_hash)
      const nextValidatorsHash = fromHex(header.next_validators_hash)
      if (appHash.length !== 32 || nextValidatorsHash.length !== 32) {
        throw new BridgeError('Unknown', `${base} block ${height}: app_hash/next_validators_hash aren't 32 bytes`)
      }
      return { timestampNs: rfc3339ToNanos(header.time), appHash, nextValidatorsHash }
    },
  })
}
