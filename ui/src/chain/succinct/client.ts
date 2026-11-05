// Orchestrates a single Groth16 proof request against Succinct's mainnet prover network: checks the
// membership program is registered, uploads the SP1Stdin artifact, fetches live auction parameters and a
// prover whitelist (no guessed/hardcoded values for those — see the build plan's "biggest open risk" note),
// signs and submits the request, then polls until fulfilled and downloads+decodes the Groth16 proof. Every
// field number, enum value and default here was read directly off sp1-sdk 6.1.0's source in
// ~/.cargo/registry (network/{client,prover,utils}.rs and network/proto/**), not guessed.

import { bytesToHex, formatUnits, hexToBytes, type Account, type Address, type Chain, type Client, type Hex, type Transport } from 'viem'
import { BridgeError } from '../types'
import { GrpcError, grpcWebCall } from './grpcweb'
import { decodeGroth16ProofFromNetwork, type DecodedGroth16Proof } from './proof'
import { signBytes, signCreateArtifact } from './sign'
import { MessageReader, MessageWriter } from './wire'
import { zstdCompress } from './zstd'

// Duplicated from eth/writer.ts's SignerClient — see sign.ts's comment on why this isn't imported.
type SignerClient = Client<Transport, Chain | undefined, Account>

/** sp1-prover 6.1.0 and 6.8.0 (this repo's Cargo.lock resolves both, for different deps) both pin this. */
const SP1_CIRCUIT_VERSION = 'v6.1.0'
const PROOF_MODE_GROTH16 = 4
const FULFILLMENT_STRATEGY_AUCTION = 3
const ARTIFACT_TYPE_PROGRAM = 1
const ARTIFACT_TYPE_STDIN = 2
const MESSAGE_FORMAT_BINARY = 1
const TRANSACTION_VARIANT_REQUEST = 0
const FULFILLMENT_STATUS_FULFILLED = 3
const FULFILLMENT_STATUS_UNFULFILLABLE = 4
/** Standard gRPC status code. */
const GRPC_NOT_FOUND = 5

/** sp1-sdk's MAINNET_DEFAULT_CYCLE_LIMIT / DEFAULT_GAS_LIMIT: the skip_simulation defaults, since this
 * client never runs the guest program locally to measure real usage. Pricing is by actual cycles used
 * during proving, not by this ceiling — it's a worst-case bound, same as an Ethereum gas limit. */
const DEFAULT_GAS_LIMIT = 1_000_000_000n
const DEFAULT_CYCLE_LIMIT = 1_000_000_000_000n
/** What a request reserves is base_fee + max_price_per_pgu * this, so 1e9 reserved 0.86 PROVE for a proof that
 * costs about 0.335. A real proof of 8 to 10 kids used 2.76M PGUs (measured 2026-09-28), 10M leaves room for a 50 kid
 * send and still reserves only about 0.338, under the 0.34 PROVE gate. Too low and the request comes back unfulfillable. */
const REQUEST_GAS_LIMIT = 10_000_000n
/** Maximum PROVE this UI may authorize for one proof, in 18-decimal base units. */
export const MAX_PROOF_COST = 34n * 10n ** 16n

export interface ProofQuote {
  /** The maximum charge authorized by the exact request being signed. */
  maxCost: bigint
}

export function proofQuote(baseFee: string, maxPricePerPgu: string): ProofQuote {
  if (![baseFee, maxPricePerPgu].every((value) => /^\d{1,78}$/.test(value))) {
    throw new BridgeError('Unknown', 'the prover returned an invalid fee')
  }
  const maxCost = BigInt(baseFee) + BigInt(maxPricePerPgu) * REQUEST_GAS_LIMIT
  if (maxCost > MAX_PROOF_COST) {
    throw new BridgeError('FeeTooHigh', `this proof could cost ${formatUnits(maxCost, 18)} PROVE, above the ${formatUnits(MAX_PROOF_COST, 18)} PROVE limit`)
  }
  return { maxCost }
}

/** Ports sp1-sdk's calculate_timeout_from_gas_limit: 5 min floor, 4 hour ceiling, gas_limit/2M in between. */
function calculateTimeoutSecs(gasLimit: bigint): bigint {
  const base = 300n
  const gasBased = gasLimit / 2_000_000n
  const t = gasBased > base ? gasBased : base
  return t < 14400n ? t : 14400n
}

