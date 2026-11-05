// The contract between the UI and the chain adapters (hub/, eth/, demo/). Adapter-agnostic on purpose:
// nothing here knows about cosmjs, wagmi or graz. Every async method rejects with a BridgeError.

import type { Address, Hex } from 'viem'

/** A kid's token id. The same number on both chains: a u32, canonical decimal on the Hub. */
export type KidId = number
/**
 * Most kids one Hub send may carry. Each send_nft costs ~312k gas with headroom and the Hub's block gas limit is
 * 75M; the UI and writer conservatively cap each send at 50 kids.
 */
export const MAX_KIDS_PER_SEND = 50
/** 0x Ethereum address. Adapters return it checksummed. */
export type EthAddress = Address
/** bech32 Cosmos Hub account address (cosmos1…). */
export type HubAddress = string

/** An escrow record: the kid is locked on the Hub and bound to this Ethereum recipient. */
export interface EscrowRecord {
  /** The kid. */
  tokenId: KidId
  /** Where the kid gets minted, checksummed. */
  recipient: EthAddress
}

/** The Hub tx that sent a kid into the escrow, as found by tx search. */
export interface SendInfo {
  /** The kid. */
  tokenId: KidId
  /** Hub tx hash, uppercase hex without 0x (the form Mintscan links use). */
  txHash: string
  /** Hs: the height the tx landed in. The record is in state after this block. */
  height: number
  /** Hub address that sent the kid. */
  sender: HubAddress
  /** Recipient from the tx's eth_recipient attribute, checksummed. */
  recipient: EthAddress
  /** Block time of the tx, when the source returns it (REST does, RPC tx_search doesn't). */
  time?: Date
}

/** A Hub block header, trimmed to what the UI needs. */
export interface HubBlock {
  /** Block height. */
  height: number
  /** Block time. Also the app's notion of "now" for chain-relative copy. */
  time: Date
}

/** Ethereum's light client of the Hub, permanently pinned by BadBridge at deployment. */
export interface ClientStatus {
  /** Latest Hub height Ethereum has seen (latestHeight.revisionHeight). */
  latestHeight: number
  /** A frozen client verifies nothing: new kids can't be proven. Already-proven kids can still be claimed. */
  frozen: boolean
}

/** Whether the pinned client can still accept new Hub updates. Checked again before every send. */
export interface ClientSafety {
  frozen: boolean
  expired: boolean
  retired: boolean
}

/** One kid's state on Ethereum. */
export interface KidEthStatus {
  /** bridge.proven(id): the proven recipient, or null until a proof lands. */
  proven: EthAddress | null
  /** bridge.ownerOf(id): the current owner, or null until minted. */
  owner: EthAddress | null
}

/** A CosmWasm contract's on-chain metadata (`contract_info`). */
export interface ContractInfo {
  /** Code id it runs. */
  codeId: number
  /** Who can migrate (upgrade) it. null when nobody can. */
  admin: HubAddress | null
}

/** How BadBridge reaches IBC Eureka's light client of the Hub, read live, for the startup sanity check. */
export interface BridgeWiring {
  /** bridge.ROUTER(): the Eureka router it asks for its client. */
  router: EthAddress
  /** bridge.clientId(): the Eureka client id it asks the router for. */
  clientId: string
  /** bridge.lightClient(): the immutable client selected at bridge deployment. */
  lightClient: EthAddress
  /** clientState().chainId of that light client: the chain it follows. */
  chainId: string
}

/** What a claim would cost right now. Amounts in wei, as integer strings. */
export interface ClaimEstimate {
  /** Gas it should use: simulated when every kid can be claimed now, else typical mainnet figures. */
  gas: number
  /** The network's current gas price. */
  gasPrice: string
  /** gas × gasPrice. */
  fee: string
  /** True when `gas` came from simulating these exact kids. */
  simulated: boolean
}

/** Result of simulating a send. */
export interface SendEstimate {
  /** Gas limit the tx will use, safety margin included. */
  gas: number
  /** Fee in the smallest unit of `denom`, as an integer string. */
  amount: string
  /** Fee denom, e.g. uatom. */
  denom: string
}

/** A broadcast Hub send that made it into a block. */
export interface SendResult {
  /** Hub tx hash, uppercase hex without 0x. */
  txHash: string
  /** Hs: the height it landed in. */
  height: number
}

