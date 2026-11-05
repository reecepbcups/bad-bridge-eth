import { decodeBech32 } from '../chain/bech32'
import { bytesToHex, type Hex } from 'viem'
import type { BridgeWiring, EthReader, HubAddress, HubReader } from '../chain/types'
import { isLive, type Deployment } from '../config/deployments'
import type { ConfigProblem, ConfigSanity, WiringMismatch } from './types'

// The startup check behind the Send button (PLAN.md "Send safety" step 1). Pure, so every branch is testable;
// useConfigSanity() does the reads and maps read failures to `unknown`. The reads come from public RPCs, so this
// catches config and ops mistakes (a wrong address, a swapped client). It is not a trust anchor.

/** A 32-byte value as 0x hex: what bridge.ESCROW() must return. */
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** The deployment's escrow as the raw 32 bytes bridge.ESCROW() should hold, or null if it isn't a 32-byte bech32 address. */
export function escrowBytes32(escrow: HubAddress): Hex | null {
  try {
    const { data } = decodeBech32(escrow)
    return data.length === 32 ? bytesToHex(data) : null
  } catch {
    return null
  }
}

/** The not-live result: the deployment has no escrow or bridge yet. */
export function notLive(): ConfigSanity {
  return { ok: false, status: 'not-live', problems: [withMessage({ code: 'NotLive' })] }
}

/** Fresh checks for every send, also used for the review screen's disabled state. */
export async function readSendSanity(deployment: Deployment, hub: HubReader, eth: EthReader): Promise<ConfigSanity> {
  if (!deployment.hub.escrow || !isLive(deployment)) return notLive()
  const [cw721, escrow, wiring, safety, info, admin] = await Promise.all([
    hub.escrowCw721(), eth.bridgeEscrow(), eth.bridgeWiring(), eth.clientSafety(),
    hub.contractInfo(deployment.hub.escrow), hub.escrowAdmin(),
  ])
  const problems = [...checkConfig(deployment, cw721, escrow, wiring).problems]
  for (const reason of ['frozen', 'expired', 'retired'] as const) {
    if (safety[reason]) problems.push(withMessage({ code: 'ClientUnavailable', reason }))
  }
  const warnings: ConfigProblem[] = []
  if (info.admin) warnings.push(withMessage({ code: 'EscrowAdmin', power: 'upgrade', admin: info.admin }))
  if (admin) warnings.push(withMessage({ code: 'EscrowAdmin', power: 'emergency unlock', admin }))
  return { ok: problems.length === 0, status: problems.length ? 'mismatch' : 'ok', problems, warnings }
}

/**
 * Compares what the chains say against the deployment.
 * - The escrow's `config {}` cw721 must equal the deployment's cw721 exactly.
 * - bridge.ESCROW() must be 32 bytes and equal the bech32-decoded escrow, ignoring hex case.
 * - bridge.ROUTER() must be the pinned Eureka router, bridge.clientId() the configured client id, the client the
 *   router hands back the configured light client, and that client must follow the deployment's Hub chain id.
 */
export function checkConfig(deployment: Deployment, escrowCw721: HubAddress, bridgeEscrow: Hex, wiring: BridgeWiring): ConfigSanity {
  const escrow = deployment.hub.escrow
  if (!escrow || !isLive(deployment)) return notLive()
  const problems: ConfigProblem[] = []
  if (escrowCw721 !== deployment.hub.cw721) {
    problems.push({ code: 'EscrowCollection', expected: deployment.hub.cw721, actual: escrowCw721 })
  }
  const expected = escrowBytes32(escrow)
  const actual = typeof bridgeEscrow === 'string' ? bridgeEscrow : ('0x' as Hex)
  if (!expected || !BYTES32.test(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
    problems.push({ code: 'BridgeEscrow', expected: expected ?? '0x', actual })
  }
  const mismatches = wiringMismatches(deployment, wiring)
  if (mismatches.length > 0) problems.push({ code: 'BridgeClient', mismatches })
  return { ok: problems.length === 0, status: problems.length ? 'mismatch' : 'ok', problems: problems.map(withMessage) }
}

function wiringMismatches(deployment: Deployment, wiring: BridgeWiring): WiringMismatch[] {
  const sameAddress = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
  const checks: [WiringMismatch['field'], string, boolean][] = [
    ['router', deployment.eth.router, sameAddress(wiring.router, deployment.eth.router)],
    ['clientId', deployment.eth.clientId, wiring.clientId === deployment.eth.clientId],
    ['lightClient', deployment.eth.lightClient, sameAddress(wiring.lightClient, deployment.eth.lightClient)],
    ['chainId', deployment.hub.chainId, wiring.chainId === deployment.hub.chainId],
  ]
  return checks.filter(([, , ok]) => !ok).map(([field, expected]) => ({ field, expected, actual: String(wiring[field]) }))
}

function describeMismatch(m: WiringMismatch): string {
  switch (m.field) {
    case 'router':
      return `The Ethereum bridge asks router ${m.actual} for its light client, not IBC Eureka's (${m.expected}).`
    case 'clientId':
      return `The Ethereum bridge follows Eureka client "${m.actual}", not "${m.expected}".`
    case 'lightClient':
      return `The Ethereum bridge's light client is ${m.actual}, not the one this site expects (${m.expected}).`
    case 'chainId':
      return `The Ethereum bridge's light client follows ${m.actual}, not the Cosmos Hub (${m.expected}).`
  }
}

/** Plain-English copy for one problem. The UI may reword it; this is the fallback and the log line. */
export function describeConfigProblem(problem: ConfigProblem): string {
  switch (problem.code) {
    case 'ClientUnavailable':
      return `The bridge's pinned light client is ${problem.reason}. Sending is disabled because new deposits could be stranded.`
    case 'EscrowAdmin':
      return `The escrow still has an ${problem.power} admin (${problem.admin}). It could move kids that are still in the escrow.`
    case 'NotLive':
      return "This collection's bridge isn't live yet: the Hub escrow or the Ethereum bridge hasn't been deployed."
    case 'EscrowCollection':
      return `The Hub escrow accepts ${problem.actual}, not this collection (${problem.expected}).`
    case 'BridgeEscrow':
      if (problem.expected === '0x') return "The configured Hub escrow isn't a valid 32-byte contract address."
      if (!BYTES32.test(problem.actual)) return `The Ethereum bridge's escrow (${problem.actual}) isn't 32 bytes.`
      return `The Ethereum bridge trusts escrow ${problem.actual}, not this collection's (${problem.expected}).`
    case 'BridgeClient':
      return problem.mismatches.map(describeMismatch).join(' ')
  }
}

function withMessage(problem: ConfigProblem): ConfigProblem {
  return { ...problem, message: describeConfigProblem(problem) }
}