function nowSecs(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type SuccinctStage = 'uploading-stdin' | 'requesting-proof' | 'proving'

/** The network's own status for a submitted request, from each GetProofRequestStatus poll. */
export interface ProofRequestProgress {
  requestId: Hex
  fulfillmentStatus: 'requested' | 'assigned' | 'fulfilled' | 'unfulfillable'
}

const FULFILLMENT_STATUS_NAMES: Readonly<Record<number, ProofRequestProgress['fulfillmentStatus']>> = {
  1: 'requested',
  2: 'assigned',
  3: 'fulfilled',
  4: 'unfulfillable',
}

export interface RequestGroth16ProofOptions {
  wallet: SignerClient
  /** BadBridge's on-chain MEMBERSHIP_PROGRAM_VKEY. */
  vkHash: Hex
  /** bincode-encoded SP1Stdin (hub/stdin.ts's encodeSp1Stdin output), not yet zstd-compressed. */
  stdinBytes: Uint8Array
  onStage?: (stage: SuccinctStage) => void
  /** Must approve the bounded quote before any artifact or proof signature is requested. */
  confirmQuote?: (quote: ProofQuote) => Promise<boolean>
  /** Persist recovery intent after signing and before a paid request leaves the browser. May throw to stop submission. */
  onRequestSubmitting?: () => void
  /** Called with the request id as soon as it's submitted, then on every status poll. */
  onProgress?: (progress: ProofRequestProgress) => void
  /** How often to poll GetProofRequestStatus while proving. Default 5s. */
  pollMs?: number
  fetchImpl?: typeof fetch
}

async function call(path: string, body: Uint8Array, fetchImpl: typeof fetch): Promise<MessageReader> {
  return new MessageReader(await grpcWebCall(path, body, fetchImpl))
}

async function getNonce(address: Address, fetchImpl: typeof fetch): Promise<bigint> {
  const req = new MessageWriter().bytes32(1, hexToBytes(address)).finish()
  const res = await call('/network.ProverNetwork/GetNonce', req, fetchImpl)
  return res.uint64(1) ?? 0n
}

export async function isProgramRegistered(vkHash: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const req = new MessageWriter().bytes32(1, vkHash).finish()
  try {
    const res = await call('/network.ProverNetwork/GetProgram', req, fetchImpl)
    return res.has(1)
  } catch (e) {
    // Live-verified (this session): an unregistered vk_hash answers NOT_FOUND, not "found: false" — the
    // network doesn't have a not-found-but-successful shape for this, it's a genuine grpc-status error.
    if (e instanceof GrpcError && e.code === GRPC_NOT_FOUND) return false
    throw e
  }
}

/**
 * The address's PROVE balance deposited on Succinct's network (what RequestProof draws from) — not its
 * ERC20 wallet balance, which is a separate, unrelated number. Wei-like base units (18 decimals), as a
 * stringified integer over the wire (`GetBalanceResponse.amount`); no signature needed, just the address.
 * Live-verified (this session): a real zero-balance address returns amount "0" over a real grpc-web call.
 */
export async function getProveBalance(address: Address, fetchImpl: typeof fetch = fetch): Promise<bigint> {
  const req = new MessageWriter().bytes32(1, hexToBytes(address)).finish()
  const res = await call('/network.ProverNetwork/GetBalance', req, fetchImpl)
  const amount = res.string(1)
  if (amount === undefined || !/^\d+$/.test(amount)) throw new BridgeError('Unknown', `GetBalance: unexpected amount ${JSON.stringify(amount)}`)
  return BigInt(amount)
}

interface AuctionParams {
  domain: Uint8Array
  auctioneer: Uint8Array
  executor: Uint8Array
  verifier: Uint8Array
  treasury: Uint8Array
  maxPricePerPgu: string
  baseFee: string
}

async function getProofRequestParams(fetchImpl: typeof fetch): Promise<AuctionParams> {
  const req = new MessageWriter().enum(1, PROOF_MODE_GROTH16).finish()
  const res = await call('/network.ProverNetwork/GetProofRequestParams', req, fetchImpl)
  return {
    domain: res.bytes(1) ?? new Uint8Array(),
    auctioneer: res.bytes(2) ?? new Uint8Array(),
    executor: res.bytes(3) ?? new Uint8Array(),
    verifier: res.bytes(4) ?? new Uint8Array(),
    maxPricePerPgu: res.string(5) ?? '0',
    baseFee: res.string(6) ?? '0',
    treasury: res.bytes(7) ?? new Uint8Array(),
  }
}

/** high_availability_only: false is the field's proto3 zero value, so the request body is empty. */
async function getProversByUptime(fetchImpl: typeof fetch): Promise<Uint8Array[]> {
  const res = await call('/network.ProverNetwork/GetProversByUptime', new Uint8Array(), fetchImpl)
  return res.repeatedBytes(1)
}

async function createArtifact(
  wallet: SignerClient,
  artifactType: number,
  fetchImpl: typeof fetch,
): Promise<{ artifactUri: string; presignedUrl: string }> {
  const signature = await signCreateArtifact(wallet)
  const req = new MessageWriter().bytes32(1, signature).enum(2, artifactType).finish()
  const res = await call('/artifact.ArtifactStore/CreateArtifact', req, fetchImpl)
  const artifactUri = res.string(1)
  const presignedUrl = res.string(2)
  if (!artifactUri || !presignedUrl) throw new BridgeError('Unknown', 'CreateArtifact: missing artifact_uri/artifact_presigned_url')
  return { artifactUri, presignedUrl }
}

/** scripts/artifact-proxy.mjs's own default (see its PORT constant). */
const DEFAULT_DEV_ARTIFACT_PROXY_URL = 'http://127.0.0.1:8787'

/**
 * Dev-only local relay (scripts/artifact-proxy.mjs) for the S3 PUT below. Defaults to that script's own
 * default port whenever this is a dev build (`import.meta.env.DEV`), so `pnpm dev` works out of the box as
 * long as the proxy script happens to be running — no env var to remember. Override with
 * VITE_ARTIFACT_PROXY_URL if it's running elsewhere. Never defaults in a production build: the direct PUT is
 * what's actually shipped there, and it stays broken until Succinct adds a CORS policy for that bucket
 * (live-verified: the OPTIONS preflight itself gets HTTP 403).
 */
const ARTIFACT_PROXY_URL =
  (import.meta.env.VITE_ARTIFACT_PROXY_URL as string | undefined)?.trim() || (import.meta.env.DEV ? DEFAULT_DEV_ARTIFACT_PROXY_URL : undefined)

async function uploadArtifact(presignedUrl: string, bytes: Uint8Array, fetchImpl: typeof fetch): Promise<void> {
  const target = ARTIFACT_PROXY_URL ? `${ARTIFACT_PROXY_URL}/upload?url=${encodeURIComponent(presignedUrl)}` : presignedUrl
  let res: Response
  try {
    res = await fetchImpl(target, { method: 'PUT', body: new Blob([new Uint8Array(bytes)]) })
  } catch (e) {
    throw new BridgeError(
      'ArtifactUploadBlocked',
      "browsers can't upload to Succinct's artifact bucket directly yet (no CORS policy there) — run `node scripts/artifact-proxy.mjs` and set VITE_ARTIFACT_PROXY_URL",
      { cause: e },
    )
  }
  if (!res.ok) throw new BridgeError('Network', `artifact upload: HTTP ${res.status}`)
}

/** bincode's `Vec<u8>` encoding: u64 LE length, then the raw bytes — what create_artifact_with_content::<Vec<u8>>
 * wraps a raw byte artifact (like the ELF) in before zstd-compressing it. Unlike the stdin artifact, whose
 * bytes are already a full bincode-encoded struct (see hub/stdin.ts's encodeSp1Stdin). */
function bincodeVecU8(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + bytes.length)
  new DataView(out.buffer).setBigUint64(0, BigInt(bytes.length), true)
  out.set(bytes, 8)
  return out
}