/** A mined Ethereum claim. */
export interface ClaimResult {
  /** Ethereum tx hash. */
  txHash: Hex
  /** Ids actually included in the successful claim (a Multicall3 batch can drop some; see sortClaimable). */
  claimed: KidId[]
}

/** Read-only Hub queries (REST with RPC fallback in the real adapter). */
export interface HubReader {
  /** Kids `owner` holds in the cw721, every page, ascending. */
  ownedKids(owner: HubAddress): Promise<KidId[]>
  /** The escrow record for one kid, or null if it never left the Hub. */
  record(id: KidId): Promise<EscrowRecord | null>
  /** Every escrow record, ascending by id (pages through `pending`). */
  allRecords(): Promise<EscrowRecord[]>
  /** The send tx for one kid, or null if tx search can't find it (then Hs is unknown: don't guess). */
  sendInfo(id: KidId): Promise<SendInfo | null>
  /** Every send made by `sender`, newest first. */
  sendsBy(sender: HubAddress): Promise<SendInfo[]>
  /** The latest Hub block. */
  latestBlock(): Promise<HubBlock>
  /** The Hub block at `height`. */
  block(height: number): Promise<HubBlock>
  /** The cw721 the escrow accepts (escrow `config {}`), for the startup sanity check. */
  escrowCw721(): Promise<HubAddress>
  /** A contract's code id and admin, for the trust facts on About. */
  contractInfo(address: HubAddress): Promise<ContractInfo>
  /** Internal emergency-unlock authority, separate from the CosmWasm migration admin. */
  escrowAdmin(): Promise<HubAddress | null>
}

/** Read-only Ethereum queries (viem, batched through Multicall3 in the real adapter). */
export interface EthReader {
  /** The Hub light client's height and frozen flag, via bridge.lightClient(). */
  client(): Promise<ClientStatus>
  /** Anchors the latest Hub timestamp to Ethereum and checks expiry and the router's current client. */
  clientSafety(): Promise<ClientSafety>
  /** proven(id) and ownerOf(id) for every id, batched. Every requested id is a key in the map. */
  kidStatus(ids: readonly KidId[]): Promise<Map<KidId, KidEthStatus>>
  /** True if `address` has code, so the UI can warn before minting to a contract. */
  isContract(address: EthAddress): Promise<boolean>
  /** bridge.ESCROW(): the raw 32-byte escrow address as 0x hex, for the startup sanity check. */
  bridgeEscrow(): Promise<Hex>
  /** bridge.ROUTER(), bridge.clientId(), bridge.lightClient() and that client's chain id, for the startup sanity check. */
  bridgeWiring(): Promise<BridgeWiring>
  /** The EIP-1967 implementation behind `address`, or null if the slot is empty (not an upgradeable proxy). */
  proxyImplementation(address: EthAddress): Promise<EthAddress | null>
  /**
   * What claiming `ids` would cost now. Simulated when every kid is proven and unminted; otherwise typical
   * mainnet gas for that many kids. An empty list prices one typical kid without simulating.
   */
  estimateClaim(ids: readonly KidId[]): Promise<ClaimEstimate>
  /**
   * The Hub-side Eureka client id for Ethereum (the router's counterparty of `bridge.clientId()`), read live
   * from the router. This is the `sourceChannel` a Hub MsgTransfer needs to reach Ethereum; it isn't pinned in
   * config because the router can repoint it on a client migration.
   */
  hubClientId(): Promise<string>
}

/**
 * Where a Hub send is, in order:
 * - `simulating`: checking the tx with the Hub. The wallet isn't open yet.
 * - `signing`: the wallet prompt is up, waiting for the user.
 * - `broadcasting`: signed; handing it to the Hub and waiting for a block.
 */
export type SendStage = 'simulating' | 'signing' | 'broadcasting'

/** Options for HubWriter.send. */
export interface SendOptions {
  /** Called as the send reaches each stage. Never called after the promise settles; a callback that throws is ignored. */
  onStage?: (stage: SendStage) => void
}

/**
 * Where an Ethereum claim is, in order:
 * - `signing`: re-checked and simulated; the wallet prompt is up.
 * - `confirming`: signed and sent; waiting for it to be mined.
 */
export type ClaimStage = 'signing' | 'confirming'

