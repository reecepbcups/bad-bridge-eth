// Claims against a local Anvil fork of mainnet, through the real writer core (no wagmi).
// Seeds proofs on the configured RBT2 bridge, then calls claim and claimMany.
// Needs `anvil` on PATH and network for the fork's upstream RPC; skips without anvil.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bridgeAbi } from '../../src/chain/eth/abi'
import { createEthReader } from '../../src/chain/eth/reader'
import { createEthWriter } from '../../src/chain/eth/writer'
import { BridgeError, type EthReader, type KidEthStatus, type KidId } from '../../src/chain/types'
import { DEPLOYMENTS } from '../../src/config/deployments'

const FORK_URL = 'https://ethereum-rpc.publicnode.com'
const deployment = DEPLOYMENTS['reece-test']
const BRIDGE = deployment.eth.bridge!

// `forge inspect BadBridge storage-layout` (OZ c64a1edb): clientId 16, baseURI 17,
// _contractURI 18, proven 19. Use unused ids outside the live test collection to avoid existing mints.
const PROVEN_SLOT = 19n

// anvil's well-known dev accounts (mnemonic "test test … junk"). #0 claims, #1 is the proven recipient,
// so the test also shows claim() mints to the proven address whoever sends it.
const CLAIMER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RECIPIENT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const hasAnvil = spawnSync('anvil', ['--version']).status === 0

