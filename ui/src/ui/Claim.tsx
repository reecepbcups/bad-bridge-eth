import { useState } from 'react'
import { useBridge } from '../chain/context'
import type { BridgeError, ClaimStage, KidId } from '../chain/types'
import type { Explorers } from '../config/deployments'
import { useClaimKids } from '../trips/hooks'
import { ConnectButton } from './Connect'
import { kidList } from './format'
import { useToast, type Toast } from './Toasts'

// Cap on ids batched into one claim tx, so a big ready list can't blow the block gas limit.
// TODO(confirm): 40 is a guess, not measured against real per-mint claim gas cost.
export const CLAIM_BATCH_CAP = 40

/** The toast after any claim, the same everywhere. Kids are listed in the order given. */
export function claimedToast(ids: readonly KidId[], txHash: string, explorer: Explorers): Toast {
  return {
    tone: 'ok',
    title: `Claimed ${ids.length > 3 ? `${ids.length} kids` : kidList(ids)}`,
    body: 'Minted on Ethereum. Welcome home.',
    link: { href: explorer.ethTx(txHash), label: 'See it on Etherscan' },
  }
}

/** "0.00016 ETH": a wei amount to two significant figures. */
export function formatEth(wei: string): string {
  const value = Number(wei) / 1e18
  if (!/^\d+$/.test(wei) || !Number.isFinite(value)) return `${wei} wei`
  if (value === 0) return '0 ETH'
  if (value < 0.000001) return '< 0.000001 ETH'
  return `${Number(value.toPrecision(2))} ETH`
}

/** One claim mutation shared by a list of rows, remembering which kids the current or last claim was for. */
export interface ClaimFlow {
  run: (ids: readonly KidId[]) => Promise<void>
  pending: boolean
  /** Kids in the claim that's running. */
  claiming: readonly KidId[]
  /** Where the running claim is: signing (wallet prompt up) → confirming (sent, waiting to be mined). */
  stage: ClaimStage | null
  /** The last failure and the kids it was for. */
  failure: { error: BridgeError; ids: readonly KidId[] } | null
}

export function useClaimFlow(): ClaimFlow {
  const { deployment } = useBridge()
  const claim = useClaimKids()
  const toast = useToast()
  const [claiming, setClaiming] = useState<readonly KidId[]>([])
  const [failure, setFailure] = useState<ClaimFlow['failure']>(null)
  const run = async (ids: readonly KidId[]) => {
    setClaiming(ids)
    setFailure(null)
    try {
      const result = await claim.run(ids)
      toast(claimedToast(result.claimed, result.txHash, deployment.explorer))
    } catch (e) {
      setFailure({ error: e as BridgeError, ids })
    } finally {
      setClaiming([])
    }
  }
  const pending = claim.status === 'pending'
  return { run, pending, claiming, stage: pending ? (claim.stage ?? 'signing') : null, failure }
}

// COPY: claim progress (button label and status line)
/** A claim button's label while its claim runs. */
export function claimingLabel(stage: ClaimStage, walletName: string | undefined): string {
  return stage === 'confirming' ? 'Claiming…' : `Check ${walletName ?? 'your wallet'}…`
}

/** The status line while a claim runs. */
export function claimingHint(stage: ClaimStage, walletName: string | undefined): string {
  return stage === 'confirming' ? 'Sent. Waiting for Ethereum to mine it…' : `Approve it in ${walletName ?? 'your wallet'}.`
}

/** A Claim button for some ready kids. Without an Ethereum wallet it opens the connect sheet instead. */
export function ClaimButton({ ids, flow, children }: { ids: readonly KidId[]; flow: ClaimFlow; children: string }) {
  const { ethWallet, ethWriter } = useBridge()
  // finds this button again after a connect, even if the list around it re-rendered from scratch
  const key = ids.join(' ')
  if (!ethWriter) {
    return (
      <ConnectButton chain="eth" className="btn eth" focusAfter={() => document.querySelector<HTMLElement>(`[data-claim="${key}"]`)}>
        {children}
      </ConnectButton>
    )
  }
  const mine = ids.some((id) => flow.claiming.includes(id))
  // aria-disabled while a claim runs, so focus stays on the button; the click is refused here instead
  return (
    <button
      type="button"
      className="btn eth"
      data-claim={key}
      disabled={ethWallet.wrongChain === true}
      aria-disabled={flow.pending || undefined}
      onClick={() => {
        if (!flow.pending) void flow.run(ids)
      }}
    >
      {mine && flow.stage ? claimingLabel(flow.stage, ethWallet.walletName) : children}
    </button>
  )
}