/**
 * Where a submitBatch call is, in order:
 * - `signing`: simulated; the wallet prompt is up.
 * - `confirming`: signed and sent; waiting for it to be mined.
 */
export type BatchStage = 'signing' | 'confirming'

/** Options for EthWriter.submitBatch (or the standalone submitBatch, on writers that don't carry it). */
export interface BatchOptions {
  /** Called as the call reaches each stage. Never called after the promise settles; a callback that throws is ignored. */
  onStage?: (stage: BatchStage) => void
}

/** BadBridge.sol's ConsensusState struct — an input to submitBatch. */
export interface ConsensusStateArgs {
  /** Nanoseconds since the epoch. */
  timestamp: bigint
  /** 32-byte app hash. */
  root: Hex
  /** 32-byte next validators hash. */
  nextValidatorsHash: Hex
}

/** BadBridge.sol's SP1Proof struct — an input to submitBatch. */
export interface Sp1ProofArgs {
  vKey: Hex
  publicValues: Hex
  proof: Hex
}

/** A mined submitBatch call. */
export interface SubmitBatchResult {
  /** Ethereum tx hash. */
  txHash: Hex
}

/** Options for EthWriter.claim. */
export interface ClaimOptions {
  /** Called as the claim reaches each stage. Never called after the promise settles; a callback that throws is ignored. */
  onStage?: (stage: ClaimStage) => void
}

/** Hub transactions, bound to the connected Hub wallet. */
export interface HubWriter {
  /** The signing account. */
  address: HubAddress
  /** Simulates one tx that sends every kid to the escrow. Never opens the wallet. */
  simulateSend(ids: readonly KidId[], recipient: EthAddress): Promise<SendEstimate>
  /**
   * Simulates, then signs and broadcasts one tx with a send_nft per kid. Resolves once it's in a block.
   * `options.onStage` reports simulating → signing → broadcasting.
   */
  send(ids: readonly KidId[], recipient: EthAddress, options?: SendOptions): Promise<SendResult>
  /**
   * Sends a small ATOM ICS20 transfer to `recipient` over `sourceClientId` (from EthReader.hubClientId()), so a
   * relayer watching for ICS20 packets notices sooner and updates Ethereum's light client. A nudge, not a
   * guarantee: it doesn't change how proving or claiming works. `options.onStage` reports the same three stages
   * as send().
   */
  nudge(sourceClientId: string, recipient: EthAddress, options?: SendOptions): Promise<SendResult>
}

/** Ethereum transactions, bound to the connected Ethereum wallet. */
export interface EthWriter {
  /** The sending account. Who claims doesn't matter: kids always mint to their proven recipient. */
  address: EthAddress
  /**
   * Mints proven kids: claim(id) for one, Multicall3 aggregate3 for several. Resolves once mined.
   * `options.onStage` reports signing → confirming.
   */
  claim(ids: readonly KidId[], options?: ClaimOptions): Promise<ClaimResult>
}

/**
 * Wraps an onStage callback so the writers can call it freely: it's optional, a throw never reaches the
 * transaction, and it goes quiet once the write settles (call `done()`).
 */
export function stageReporter<S>(onStage: ((stage: S) => void) | undefined): { report: (stage: S) => void; done: () => void } {
  let open = onStage !== undefined
  return {
    report(stage) {
      if (!open) return
      try {
        onStage?.(stage)
      } catch {
        // progress is cosmetic: never let it break a transaction
      }
    },
    done() {
      open = false
    },
  }
}

