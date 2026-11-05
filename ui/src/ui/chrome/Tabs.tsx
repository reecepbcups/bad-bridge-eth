import { useBridge } from '../../chain/context'
import type { RouteName } from '../../router'
import { useTrips } from '../../trips/hooks'
import './Tabs.css'

export type Tab = 'bridge' | 'crossing' | 'kids' | 'about' | 'activity'

export function tabOf(route: RouteName): Tab | null {
  if (route === 'bridge' || route === 'crossing' || route === 'about' || route === 'activity') return route
  if (route === 'kids' || route === 'kid') return 'kids'
  return null
}

const TABS: readonly { tab: Tab; href: string; label: string }[] = [
  { tab: 'bridge', href: '#/', label: 'Bridge a kid' },
  { tab: 'crossing', href: '#/crossing', label: 'Crossing' },
  { tab: 'kids', href: '#/kids', label: 'My Eth kids' },
  { tab: 'about', href: '#/about', label: 'About' },
  { tab: 'activity', href: '#/activity', label: 'Activity' },
]

/** Top-level sections. Links, not ARIA tabs: each one is its own route. */
export function Tabs({ current }: { current: Tab | null }) {
  return <TabLinks current={current} moving={useMovingCount()} />
}

/** The tab strip itself, without chain reads, so the loading shell can draw it too. */
export function TabLinks({ current, moving = 0 }: { current: Tab | null; moving?: number }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {TABS.map(({ tab, href, label }) => (
        <a key={tab} className="tab" href={href} aria-current={tab === current ? 'page' : undefined}>
          {label}
          {tab === 'crossing' && moving > 0 && (
            <span className="badge">
              {moving}
              <span className="sr-only"> on the way</span>
            </span>
          )}
        </a>
      ))}
    </nav>
  )
}

/** Kids headed to the connected Ethereum wallet that aren't home yet. */
function useMovingCount(): number {
  const { ethWallet } = useBridge()
  const trips = useTrips({ eth: ethWallet.status === 'connected' ? ethWallet.address : undefined })
  return trips.data?.filter((t) => t.stage !== 'home-eth' && t.stage !== 'home-hub').length ?? 0
}
