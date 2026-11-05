import type { EthAddress, HubAddress, KidId } from '../types'

// The mockup's example wallet, replayed. Times are fixed so screenshots and tests are repeatable.

/** Virtual "now" when the demo starts. */
export const EPOCH = Date.parse('2026-09-27T17:00:00Z')
/** Hub height at EPOCH. */
export const EPOCH_HEIGHT = 33_114_902
/** Hub height Ethereum's client has seen at EPOCH: a relay landed 10 minutes ago. */
export const EPOCH_CLIENT_HEIGHT = EPOCH_HEIGHT - 100

/** The connected Hub wallet (the mockup's "cosmos1q8m…3fxl" chip). */
export const DEMO_HUB: HubAddress = 'cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl'
/** The connected Ethereum wallet (the mockup's "0x8f3a…c21d" chip). */
export const DEMO_ETH: EthAddress = '0x8f3a41b7e2D09C6A5E1f7b3C2d9A0e4f6b8Cc21d'
/** Someone else's Hub wallet, which sent two kids to DEMO_ETH from another device. */
export const OTHER_HUB: HubAddress = 'cosmos1qa3t6xrnec5cfhe6jhcyhfsptjm3ymwg6vlqk8'
/** A stranger whose kids are also in the escrow, so lookups have something to filter out. */
export const STRANGER_ETH: EthAddress = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

/** Kids still on the Hub in DEMO_HUB (the pick screen). */
export const OWNED: readonly KidId[] = [9176, 6413, 4801, 663, 3838]

/** A kid already in the escrow when the demo starts. */
export interface SeedTrip {
  id: KidId
  sender: HubAddress
  recipient: EthAddress
  /** When the send landed. */
  sentAt: number
  /** Proof landed on Ethereum. */
  proven: boolean
  /** Minted on Ethereum (claimed). */
  minted: boolean
}

const MIN = 60_000

/** The tracker's example trips (one ready, one crossing, one home) plus a stranger's two. */
export const TRIPS: readonly SeedTrip[] = [
  { id: 9254, sender: OTHER_HUB, recipient: DEMO_ETH, sentAt: Date.parse('2026-09-27T04:12:00Z'), proven: true, minted: false },
  { id: 8783, sender: OTHER_HUB, recipient: DEMO_ETH, sentAt: EPOCH - 22 * MIN, proven: false, minted: false },
  { id: 8073, sender: DEMO_HUB, recipient: DEMO_ETH, sentAt: Date.parse('2026-09-23T18:30:00Z'), proven: true, minted: true },
  { id: 1234, sender: OTHER_HUB, recipient: STRANGER_ETH, sentAt: Date.parse('2026-09-25T10:00:00Z'), proven: true, minted: true },
  { id: 42, sender: OTHER_HUB, recipient: STRANGER_ETH, sentAt: Date.parse('2026-09-26T12:00:00Z'), proven: true, minted: false },
]

/** Addresses isContract() reports as contracts, to exercise the contract-recipient warning. */
export const CONTRACTS: readonly EthAddress[] = [
  '0xcA11bde05977b3631167028862bE2a173976CA11',
  '0xdDef181a0b9F5A090830F9ccBE5Ffb0D2BA07A7e',
]