function buildRequestBody(opts: {
  nonce: bigint
  vkHash: Uint8Array
  stdinUri: string
  deadline: bigint
  cycleLimit: bigint
  gasLimit: bigint
  whitelist: readonly Uint8Array[]
  params: AuctionParams
}): Uint8Array {
  return new MessageWriter()
    .uint64(1, opts.nonce)
    .bytes32(2, opts.vkHash)
    .string(3, `sp1-${SP1_CIRCUIT_VERSION}`)
    .enum(4, PROOF_MODE_GROTH16)
    .enum(5, FULFILLMENT_STRATEGY_AUCTION)
    .string(6, opts.stdinUri)
    .uint64(7, opts.deadline)
    .uint64(8, opts.cycleLimit)
    .uint64(9, opts.gasLimit)
    .uint64(10, 0n) // min_auction_period
    .repeatedBytes(11, opts.whitelist)
    .bytes32(12, opts.params.domain)
    .bytes32(13, opts.params.auctioneer)
    .bytes32(14, opts.params.executor)
    .bytes32(15, opts.params.verifier)
    // 16 public_values_hash: omitted — this client never runs the guest program locally to compute it
    .string(17, opts.params.baseFee)
    .string(18, opts.params.maxPricePerPgu)
    .enum(19, TRANSACTION_VARIANT_REQUEST)
    .bytes32(20, opts.params.treasury)
    .finish()
}