function provenSlot(id: KidId): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [id, PROVEN_SLOT]))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe.skipIf(!hasAnvil)('claim on an anvil mainnet fork', () => {
  let anvil: ChildProcess | undefined
  let url = ''
  let publicClient: PublicClient
  let reader: EthReader

  const account = privateKeyToAccount(CLAIMER_KEY)
  const writer = () =>
    createEthWriter({
      deployment,
      publicClient,
      walletClient: createWalletClient({ account, chain: mainnet, transport: http(url) }),
    })
  const ownerOf = (id: KidId) => publicClient.readContract({ address: BRIDGE, abi: bridgeAbi, functionName: 'ownerOf', args: [BigInt(id)] })

  beforeAll(async () => {
    const port = await freePort()
    url = `http://127.0.0.1:${port}`
    let log = ''
    const proc = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(port), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    anvil = proc
    proc.stdout.on('data', (d: Buffer) => (log += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (log += d.toString()))

    publicClient = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 0 }), pollingInterval: 100 })
    const deadline = Date.now() + 60_000
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`anvil exited (${proc.exitCode}):\n${log}`)
      try {
        await publicClient.getChainId()
        break
      } catch {
        if (Date.now() > deadline) throw new Error(`anvil didn't come up in 60s:\n${log}`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    const test = createTestClient({ mode: 'anvil', chain: mainnet, transport: http(url) })
    await test.setBalance({ address: account.address, value: parseEther('10') })
    for (const id of [10001, 10007, 10008, 10010, 10011, 10012]) {
      await test.setStorageAt({ address: BRIDGE, index: provenSlot(id), value: pad(RECIPIENT) })
    }
    reader = createEthReader(deployment, { client: publicClient })
  })

  afterAll(() => {
    anvil?.kill('SIGTERM')
  })

  it('reads the seeded proofs and mainnet state', async () => {
    const status = await reader.kidStatus([10001, 10007, 10008, 10009])
    expect([...status.keys()].sort((a, b) => a - b)).toEqual([10001, 10007, 10008, 10009])
    for (const id of [10001, 10007, 10008]) expect(status.get(id)).toEqual({ proven: RECIPIENT, owner: null })
    expect(status.get(10009)).toEqual({ proven: null, owner: null })

    const client = await reader.client()
    expect(client.latestHeight).toBeGreaterThan(33_092_463)
    expect(client.frozen).toBe(false)
    // anvil's dev accounts carry EIP-7702 delegations on mainnet: still EOAs
    expect(await reader.isContract(account.address)).toBe(false)
    expect(await reader.isContract(BRIDGE)).toBe(true)
  })

  it('estimateClaim simulates proven kids and falls back for the rest', async () => {
    const one = await reader.estimateClaim([10001])
    expect(one.simulated).toBe(true)
    // Current RBT2 includes automatic voting checkpoints, unlike the original bridge.
    expect(one.gas).toBeGreaterThan(60_000)
    expect(one.gas).toBeLessThan(300_000)
    expect(BigInt(one.fee)).toBe(BigInt(one.gas) * BigInt(one.gasPrice))
    const two = await reader.estimateClaim([10007, 10008])
    expect(two.simulated).toBe(true)
    expect(two.gas).toBeGreaterThan(one.gas)
    // The unproven id makes simulation fail, so the reader returns its fallback estimate.
    expect(await reader.estimateClaim([10007, 10009])).toMatchObject({ simulated: false })
  })

  it('claims one kid with bridge.claim', async () => {
    const { txHash } = await writer().claim([10001])
    const tx = await publicClient.getTransaction({ hash: txHash })
    expect(tx.to?.toLowerCase()).toBe(BRIDGE.toLowerCase())
    expect(await ownerOf(10001)).toBe(RECIPIENT)
  })

  it('claims several kids with bridge.claimMany', async () => {
    const stages: string[] = []
    const { txHash } = await writer().claim([10007, 10008], { onStage: (s) => stages.push(s) })
    expect(stages).toEqual(['signing', 'confirming'])
    const tx = await publicClient.getTransaction({ hash: txHash })
    expect(tx.to?.toLowerCase()).toBe(BRIDGE.toLowerCase())
    expect(decodeFunctionData({ abi: bridgeAbi, data: tx.input })).toMatchObject({ functionName: 'claimMany', args: [[10007, 10008]] })
    expect(await ownerOf(10007)).toBe(RECIPIENT)
    expect(await ownerOf(10008)).toBe(RECIPIENT)
  })

  it('refuses an already-minted kid with NotProven', async () => {
    // Also arrange the mint when this test is run alone.
    await writer()
      .claim([10001])
      .catch((e: unknown) => {
        if (!(e instanceof BridgeError) || e.code !== 'NotProven') throw e
      })

    const err = await writer().claim([10001]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BridgeError)
    expect(err).toMatchObject({ code: 'NotProven', tokenId: 10001 })
    expect((err as BridgeError).detail).toBe('already minted: #10001')

    const mixed = await writer().claim([10001, 10009]).catch((e: unknown) => e)
    expect(mixed).toMatchObject({ code: 'NotProven' })
    expect((mixed as BridgeError).detail).toBe('already minted: #10001; not proven yet: #10009')
  })

  it('claimMany skips a kid someone else claimed after the status read', async () => {
    // #10011 gets minted behind the writer's back; its stale reader still thinks it is claimable.
    await createWalletClient({ account, chain: mainnet, transport: http(url) }).writeContract({
      address: BRIDGE,
      abi: bridgeAbi,
      functionName: 'claim',
      args: [10011],
    })
    const stale: EthReader = {
      ...reader,
      kidStatus: (ids) => Promise.resolve(new Map(ids.map((id): [KidId, KidEthStatus] => [id, { proven: RECIPIENT, owner: null }]))),
    }
    const { txHash } = await createEthWriter({
      deployment,
      publicClient,
      reader: stale,
      walletClient: createWalletClient({ account, chain: mainnet, transport: http(url) }),
    }).claim([10010, 10011, 10012])
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    expect(receipt.status).toBe('success')
    expect(receipt.to?.toLowerCase()).toBe(BRIDGE.toLowerCase())
    // All requested ids reach claimMany; the contract safely skips the already-minted one.
    const tx = await publicClient.getTransaction({ hash: txHash })
    expect(decodeFunctionData({ abi: bridgeAbi, data: tx.input })).toMatchObject({ functionName: 'claimMany', args: [[10010, 10011, 10012]] })
    expect(await ownerOf(10010)).toBe(RECIPIENT)
    expect(await ownerOf(10012)).toBe(RECIPIENT)
  })

  it('shows every claim in kidStatus', async () => {
    const status = await reader.kidStatus([10001, 10007, 10008, 10009, 10010, 10011, 10012])
    for (const id of [10001, 10007, 10008, 10010, 10011, 10012]) expect(status.get(id)).toEqual({ proven: RECIPIENT, owner: RECIPIENT })
    expect(status.get(10009)).toEqual({ proven: null, owner: null })
  })
})
