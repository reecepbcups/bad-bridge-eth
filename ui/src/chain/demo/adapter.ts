import { bytesToHex, keccak256, toHex } from 'viem'
import type { Deployment } from '../../config/deployments'
import { decodeBech32 } from '../bech32'
import { typicalClaimGas } from '../eth/gas'
import {
  BridgeError,
  stageReporter,
  toBridgeError,
  type EthAddress,
  type EthReader,
  type ContractInfo,
  type EthWriter,
  type HubAddress,
  type HubReader,
  type HubWriter,
  type WalletOption,
  type WalletState,
} from '../types'
import type { ProveKidWriter } from '../prove'
import type { DemoChain, DemoSim, DemoWallet } from './sim'

// Wraps the synchronous sim in the async adapter interfaces, with its latency, signing delays and failures.

const HUB_OPTIONS: WalletOption[] = [
  { id: 'keplr', name: 'Keplr', installed: true },
  { id: 'leap', name: 'Leap', installed: true },
  { id: 'walletconnect', name: 'WalletConnect', installed: true },
  { id: 'cosmostation', name: 'Cosmostation', installed: false },
]

const ETH_OPTIONS: WalletOption[] = [
  { id: 'injected', name: 'MetaMask', installed: true },
  { id: 'coinbaseWallet', name: 'Coinbase Wallet', installed: true },
  { id: 'walletConnect', name: 'WalletConnect', installed: true },
]

/**
 * Trust facts the demo shows on About: an escrow with no admin, a collection with one (the real Bad Kids cw721's
 * admin), and an upgradeable Eureka router, so both the ✓ and the caveat copy get exercised.
 */
const DEMO_COLLECTION_ADMIN = 'cosmos1s8qx0zvz8yd6e4x0mqmqf7fr9vvfn6226hkvrq'
const DEMO_ROUTER_IMPLEMENTATION: EthAddress = '0x17fa3A98D0239a399927C7c3CCdE142e08Deb7B5'
/** router.getCounterparty()'s clientId on mainnet, 2026-09-27. */
const DEMO_HUB_CLIENT_ID = '08-wasm-1369'
/** 2 gwei. */
const DEMO_GAS_PRICE = 2_000_000_000n

const hash = (label: string) => keccak256(toHex(label))

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/** Runs `fn` after the demo's read latency, turning anything thrown into a rejected BridgeError. */
async function later<T>(ms: number, fn: () => T): Promise<T> {
  await delay(ms)
  try {
    return fn()
  } catch (e) {
    throw toBridgeError(e)
  }
}

export function createDemoReaders(sim: DemoSim, deployment: Deployment): { hub: HubReader; eth: EthReader } {
  const read = <T>(fn: () => T) =>
    later(sim.timeline.latencyMs, () => {
      sim.assertOnline()
      return fn()
    })
  const escrow = deployment.hub.escrow

  const requireEscrow = (): void => {
    if (!escrow) throw new BridgeError('NotLive', `${deployment.collectionName} has no escrow on the Hub yet`)
  }

  const hub: HubReader = {
    ownedKids: (owner) => read(() => sim.ownedKids(owner)),
    record: (id) =>
      read(() => {
        requireEscrow()
        return sim.record(id)
      }),
    allRecords: () =>
      read(() => {
        requireEscrow()
        return sim.allRecords()
      }),
    sendInfo: (id) =>
      read(() => {
        requireEscrow()
        return sim.sendInfo(id)
      }),
    sendsBy: (sender) =>
      read(() => {
        requireEscrow()
        return sim.sendsBy(sender)
      }),
    latestBlock: () => read(() => sim.latestBlock()),
    block: (height) => read(() => sim.block(height)),
    escrowCw721: () =>
      read(() => {
        requireEscrow()
        return deployment.hub.cw721
      }),
    escrowAdmin: () => read(() => { requireEscrow(); return null }),
    contractInfo: (address) =>
      read((): ContractInfo => {
        if (address === deployment.hub.cw721) return { codeId: 434, admin: DEMO_COLLECTION_ADMIN }
        if (address === escrow) return { codeId: 750, admin: null }
        throw new BridgeError('Unknown', `demo: no contract ${address}`)
      }),
  }

  const requireBridge = (): void => {
    if (!deployment.eth.bridge) throw new BridgeError('NotLive', 'no bridge in this deployment')
  }

  const eth: EthReader = {
    clientSafety: () => read(() => { requireBridge(); return { frozen: sim.client().frozen, expired: false, retired: false } }),
    client: () =>
      read(() => {
        requireBridge()
        return sim.client()
      }),
    kidStatus: (ids) =>
      read(() => {
        requireBridge()
        return sim.kidStatus(ids)
      }),
    isContract: (address) => read(() => sim.isContract(address)),
    bridgeEscrow: () =>
      read(() => {
        if (!escrow) throw new BridgeError('NotLive', 'no escrow in this deployment')
        return bytesToHex(decodeBech32(escrow).data)
      }),
    bridgeWiring: () =>
      read(() => {
        if (!deployment.eth.bridge) throw new BridgeError('NotLive', 'no bridge in this deployment')
        const { router, clientId, lightClient } = deployment.eth
        return { router, clientId, lightClient, chainId: deployment.hub.chainId }
      }),
    proxyImplementation: (address) =>
      read(() => (address.toLowerCase() === deployment.eth.router.toLowerCase() ? DEMO_ROUTER_IMPLEMENTATION : null)),
    estimateClaim: (ids) =>
      read(() => {
        if (!deployment.eth.bridge) throw new BridgeError('NotLive', 'no bridge in this deployment')
        const gas = typicalClaimGas(Math.max(1, new Set(ids).size))
        return { gas: Number(gas), gasPrice: DEMO_GAS_PRICE.toString(), fee: (gas * DEMO_GAS_PRICE).toString(), simulated: false }
      }),
    hubClientId: () =>
      read(() => {
        requireBridge()
        return DEMO_HUB_CLIENT_ID
      }),
  }

  return { hub, eth }
}

