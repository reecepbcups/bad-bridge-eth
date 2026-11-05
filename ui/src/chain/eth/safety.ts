import { bytesToHex, encodeAbiParameters, keccak256, type Chain, type Client, type Transport } from 'viem'
import { getBlock, readContract } from 'viem/actions'
import type { Deployment } from '../../config/deployments'
import { proofHeader } from '../hub/prove'
import { createTransport } from '../hub/transport'
import { BridgeError, type ClientSafety } from '../types'
import { bridgeAbi, lightClientAbi, routerAbi } from './abi'

/** The bridge pins its client forever; a router recovery does not recover this bridge. */
export async function readClientSafety(deployment: Deployment, client: Client<Transport, Chain | undefined>): Promise<ClientSafety> {
  const address = deployment.eth.bridge
  if (!address) throw new BridgeError('NotLive', 'The Ethereum bridge is not deployed')
  const [pinned, router, id, block] = await Promise.all([
    readContract(client, { address, abi: bridgeAbi, functionName: 'lightClient' }),
    readContract(client, { address, abi: bridgeAbi, functionName: 'ROUTER' }),
    readContract(client, { address, abi: bridgeAbi, functionName: 'clientId' }),
    getBlock(client),
  ])
  const [current, state] = await Promise.all([
    readContract(client, { address: router, abi: routerAbi, functionName: 'getClient', args: [id] }),
    readContract(client, { address: pinned, abi: lightClientAbi, functionName: 'clientState' }),
  ])
  const retired = current.toLowerCase() !== pinned.toLowerCase()
  const [, , height, trustingPeriod, , frozen] = state
  if (frozen || retired) return { frozen, retired, expired: false }
  const [header, expectedHash] = await Promise.all([
    proofHeader(createTransport(deployment.hub), Number(height.revisionHeight)),
    readContract(client, { address: pinned, abi: lightClientAbi, functionName: 'getConsensusStateHash', args: [height.revisionHeight] }),
  ])
  const hash = keccak256(encodeAbiParameters(
    [{ type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [header.timestampNs, bytesToHex(header.appHash), bytesToHex(header.nextValidatorsHash)],
  ))
  if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new BridgeError('Network', "The Hub header does not match Ethereum's trusted consensus state")
  }
  // Use both clocks conservatively: a stale Ethereum endpoint must not extend the trust period.
  const now = BigInt(Math.max(Math.floor(Date.now() / 1000), Number(block.timestamp))) * 1_000_000_000n
  return { frozen, retired, expired: header.timestampNs + BigInt(trustingPeriod) * 1_000_000_000n <= now }
}
