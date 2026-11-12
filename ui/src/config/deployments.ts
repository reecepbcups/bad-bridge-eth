import type { Address } from 'viem'

export type DeploymentId = 'reece-test' | 'badkids-test' | 'badkids' | 'demo'

/** Cosmos Hub side of a deployment. */
export interface HubConfig {
  /** Chain id, e.g. cosmoshub-4. */
  chainId: string
  /** Human name for wallet prompts. */
  chainName: string
  /** Account address prefix. */
  bech32Prefix: string
  /** REST (LCD) endpoints, tried in order. */
  rest: readonly string[]
  /** CometBFT RPC endpoints, tried in order. Also the tx_search fallback. */
  rpc: readonly string[]
  /** The cw721 the escrow accepts. */
  cw721: string
  /** Escrow contract. null means not deployed yet. */
  escrow: string | null
  /** Fee denom. */
  gasDenom: string
  /** Average block time, for "Ethereum is N min behind". */
  blockSeconds: number
}

/** Ethereum side of a deployment. */
export interface EthConfig {
  /** 1 for mainnet. */
  chainId: number
  /** JSON-RPC endpoints, tried in order. */
  rpc: readonly string[]
  /** BadBridge ERC721. null means not deployed yet. */
  bridge: Address | null
  /** Multicall3, for batched reads and claim-many. */
  multicall3: Address
  /** Eureka's cosmoshub-0 light client today. The bridge resolves it through the router live; the startup check compares. */
  lightClient: Address
  /** The IBC Eureka router BadBridge asks for its client (bridge.ROUTER()). Pinned; the startup check compares. */
  router: Address
  /** The Eureka client id BadBridge asks the router for (bridge.clientId()). */
  clientId: string
}

/** Link builders. Every link the app shows goes through one of these. */
export interface Explorers {
  hubTx(hash: string): string
  hubAccount(address: string): string
  hubContract(address: string): string
  ethTx(hash: string): string
  ethAddress(address: string): string
  /** Blockscout page for one bridged kid. null until the bridge exists. */
  ethToken(tokenId: number): string | null
  /** OpenSea page for one bridged kid. null until the bridge exists. */
  opensea(tokenId: number): string | null
  /** OpenSea collection page for the bridged contract. null until the bridge exists. */
  openseaCollection(): string | null
}

export interface Deployment {
  id: DeploymentId
  /** Shown in copy, e.g. "Bad Kids". */
  collectionName: string
  /** Token ids run from 1 to collectionSize. */
  collectionSize: number
  /** True for the in-memory demo adapter (no network at all). */
  demo: boolean
  hub: HubConfig
  eth: EthConfig
  explorer: Explorers
  /** The bridge's source code, linked from About and the error page. */
  sourceUrl: string
  /** Blockscout page for the verified bridge. null when not verified. */
  verifiedUrl: string | null
}

const HUB_REST = ['https://cosmos-rest.publicnode.com'] as const
const HUB_RPC = [
  'https://cosmos-rpc.polkachu.com',
  'https://cosmos-rpc.publicnode.com',
  'https://cosmoshub.rpc.kjnodes.com',
] as const
const ETH_RPC = ['https://ethereum-rpc.publicnode.com'] as const
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'
const EUREKA_CLIENT: Address = '0x4bB8A05D5b40dF7a3B97770E1943461B681B62E9'
/** IBC Eureka's ICS26 router on mainnet, read from the reece-test bridge's ROUTER() on 2026-09-27. */
const EUREKA_ROUTER: Address = '0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7'
const EUREKA_CLIENT_ID = 'cosmoshub-0'

function explorers(bridge: Address | null): Explorers {
  return {
    hubTx: (hash) => `https://www.mintscan.io/cosmos/tx/${hash}`,
    hubAccount: (address) => `https://www.mintscan.io/cosmos/address/${address}`,
    hubContract: (address) => `https://www.mintscan.io/cosmos/wasm/contract/${address}`,
    ethTx: (hash) => `https://eth.blockscout.com/tx/${hash}`,
    ethAddress: (address) => `https://eth.blockscout.com/address/${address}`,
    ethToken: (tokenId) => (bridge ? `https://eth.blockscout.com/token/${bridge}/instance/${tokenId}` : null),
    opensea: (tokenId) => (bridge ? `https://opensea.io/assets/ethereum/${bridge}/${tokenId}` : null),
    openseaCollection: () => (bridge ? `https://opensea.io/assets/ethereum/${bridge}` : null),
  }
}

function hub(cw721: string, escrow: string | null): HubConfig {
  return {
    chainId: 'cosmoshub-4',
    chainName: 'Cosmos Hub',
    bech32Prefix: 'cosmos',
    rest: HUB_REST,
    rpc: HUB_RPC,
    cw721,
    escrow,
    gasDenom: 'uatom',
    blockSeconds: 6,
  }
}

function eth(bridge: Address | null): EthConfig {
  return {
    chainId: 1,
    rpc: ETH_RPC,
    bridge,
    multicall3: MULTICALL3,
    lightClient: EUREKA_CLIENT,
    router: EUREKA_ROUTER,
    clientId: EUREKA_CLIENT_ID,
  }
}

