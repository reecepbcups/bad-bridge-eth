import { toBridgeError, type BridgeError, type ContractInfo, type EthReader, type HubReader } from '../chain/types'
import { isLive, type Deployment } from '../config/deployments'

// The facts behind About's "Why you can trust it", read live per deployment instead of promised in copy.
// They come from public RPCs, so they catch config and ops mistakes (an escrow deployed with an admin, a router
// that turned into a proxy). They are not a trust anchor: a lying endpoint could hide an admin.

/** Who could change the contracts a kid depends on. For each: undefined means it couldn't be read. */
export interface TrustFacts {
  /** The escrow's code id and admin. null when there's no escrow yet. */
  escrow: ContractInfo | null | undefined
  /** Raw internal admin: null means emergency unlock has been permanently renounced. */
  emergencyAdmin: string | null | undefined
  /** The cw721's code id and admin. The escrow holds kids in it, so its admin matters too. */
  collection: ContractInfo | undefined
  /**
   * Whether Eureka's router is an upgradeable (EIP-1967) proxy. Replacing its client entry does not update
   * BadBridge's immutable client. null when there's no bridge yet.
   */
  routerUpgradeable: boolean | null | undefined
}

async function attempt<T>(p: Promise<T>, failures: BridgeError[]): Promise<T | undefined> {
  try {
    return await p
  } catch (e) {
    failures.push(toBridgeError(e))
    return undefined
  }
}

/** Reads every fact at once. A failed read leaves that fact undefined and comes back in `error`. */
export async function loadTrustFacts(
  deployment: Deployment,
  hub: HubReader,
  eth: EthReader,
): Promise<{ value: TrustFacts; error: BridgeError | null }> {
  const failures: BridgeError[] = []
  const escrow = deployment.hub.escrow
  const [escrowInfo, collection, implementation, emergencyAdmin] = await Promise.all([
    escrow ? attempt(hub.contractInfo(escrow), failures) : Promise.resolve(null),
    attempt(hub.contractInfo(deployment.hub.cw721), failures),
    isLive(deployment) ? attempt(eth.proxyImplementation(deployment.eth.router), failures) : Promise.resolve(null),
    escrow ? attempt(hub.escrowAdmin(), failures) : Promise.resolve(null),
  ])
  const routerUpgradeable = isLive(deployment) ? (implementation === undefined ? undefined : implementation !== null) : null
  return { value: { escrow: escrowInfo, collection, routerUpgradeable, emergencyAdmin }, error: failures[0] ?? null }
}