async function requestProof(wallet: SignerClient, body: Uint8Array, fetchImpl: typeof fetch, onRequestSubmitting?: () => void): Promise<Uint8Array> {
  const signature = await signBytes(wallet, body)
  const req = new MessageWriter().enum(1, MESSAGE_FORMAT_BINARY).bytes32(2, signature).message(3, body).finish()
  onRequestSubmitting?.()
  const res = await call('/network.ProverNetwork/RequestProof', req, fetchImpl)
  const requestId = res.message(2)?.bytes(1)
  if (!requestId) throw new BridgeError('Unknown', 'RequestProof: no request_id in response')
  return requestId
}

const NONCE_MISMATCH_RE = /failed nonce verification:.*expected (\d+), got \d+/

/**
 * Calls requestProof, and if it's rejected as a nonce mismatch, retries once with whatever nonce the
 * rejection itself says is expected. Live-verified (this session): Succinct's mainnet network can answer
 * GetNonce with a value its own RequestProof endpoint then rejects — reproduced with byte-identical request
 * bodies where only the nonce field differed, and only the network's own "expected" number was ever accepted
 * (confirmed independently of signing: a locally-held test key's signature verified correctly against itself
 * either way, so this isn't a client-side signing bug). A server-side GetNonce/RequestProof inconsistency,
 * not something this client can avoid up front — so it just adapts.
 */
export async function requestProofWithNonceRetry(
  wallet: SignerClient,
  buildBody: (nonce: bigint) => Uint8Array,
  nonce: bigint,
  fetchImpl: typeof fetch,
  onRequestSubmitting?: () => void,
): Promise<Uint8Array> {
  try {
    return await requestProof(wallet, buildBody(nonce), fetchImpl, onRequestSubmitting)
  } catch (e) {
    const match = e instanceof GrpcError ? NONCE_MISMATCH_RE.exec(e.message) : null
    if (!match?.[1]) throw e
    return requestProof(wallet, buildBody(BigInt(match[1])), fetchImpl, onRequestSubmitting)
  }
}

interface StatusResult {
  fulfillmentStatus: number
  proofUri: string | undefined
}

async function getProofRequestStatus(requestId: Uint8Array, fetchImpl: typeof fetch): Promise<StatusResult> {
  const req = new MessageWriter().bytes32(1, requestId).finish()
  const res = await call('/network.ProverNetwork/GetProofRequestStatus', req, fetchImpl)
  return { fulfillmentStatus: res.enumValue(1) ?? 0, proofUri: res.string(6) }
}

