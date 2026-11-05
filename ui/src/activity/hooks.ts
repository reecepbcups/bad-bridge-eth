import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useBridge } from '../chain/context'
import type { Hex } from 'viem'
import { POLL_MS } from '../trips/keys'
import { ACTION_CHAIN, activityLog, subscribeActivity, type Activity } from './storage'

/** `signed`: an off-chain signature, nothing to look up. `unknown`: the read failed, or this adapter can't read txs. */
export type ActivityStatus = 'pending' | 'confirmed' | 'failed' | 'signed' | 'unknown'

const NONE: readonly Activity[] = []

/** This browser's activity for the current deployment, oldest first. Updates on writes from this tab or another. */
export function useActivityLog(): readonly Activity[] {
  const { deployment } = useBridge()
  return useSyncExternalStore(subscribeActivity, () => activityLog(deployment.id), () => NONE)
}

/** One entry's live status, re-read every 30s while it's pending. Null while the first read runs. */
export function useActivityStatus(entry: Activity): ActivityStatus | null {
  const { deployment, hub, eth } = useBridge()
  const chain = ACTION_CHAIN[entry.action]
  const { hash } = entry
  const readable = hash !== undefined && (chain === 'hub' ? hub.txStatus !== undefined : chain === 'eth' && eth.txStatus !== undefined)
  const q = useQuery({
    queryKey: ['bridge', deployment.id, 'activity', hash] as const,
    enabled: readable,
    refetchInterval: (query) => (query.state.data === 'pending' ? POLL_MS : false),
    queryFn: async () => {
      const status = chain === 'hub' ? await hub.txStatus?.(hash ?? '') : await eth.txStatus?.(hash as Hex)
      if (!status) throw new Error('no tx status reader')
      return status
    },
  })
  if (chain === 'succinct') return 'signed'
  if (!readable) return 'unknown'
  if (q.data) return q.data
  return q.isError ? 'unknown' : null
}