export function createDemoHubWriter(sim: DemoSim, address: HubAddress): HubWriter {
  return {
    address,
    simulateSend: (ids, recipient) => later(sim.timeline.latencyMs, () => sim.simulateSend(address, ids, recipient)),
    send: async (ids, recipient, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        stage.report('simulating')
        await later(sim.timeline.latencyMs, () => sim.simulateSend(address, ids, recipient))
        // the "wallet prompt": a declined signature fails here, before anything is broadcast
        stage.report('signing')
        await later(sim.timeline.signMs, () => sim.signSend())
        stage.report('broadcasting')
        return await later(sim.timeline.latencyMs, () => sim.commitSend(address, ids, recipient))
      } finally {
        stage.done()
      }
    },
    nudge: async (_sourceClientId, recipient, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        stage.report('simulating')
        await later(sim.timeline.latencyMs, () => sim.simulateNudge(recipient))
        stage.report('signing')
        await later(sim.timeline.signMs, () => sim.signSend())
        stage.report('broadcasting')
        return await later(sim.timeline.latencyMs, () => sim.nudge(recipient))
      } finally {
        stage.done()
      }
    },
  }
}

export function createDemoEthWriter(sim: DemoSim, address: EthAddress): EthWriter {
  return {
    address,
    claim: async (ids, options) => {
      const stage = stageReporter(options?.onStage)
      try {
        stage.report('signing')
        const result = await later(sim.timeline.signMs, () => sim.claim(ids))
        // mined as soon as it's signed in the sim; the pause is the block
        stage.report('confirming')
        await delay(sim.timeline.latencyMs)
        return result
      } finally {
        stage.done()
      }
    },
  }
}

/** Fakes a proof: a pause, the wallet prompt, then the kids are proven. No Succinct, no PROVE. */
export function createDemoProveKidWriter(sim: DemoSim): ProveKidWriter {
  const notInDemo = () => Promise.reject(new BridgeError('Unknown', 'demo: not supported'))
  const proveKids: ProveKidWriter['proveKids'] = async (ids, options) => {
    options?.onStage?.('proving')
    await delay(sim.timeline.proveMs)
    options?.onStage?.('signing')
    const proved = await later(sim.timeline.signMs, () => sim.prove(ids))
    options?.onStage?.('confirming')
    await delay(sim.timeline.latencyMs)
    return { txHash: hash(`demo:prove:${proved.join(',')}`), proved }
  }
  return {
    proveKids,
    proveKid: async (id, options) => ({ txHash: (await proveKids([id], options)).txHash }),
    submitRequest: notInDemo,
    proveBalance: () => Promise.resolve(0n),
    registerProgram: () => Promise.resolve(),
    gasPrice: () => Promise.resolve(DEMO_GAS_PRICE),
    quoteProve: () => Promise.resolve(0n),
    ethUsdPrice: () => Promise.resolve(0),
    walletProveBalance: () => Promise.resolve(0n),
    buyProve: notInDemo,
    depositProve: notInDemo,
  }
}

/** WalletState over one of the sim's wallets. `wallet` is the snapshot's (immutable) view of it. */
export function createDemoWallet<A extends string>(
  sim: DemoSim,
  chain: DemoChain,
  wallet: DemoWallet,
  wrongChain = false,
): WalletState<A> {
  const options = chain === 'hub' ? HUB_OPTIONS : ETH_OPTIONS
  const ethOnly: Pick<WalletState<A>, 'wrongChain' | 'switchChain'> =
    chain === 'eth'
      ? {
          wrongChain: wallet.status === 'connected' && wrongChain,
          switchChain: async () => {
            await delay(sim.timeline.walletMs)
            try {
              sim.switchChain()
            } catch (e) {
              throw toBridgeError(e)
            }
          },
        }
      : {}
  return {
    ...ethOnly,
    status: wallet.status,
    address: wallet.address as A | undefined,
    walletName: wallet.walletName,
    options,
    connect: async (id) => {
      const option = options.find((o) => o.id === id)
      if (!option) throw new BridgeError('Unknown', `demo: no wallet "${id}"`)
      if (!option.installed) throw new BridgeError('Unknown', `demo: ${option.name} isn't installed`)
      try {
        sim.beginConnect(chain)
      } catch (e) {
        throw toBridgeError(e)
      }
      await delay(sim.timeline.walletMs)
      sim.finishConnect(chain, option.name)
    },
    disconnect: () => {
      sim.disconnect(chain)
      return Promise.resolve()
    },
  }
}
