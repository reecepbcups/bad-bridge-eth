import { useCallback, useMemo, useState } from 'react'
import { useAccount, useConfig, useConnectors } from 'wagmi'
import { connect, disconnect, getConnectorClient, getPublicClient, switchChain } from 'wagmi/actions'
import type { Deployment } from '../../config/deployments'
import { BridgeError, type EthAddress, type EthWriter, type WalletOption, type WalletState, type WalletStatus } from '../types'
import { CONNECTOR_IDS } from './config'
import { toEthError } from './errors'
import { createEthWriter } from './writer'

/** The bits of a wagmi connector the option list needs. */
export interface ConnectorInfo {
  id: string
  name: string
  type: string
  icon?: string | undefined
}

/**
 * What the connect sheet offers: every EIP-6963 wallet (installed, with its announced name and icon), the plain
 * injected connector only when nothing announced itself but window.ethereum exists, then Coinbase and WalletConnect.
 */
export function ethWalletOptions(connectors: readonly ConnectorInfo[], hasInjectedProvider: boolean): WalletOption[] {
  const announced = connectors.filter((c) => c.type === 'injected' && c.id !== CONNECTOR_IDS.injected)
  const options: WalletOption[] = announced.map((c) => ({ id: c.id, name: c.name, installed: true, icon: c.icon }))
  if (announced.length === 0 && hasInjectedProvider && connectors.some((c) => c.id === CONNECTOR_IDS.injected)) {
    options.push({ id: CONNECTOR_IDS.injected, name: 'Browser wallet', installed: true })
  }
  for (const id of [CONNECTOR_IDS.coinbase, CONNECTOR_IDS.walletConnect]) {
    const c = connectors.find((x) => x.id === id)
    // neither needs an extension: Coinbase falls back to its web popup, WalletConnect to a QR code
    if (c) options.push({ id: c.id, name: c.name, installed: true, icon: c.icon })
  }
  return options
}

function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && (window as { ethereum?: unknown }).ethereum !== undefined
}

/**
 * wagmi-backed Ethereum wallet. Call under EthWalletProvider.
 * - Reload reconnects on its own (WagmiProvider's reconnectOnMount); that shows as "connecting".
 * - `wrongChain` is set while connected to another network; `switchChain()` asks the wallet to move.
 */
export function useEthWallet(deployment: Deployment): WalletState<EthAddress> {
  const config = useConfig()
  const { status: wagmiStatus, address, connector, chainId } = useAccount()
  const connectors = useConnectors()
  const [pending, setPending] = useState(false)
  const target = deployment.eth.chainId

  const options = useMemo(() => ethWalletOptions(connectors, hasInjectedProvider()), [connectors])

  const connectTo = useCallback(
    async (id: string) => {
      const connector = config.connectors.find((c) => c.id === id)
      if (!connector) throw new BridgeError('Unknown', `no Ethereum wallet "${id}"`)
      setPending(true)
      try {
        // no chainId here: if the connector needs to switch chains and the user rejects, connect() would throw
        // and abort the whole attempt. Let it connect on whatever chain, and wrongChain/switchChain handle the rest.
        await connect(config, { connector })
      } catch (e) {
        if (e instanceof Error && e.name === 'ConnectorAlreadyConnectedError') return
        throw toEthError(e)
      } finally {
        setPending(false)
      }
    },
    [config],
  )

  const disconnectAll = useCallback(async () => {
    try {
      await disconnect(config)
    } catch {
      // never rejects: a wallet that won't say goodbye is disconnected as far as we care
    }
  }, [config])

  const switchToTarget = useCallback(async () => {
    try {
      await switchChain(config, { chainId: target })
    } catch (e) {
      const err = toEthError(e)
      // a switch the wallet can't do (unknown chain, no wallet_switchEthereumChain) is still a wrong chain
      throw err.code === 'Unknown' ? new BridgeError('WrongChain', err.detail, { cause: e }) : err
    }
  }, [config, target])

  return useMemo<WalletState<EthAddress>>(() => {
    const connected = wagmiStatus === 'connected' && address !== undefined
    // wagmi says "connecting" during the mount-time reconnect even with nothing to reconnect; only a remembered
    // session ("reconnecting") or a connect() we started counts
    const status: WalletStatus = connected ? 'connected' : wagmiStatus === 'reconnecting' || pending ? 'connecting' : 'disconnected'
    return {
      status,
      address: connected ? address : undefined,
      walletName: connected ? connector?.name : undefined,
      options,
      connect: connectTo,
      disconnect: disconnectAll,
      wrongChain: connected && chainId !== target,
      switchChain: switchToTarget,
    }
  }, [wagmiStatus, address, connector, chainId, target, pending, options, connectTo, disconnectAll, switchToTarget])
}

/** Signer for the connected Ethereum wallet, or null while disconnected. Call under EthWalletProvider. */
export function useEthWriter(deployment: Deployment): EthWriter | null {
  const config = useConfig()
  const { status, address, connector } = useAccount()
  return useMemo(() => {
    if (status !== 'connected' || !address || !connector) return null
    const publicClient = getPublicClient(config, { chainId: deployment.eth.chainId })
    if (!publicClient) return null
    return createEthWriter({
      deployment,
      address,
      publicClient,
      // fresh per claim, from the current connection, without wagmi's chain assertion: the writer checks the
      // chain itself (WrongChain). `account` makes wagmi refuse if the wallet has moved to another account.
      getWalletClient: () => getConnectorClient(config, { account: address, assertChainId: false }),
    })
  }, [config, deployment, status, address, connector])
}