async function downloadArtifact(uri: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  // Same CORS gap as the upload, see uploadArtifact.
  const target = ARTIFACT_PROXY_URL ? `${ARTIFACT_PROXY_URL}/download?url=${encodeURIComponent(uri)}` : uri
  let res: Response
  try {
    res = await fetchImpl(target)
  } catch (e) {
    throw new BridgeError(
      'ArtifactUploadBlocked',
      "browsers can't download from Succinct's artifact bucket directly yet (no CORS policy there). Run `node scripts/artifact-proxy.mjs` and set VITE_ARTIFACT_PROXY_URL",
      { cause: e },
    )
  }
  if (!res.ok) throw new BridgeError('Network', `proof download: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Requests a Groth16 membership proof from Succinct's mainnet network and waits for it to be fulfilled.
 * `stage` goes uploading-stdin → requesting-proof → proving. Rejects with a BridgeError.
 */
export async function requestGroth16Proof(opts: RequestGroth16ProofOptions): Promise<DecodedGroth16Proof> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const vkHash = hexToBytes(opts.vkHash)
  const address = opts.wallet.account.address

  if (!(await isProgramRegistered(vkHash, fetchImpl))) {
    throw new BridgeError('ProgramNotRegistered', 'the membership program is not registered on the Succinct network yet')
  }

  const [nonce, params, whitelist] = await Promise.all([getNonce(address, fetchImpl), getProofRequestParams(fetchImpl), getProversByUptime(fetchImpl)])
  const quote = proofQuote(params.baseFee, params.maxPricePerPgu)
  if (!opts.confirmQuote || !(await opts.confirmQuote(quote))) {
    throw new BridgeError('UserRejected', 'proof request cancelled before signing')
  }

  opts.onStage?.('uploading-stdin')
  const compressed = await zstdCompress(opts.stdinBytes)
  const { artifactUri, presignedUrl } = await createArtifact(opts.wallet, ARTIFACT_TYPE_STDIN, fetchImpl)
  await uploadArtifact(presignedUrl, compressed, fetchImpl)

  opts.onStage?.('requesting-proof')
  const deadline = nowSecs() + calculateTimeoutSecs(DEFAULT_GAS_LIMIT)
  const buildBody = (n: bigint) =>
    buildRequestBody({
      nonce: n,
      vkHash,
      stdinUri: artifactUri,
      deadline,
      cycleLimit: DEFAULT_CYCLE_LIMIT,
      gasLimit: REQUEST_GAS_LIMIT,
      whitelist,
      params,
    })
  const requestId = await requestProofWithNonceRetry(opts.wallet, buildBody, nonce, fetchImpl, opts.onRequestSubmitting)

  opts.onStage?.('proving')
  opts.onProgress?.({ requestId: bytesToHex(requestId), fulfillmentStatus: 'requested' })
  return waitForProof(requestId, { deadline, onProgress: opts.onProgress, pollMs: opts.pollMs, fetchImpl })
}

export interface WaitForProofOptions {
  /** Unix seconds after which an unfulfilled request is given up on. Unset: wait as long as the network says it's live. */
  deadline?: bigint | number
  onProgress?: (progress: ProofRequestProgress) => void
  /** How often to poll GetProofRequestStatus. Default 5s. */
  pollMs?: number
  fetchImpl?: typeof fetch
}

/** Polls a request until it's fulfilled, then downloads and decodes its Groth16 proof. Needs no signature. */
export async function waitForProof(requestId: Uint8Array, opts: WaitForProofOptions = {}): Promise<DecodedGroth16Proof> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const requestIdHex = bytesToHex(requestId)
  const pollMs = opts.pollMs ?? 5000
  for (;;) {
    const status = await getProofRequestStatus(requestId, fetchImpl)
    const name = FULFILLMENT_STATUS_NAMES[status.fulfillmentStatus]
    if (name) opts.onProgress?.({ requestId: requestIdHex, fulfillmentStatus: name })
    if (status.fulfillmentStatus === FULFILLMENT_STATUS_FULFILLED) {
      if (!status.proofUri) throw new BridgeError('Unknown', 'proof fulfilled but no proof_uri in the status response')
      return decodeGroth16ProofFromNetwork(await downloadArtifact(status.proofUri, fetchImpl))
    }
    if (status.fulfillmentStatus === FULFILLMENT_STATUS_UNFULFILLABLE) {
      throw new BridgeError('Unknown', 'the proof request became unfulfillable')
    }
    if (opts.deadline !== undefined && nowSecs() > BigInt(opts.deadline)) {
      throw new BridgeError('Unknown', 'the proof request passed its deadline without being fulfilled')
    }
    await sleep(pollMs)
  }
}

export interface RegisterProgramOptions {
  wallet: SignerClient
  vkHash: Hex
  /** bincode(SP1VerifyingKey) for this exact ELF — computed once, offline (setup() needs no network access),
   * and shipped as a constant, since deriving it needs the actual SP1 prover's setup step, not something a
   * browser can run. See chain/prove.ts for where this lives. */
  vk: Uint8Array
  elf: Uint8Array
  fetchImpl?: typeof fetch
}

/**
 * Registers a guest program on Succinct's network — the one-time step RequestProof needs before it'll accept
 * that vk_hash. A no-op if it's already registered. Anyone can register any program; it's not gated to
 * whoever built it, same as everything else on this network.
 */
export async function registerProgram(opts: RegisterProgramOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const vkHashBytes = hexToBytes(opts.vkHash)
  if (await isProgramRegistered(vkHashBytes, fetchImpl)) return

  const { artifactUri, presignedUrl } = await createArtifact(opts.wallet, ARTIFACT_TYPE_PROGRAM, fetchImpl)
  const compressed = await zstdCompress(bincodeVecU8(opts.elf))
  await uploadArtifact(presignedUrl, compressed, fetchImpl)

  const nonce = await getNonce(opts.wallet.account.address, fetchImpl)
  const body = new MessageWriter().uint64(1, nonce).bytes32(2, vkHashBytes).bytes32(3, opts.vk).string(4, artifactUri).finish()
  const signature = await signBytes(opts.wallet, body)
  const req = new MessageWriter().enum(1, MESSAGE_FORMAT_BINARY).bytes32(2, signature).message(3, body).finish()
  await call('/network.ProverNetwork/CreateProgram', req, fetchImpl)
}