/** Everything an adapter can fail with. The UI maps each code to kid-friendly copy. */
export type BridgeErrorCode =
  /** escrow: the cw721 isn't the collection it accepts */
  | 'WrongCollection'
  /** escrow: token id isn't a canonical u32 */
  | 'BadTokenId'
  /** escrow: recipient isn't 20 bytes, or a pasted address is malformed */
  | 'BadRecipient'
  /** escrow: recipient is the zero address */
  | 'ZeroRecipient'
  /** escrow: recipient is a well-formed burn or precompile address; a kid sent there could never move again */
  | 'BurnRecipient'
  /** escrow: this kid already has a record */
  | 'AlreadyBridged'
  /** cw721: the sending wallet doesn't own this kid (moved since the list loaded, or no such token) */
  | 'NotOwner'
  /** send: more than MAX_KIDS_PER_SEND kids in one tx */
  | 'TooManyKids'
  /** send: the simulated gas or the fee is far above what a send costs, so a Hub endpoint is likely lying */
  | 'FeeTooHigh'
  /** send: the offered fee is below what CheckTx wants right now; a gas-price problem, not a balance one */
  | 'FeeTooLow'
  /** send: Ethereum's light client of the Hub is frozen, so nothing new can be proven */
  | 'ClientFrozen'
  /** bridge: claim before the proof landed */
  | 'NotProven'
  /** prove: the guest program isn't registered on Succinct's network yet (a one-time, anyone-can-do-it step) */
  | 'ProgramNotRegistered'
  /** prove: the browser can't PUT artifacts to Succinct's S3 bucket directly (it has no CORS policy for
   * browsers) — dev-only, needs `node scripts/artifact-proxy.mjs` running locally */
  | 'ArtifactUploadBlocked'
  /** prove: the wallet's personal_sign came back from a different account than the one connected — the
   * extension had a different account active than the app expected */
  | 'WrongSigner'
  /** wallet: the user declined */
  | 'UserRejected'
  /** not enough ATOM or ETH for fees */
  | 'InsufficientFunds'
  /** wallet is on another chain and didn't switch */
  | 'WrongChain'
  /** this deployment has no escrow or bridge yet */
  | 'NotLive'
  /** every endpoint failed or timed out */
  | 'Network'
  /** anything else; `detail` has the raw message */
  | 'Unknown'

/** The only error type adapters throw. */
export class BridgeError extends Error {
  override readonly name = 'BridgeError'
  /** What went wrong, for picking copy. */
  readonly code: BridgeErrorCode
  /** Raw detail for logs and a "details" disclosure. Never the headline copy. */
  readonly detail: string | undefined
  /** The kid it's about, when the chain says (AlreadyBridged, NotProven). */
  readonly tokenId: KidId | undefined

  constructor(code: BridgeErrorCode, detail?: string, options?: { tokenId?: KidId; cause?: unknown }) {
    super(detail ? `${code}: ${detail}` : code, { cause: options?.cause })
    this.code = code
    this.detail = detail
    this.tokenId = options?.tokenId
  }
}

/** Type guard that also works across bundles (checks the name, not the prototype). */
export function isBridgeError(e: unknown): e is BridgeError {
  return e instanceof BridgeError || (e instanceof Error && e.name === 'BridgeError' && 'code' in e)
}

/** Passes BridgeErrors through and wraps anything else as Unknown. */
export function toBridgeError(e: unknown): BridgeError {
  if (isBridgeError(e)) return e
  const detail = e instanceof Error ? e.message : String(e)
  return new BridgeError('Unknown', detail, { cause: e })
}

/** Where a wallet connection is. */
export type WalletStatus = 'disconnected' | 'connecting' | 'connected'

/** A wallet the connect sheet can offer. */
export interface WalletOption {
  /** Stable id passed to connect(), e.g. "keplr" or "walletConnect". */
  id: string
  /** Display name, e.g. "Keplr". */
  name: string
  /** The extension is present. Always true for WalletConnect-style options. */
  installed: boolean
  /** Logo the wallet announced (EIP-6963 data URI), when there is one. */
  icon?: string
}

/** One chain's wallet connection. Same shape for the Hub and Ethereum. */
export interface WalletState<A extends string = string> {
  /** Connection state. */
  status: WalletStatus
  /** The connected account; set only while connected. */
  address?: A
  /** Name of the connected wallet, e.g. "Keplr" or "MetaMask", for "Check Keplr…" copy. */
  walletName?: string
  /** Wallets to offer, installed ones first. */
  options: WalletOption[]
  /** Connects the option with this id. Rejects with a BridgeError (UserRejected, WrongChain…). */
  connect(id: string): Promise<void>
  /** Disconnects. Never rejects. */
  disconnect(): Promise<void>
  /** Connected, but on another network, so writes refuse with WrongChain. Ethereum only; unset elsewhere. */
  wrongChain?: boolean
  /** Asks the wallet to move to the deployment's network. Rejects with a BridgeError (UserRejected, WrongChain). Ethereum only. */
  switchChain?: () => Promise<void>
}
