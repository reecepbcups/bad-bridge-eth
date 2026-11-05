import { encodeFunctionData, parseAbi, parseSignature, type Address, type Hex } from 'viem'
import { getChainId, readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from 'viem/actions'
import type { ActivityEntry } from '../../activity/storage'
import { BridgeError, type BatchStage } from '../types'
import type { ReadClient, SignerClient } from './writer'

// Getting PROVE into a Succinct network account: buy it on Uniswap v3 (ETH -> PROVE), then permitAndDeposit it
// into SuccinctVApp, which credits the depositor's own address. All addresses read off mainnet 2026-09-28.

export const PROVE_TOKEN: Address = '0x6bef15d938d4e72056ac92ea4bdd0d76b1c4ad29'
const VAPP: Address = '0x5ad5bc4b18f7c173dce17a57682cb0dc8788951f'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
/** Chainlink ETH/USD, 8 decimals. Checked on mainnet 2026-09-28. */
const ETH_USD_FEED: Address = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
const SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
/** The only WETH/PROVE pool with liquidity (1%). Thin, so big buys move the price a lot. */
const POOL_FEE = 10_000
/** SuccinctVApp rejects deposits below this (minDepositAmount). */
export const MIN_DEPOSIT = 10n ** 16n
/** Extra ETH allowed over the quote; whatever isn't used is refunded by the router. */
const SLIPPAGE_PERCENT = 5n
const PERMIT_VALID_SECS = 30 * 60
const RECEIPT_TIMEOUT_MS = 10 * 60_000

const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function nonces(address) view returns (uint256)'])
const chainlinkAbi = parseAbi(['function latestRoundData() view returns (uint80, int256 answer, uint256, uint256, uint80)'])
const quoterAbi = parseAbi([
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])
const routerAbi = parseAbi([
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
  'function refundETH() payable',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
])
const vappAbi = parseAbi(['function permitAndDeposit(address from, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint64)'])

type Report = (stage: BatchStage) => void
/** Hears each hash or signature the wallet hands back, for the activity log. */
type Log = (entry: ActivityEntry) => void

/** How much ETH buying `prove` PROVE costs right now. Nothing is sent. */
export async function quoteProve(client: ReadClient, prove: bigint): Promise<bigint> {
  const { result } = await simulateContract(client, {
    address: QUOTER_V2,
    abi: quoterAbi,
    functionName: 'quoteExactOutputSingle',
    args: [{ tokenIn: WETH, tokenOut: PROVE_TOKEN, amount: prove, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
  })
  return result[0]
}

/** USD per ETH from Chainlink, for showing a dollar figure only, never for math that moves funds. */
export async function ethUsdPrice(client: ReadClient): Promise<number> {
  const [, answer] = await readContract(client, { address: ETH_USD_FEED, abi: chainlinkAbi, functionName: 'latestRoundData' })
  return Number(answer) / 1e8
}

/** PROVE held by `owner` in their wallet (not the Succinct network balance). */
export function walletProveBalance(client: ReadClient, owner: Address): Promise<bigint> {
  return readContract(client, { address: PROVE_TOKEN, abi: tokenAbi, functionName: 'balanceOf', args: [owner] })
}

async function assertMainnet(wallet: SignerClient, chainId: number): Promise<void> {
  const walletChain = await getChainId(wallet)
  if (walletChain !== chainId) throw new BridgeError('WrongChain', `wallet is on chain ${walletChain}, PROVE is on ${chainId}`)
}

async function confirm(client: ReadClient, hash: Hex, what: string, report: Report): Promise<Hex> {
  report('confirming')
  const receipt = await waitForTransactionReceipt(client, { hash, timeout: RECEIPT_TIMEOUT_MS })
  if (receipt.status !== 'success') throw new BridgeError('Unknown', `${what} transaction ${receipt.transactionHash} reverted`)
  return receipt.transactionHash
}

/** Buys exactly `prove` PROVE with ETH into the wallet. Sends the quote plus slippage; the router refunds the rest. */
export async function swapEthForProve(client: ReadClient, wallet: SignerClient, chainId: number, prove: bigint, report: Report, log: Log = () => {}): Promise<Hex> {
  await assertMainnet(wallet, chainId)
  const quote = await quoteProve(client, prove)
  const maxIn = quote + (quote * SLIPPAGE_PERCENT) / 100n
  const swap = encodeFunctionData({
    abi: routerAbi,
    functionName: 'exactOutputSingle',
    args: [{ tokenIn: WETH, tokenOut: PROVE_TOKEN, fee: POOL_FEE, recipient: wallet.account.address, amountOut: prove, amountInMaximum: maxIn, sqrtPriceLimitX96: 0n }],
  })
  const refund = encodeFunctionData({ abi: routerAbi, functionName: 'refundETH' })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_VALID_SECS)
  const { request } = await simulateContract(client, {
    account: wallet.account,
    address: SWAP_ROUTER_02,
    abi: routerAbi,
    functionName: 'multicall',
    args: [deadline, [swap, refund]],
    value: maxIn,
  })
  report('signing')
  const hash = await writeContract(wallet, { ...request, account: wallet.account, chain: wallet.chain })
  log({ action: 'buy-prove', hash })
  return confirm(client, hash, 'swap', report)
}

/** Deposits `amount` PROVE into the wallet's own Succinct network account: one permit signature, one tx. */
export async function depositProve(client: ReadClient, wallet: SignerClient, chainId: number, amount: bigint, report: Report, log: Log = () => {}): Promise<Hex> {
  if (amount < MIN_DEPOSIT) throw new BridgeError('Unknown', 'Succinct takes deposits of 0.01 PROVE or more')
  await assertMainnet(wallet, chainId)
  const owner = wallet.account.address
  const nonce = await readContract(client, { address: PROVE_TOKEN, abi: tokenAbi, functionName: 'nonces', args: [owner] })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_VALID_SECS)
  report('signing')
  const signature = await signTypedData(wallet, {
    account: wallet.account,
    domain: { name: 'Succinct', version: '1', chainId, verifyingContract: PROVE_TOKEN },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner, spender: VAPP, value: amount, nonce, deadline },
  })
  log({ action: 'sign-prove-permit' })
  const { r, s, yParity, v } = parseSignature(signature)
  const { request } = await simulateContract(client, {
    account: wallet.account,
    address: VAPP,
    abi: vappAbi,
    functionName: 'permitAndDeposit',
    args: [owner, amount, deadline, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s],
  })
  const hash = await writeContract(wallet, { ...request, account: wallet.account, chain: wallet.chain })
  log({ action: 'deposit-prove', hash })
  return confirm(client, hash, 'deposit', report)
}