const SOURCE = 'https://github.com/reecepbcups/bad-bridge'

const REECE_TEST_BRIDGE: Address = '0xdDef181a0b9F5A090830F9ccBE5Ffb0D2BA07A7e'

/** Mainnet test collection. Minted up to #18 as of 2026-09-28 (cw721 num_tokens/all_tokens, verified live); grows as more get minted for testing. */
const reeceTest: Deployment = {
  id: 'reece-test',
  collectionName: 'ReeceBadTestTwo',
  collectionSize: 18,
  demo: false,
  hub: hub(
    'cosmos158d2rz0aw8cxx86j0tl8gfwleqyqefr9xdgth2jdfse2d9uumltsu83rfr',
    'cosmos1rce3kmvc2v955f64gp8cjtwqzma3qg8t4puk7swmqd56j25gfqgq3s8037',
  ),
  eth: eth(REECE_TEST_BRIDGE),
  explorer: explorers(REECE_TEST_BRIDGE),
  sourceUrl: SOURCE,
  verifiedUrl: null,
}

const BADKIDS_TEST_BRIDGE: Address = '0x55AeBB496F306B650048151Fe9019D81819C6F47'

/** Test cw721 named Bad Kids, deployed 2026-11-05 to smoke test the escrow with a temporary admin. Kids #1 to #5 minted. */
const badkidsTest: Deployment = {
  id: 'badkids-test',
  collectionName: 'Bad Kids Test',
  collectionSize: 5,
  demo: false,
  hub: hub(
    'cosmos1s8vzghad3dz6rjvhxg06vme8u5g3txxdsjavm56xkpr93qguvccsfa2qfp',
    'cosmos1g73tt6vae4x5x5yk7uwlwfckzqml7a6kj0pkp7hns5c743z8weusrjf4s0',
  ),
  eth: eth(BADKIDS_TEST_BRIDGE),
  explorer: explorers(BADKIDS_TEST_BRIDGE),
  sourceUrl: SOURCE,
  verifiedUrl: null,
}

const BADKIDS_BRIDGE: Address = '0x496f8D31eF5576A3f7057572829a74a90cF39E9a'

/** The real collection. Escrow (code 822) and bridge deployed 2026-11-05. */
const badkids: Deployment = {
  id: 'badkids',
  collectionName: 'Bad Kids',
  collectionSize: 9999,
  demo: false,
  hub: hub(
    'cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz',
    'cosmos1x5t4r4ga8a6f6lr4zsgt5l6jw5mmq7nud3tg9hryvp532rdnn55qcer7zh',
  ),
  eth: eth(BADKIDS_BRIDGE),
  explorer: explorers(BADKIDS_BRIDGE),
  sourceUrl: SOURCE,
  verifiedUrl: 'https://eth.blockscout.com/address/0x496f8D31eF5576A3f7057572829a74a90cF39E9a?tab=contract',
}

/** In-memory adapter replaying the mockup's example wallet. Shows the test contracts on About, like the mockup. */
const demo: Deployment = {
  ...reeceTest,
  id: 'demo',
  collectionName: 'Bad Kids',
  collectionSize: 9999,
  demo: true,
}

export const DEPLOYMENTS: Readonly<Record<DeploymentId, Deployment>> = {
  'reece-test': reeceTest,
  'badkids-test': badkidsTest,
  badkids,
  demo,
}

/** Both contracts exist, so sends and claims make sense. */
export function isLive(d: Deployment): boolean {
  return d.hub.escrow !== null && d.eth.bridge !== null
}

/**
 * `?demo` switches to the demo when `allowDemo` is on: always in dev, and in production builds only with
 * VITE_ALLOW_DEMO=1 (the e2e build). Elsewhere it's ignored, so nobody can pass a link that shows fake chain data.
 */
export function selectDeployment(envId: string | undefined, search: string, allowDemo = true): Deployment {
  if (allowDemo && new URLSearchParams(search).has('demo')) return demo
  const id = envId?.trim() || 'reece-test'
  if (!(id in DEPLOYMENTS)) {
    throw new Error(`VITE_DEPLOYMENT="${id}" is not one of ${Object.keys(DEPLOYMENTS).join(', ')}`)
  }
  return DEPLOYMENTS[id as DeploymentId]
}

/** Whether `?demo` is honoured by this build. */
export const demoAllowed: boolean = import.meta.env.DEV || import.meta.env.VITE_ALLOW_DEMO === '1'

/** The deployment this page runs, fixed at load. */
export const deployment: Deployment = selectDeployment(
  import.meta.env.VITE_DEPLOYMENT,
  typeof location === 'undefined' ? '' : location.search,
  demoAllowed,
)

/** The page runs the in-memory demo, not real chain data. Drives the full-width "DEMO" banner. */
export const isDemo: boolean = deployment.demo

/** Reown (WalletConnect) project id. Without it, only injected wallets are offered. */
export const wcProjectId: string | undefined = import.meta.env.VITE_WC_PROJECT_ID?.trim() || undefined
