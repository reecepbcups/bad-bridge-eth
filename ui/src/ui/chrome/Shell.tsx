import { lazy, Suspense, useEffect, type MouseEvent, type ReactNode } from 'react'
import { useBridge } from '../../chain/context'
import type { Route } from '../../router'
import { Banners } from './Banners'
import { ContractBar } from './ContractBar'
import { Footer } from './Footer'
import { Header } from './Header'
import { tabOf, Tabs } from './Tabs'

// demo only, so real pages never download it
const DevBar = lazy(() => import('./DevBar').then((m) => ({ default: m.DevBar })))

/** Page chrome around the current view: dev toolbar (demo only), header, contract bar, banners, tabs, the view, footer. */
export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { deployment } = useBridge()
  // block body on purpose: scrollTo returns a promise in newer browsers, and effects must return a cleanup or nothing
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [route.name])
  return (
    <div className="wrap">
      <a className="skip" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      {deployment.demo && (
        <Suspense fallback={null}>
          <DevBar route={route} />
        </Suspense>
      )}
      <Header />
      <ContractBar />
      <Banners />
      <Tabs current={tabOf(route.name)} />
      {children}
      <Footer />
    </div>
  )
}

/** The hash is the router's, so "#main" would be a 404: move focus by hand instead. */
export function skipToMain(e: MouseEvent<HTMLAnchorElement>): void {
  e.preventDefault()
  const target = document.querySelector<HTMLElement>('#main h2') ?? document.getElementById('main')
  if (!target) return
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus()
}
