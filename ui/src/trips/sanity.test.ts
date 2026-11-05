import { fromBech32 } from '@cosmjs/encoding'
import { bytesToHex, type Hex } from 'viem'
import type { BridgeWiring } from '../chain/types'
import { describe, expect, it } from 'vitest'
import { DEPLOYMENTS } from '../config/deployments'
import { NOT_LIVE } from './fakes'
import { checkConfig, describeConfigProblem, escrowBytes32 } from './sanity'

const live = DEPLOYMENTS['reece-test']
const escrow = live.hub.escrow ?? ''
const good = bytesToHex(fromBech32(escrow).data)
const wired: BridgeWiring = { router: live.eth.router, clientId: 'cosmoshub-0', lightClient: live.eth.lightClient, chainId: 'cosmoshub-4' }

describe('checkConfig', () => {
  it('passes when both contracts agree with the deployment', () => {
    expect(checkConfig(live, live.hub.cw721, good, wired)).toEqual({ ok: true, status: 'ok', problems: [] })
  })

  it('ignores hex case', () => {
    expect(checkConfig(live, live.hub.cw721, good.toUpperCase().replace('0X', '0x') as Hex, wired).ok).toBe(true)
  })

  it('flags an escrow that accepts another collection', () => {
    const other = DEPLOYMENTS.badkids.hub.cw721
    const result = checkConfig(live, other, good, wired)
    expect(result).toMatchObject({ ok: false, status: 'mismatch' })
    expect(result.problems).toEqual([
      { code: 'EscrowCollection', expected: live.hub.cw721, actual: other, message: expect.stringContaining(other) as string },
    ])
  })

  it('flags a bridge that trusts another escrow', () => {
    const other: Hex = `0x${'11'.repeat(32)}`
    const result = checkConfig(live, live.hub.cw721, other, wired)
    expect(result).toMatchObject({ ok: false, status: 'mismatch', problems: [{ code: 'BridgeEscrow', expected: good, actual: other }] })
  })

  it.each([
    ['20 bytes', `0x${good.slice(2, 42)}`],
    ['33 bytes with our escrow as a prefix', `${good}00`],
    ['not hex', `0x${'zz'.repeat(32)}`],
    ['empty', '0x'],
  ])('flags a bridge escrow that is %s', (_name, actual) => {
    const result = checkConfig(live, live.hub.cw721, actual as Hex, wired)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatchObject({ code: 'BridgeEscrow', actual })
  })

  it('reports both problems at once', () => {
    const result = checkConfig(live, 'cosmos1other', `0x${'11'.repeat(32)}`, wired)
    expect(result.problems.map((p) => p.code)).toEqual(['EscrowCollection', 'BridgeEscrow'])
    expect(result.problems.every((p) => p.message)).toBe(true)
  })

  it('treats a missing escrow or bridge as not live', () => {
    expect(checkConfig(NOT_LIVE, NOT_LIVE.hub.cw721, good, wired)).toMatchObject({
      ok: false,
      status: 'not-live',
      problems: [{ code: 'NotLive' }],
    })
    const noBridge = { ...live, eth: { ...live.eth, bridge: null } }
    expect(checkConfig(noBridge, live.hub.cw721, good, wired).status).toBe('not-live')
  })

  it('refuses a configured escrow that is not a 32-byte address', () => {
    const wallet = { ...live, hub: { ...live.hub, escrow: 'cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl' } }
    const result = checkConfig(wallet, live.hub.cw721, good, wired)
    expect(result).toMatchObject({ ok: false, problems: [{ code: 'BridgeEscrow', expected: '0x' }] })
    expect(describeConfigProblem(result.problems[0]!)).toMatch(/isn't a valid 32-byte/)
  })
})

describe('checkConfig: the bridge\'s light client', () => {
  it('pins the Eureka router and the client id', () => {
    expect(live.eth.router).toBe('0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7')
    expect(live.eth.clientId).toBe('cosmoshub-0')
  })

  it('ignores address case', () => {
    const lower = { ...wired, router: wired.router.toLowerCase(), lightClient: wired.lightClient.toLowerCase() } as BridgeWiring
    expect(checkConfig(live, live.hub.cw721, good, lower).ok).toBe(true)
  })

  it.each([
    ['a router that is not the pinned one', { router: '0x0000000000000000000000000000000000000B0B' }, 'router', /asks router 0x0000000000000000000000000000000000000B0B/],
    ['another Eureka client id', { clientId: 'cosmoshub-1' }, 'clientId', /follows Eureka client "cosmoshub-1"/],
    ['a swapped light client', { lightClient: '0x0000000000000000000000000000000000000B0B' }, 'lightClient', /light client is 0x0000000000000000000000000000000000000B0B/],
    ['a client that follows another chain', { chainId: 'theta-testnet-001' }, 'chainId', /follows theta-testnet-001, not the Cosmos Hub/],
  ] as const)('flags %s', (_name, patch, field, message) => {
    const result = checkConfig(live, live.hub.cw721, good, { ...wired, ...patch })
    expect(result).toMatchObject({ ok: false, status: 'mismatch' })
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({ code: 'BridgeClient', mismatches: [{ field }] })
    expect(result.problems[0]?.message).toMatch(message)
  })

  it('lists every mismatch in one problem, after the escrow checks', () => {
    const result = checkConfig(live, 'cosmos1other', good, { router: wired.lightClient, clientId: 'x', lightClient: wired.router, chainId: 'y' })
    expect(result.problems.map((p) => p.code)).toEqual(['EscrowCollection', 'BridgeClient'])
    const client = result.problems[1]
    expect(client?.code === 'BridgeClient' && client.mismatches.map((m) => m.field)).toEqual(['router', 'clientId', 'lightClient', 'chainId'])
  })
})

describe('escrowBytes32', () => {
  it('decodes a contract address and rejects anything else', () => {
    expect(escrowBytes32(escrow)).toBe(good)
    expect(escrowBytes32('cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl')).toBeNull()
    expect(escrowBytes32('not bech32')).toBeNull()
  })
})
