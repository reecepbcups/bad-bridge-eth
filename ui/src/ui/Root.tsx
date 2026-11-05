import { href, useRoute, type Route } from '../router'
import { Card } from './chrome/Card'
import { Shell } from './chrome/Shell'
import { ErrorBoundary } from './ErrorBoundary'
import { useFocusHeadingOnChange } from './hooks'
import { ToastProvider } from './Toasts'
import { useTitle } from './useTitle'
import { AboutView } from './views/AboutView'
import { ActivityView } from './views/ActivityView'
import { BridgeView } from './views/bridge/BridgeView'
import { FlowProvider } from './views/bridge/flow'
import { KidsView } from './views/KidsView'
import { KidView } from './views/KidView'
import { NotFoundView } from './views/NotFoundView'

/** Everything inside the chain provider: the chrome and the view for the current route. */
export function Root() {
  const route = useRoute()
  const key = href(route)
  useFocusHeadingOnChange(key)
  return (
    <ToastProvider>
      <FlowProvider>
        <Shell route={route}>
          <ErrorBoundary resetKey={key} fallback={(error, reset) => <ViewCrashed error={error} reset={reset} />}>
            <RouteView route={route} />
          </ErrorBoundary>
        </Shell>
      </FlowProvider>
    </ToastProvider>
  )
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case 'bridge':
      return <BridgeView />
    case 'crossing':
      return <KidsView key={`crossing/${route.address ?? ''}`} mode="crossing" address={route.address} />
    case 'kids':
      return <KidsView key={route.address ?? ''} mode="home" address={route.address} />
    case 'kid':
      return <KidView key={route.id} id={route.id} />
    case 'about':
      return <AboutView />
    case 'activity':
      return <ActivityView />
    case 'not-found':
      return <NotFoundView path={route.path} />
  }
}

function ViewCrashed({ error, reset }: { error: Error; reset: () => void }) {
  useTitle('Oops')
  return (
    <Card>
      <h2 tabIndex={-1}>Oops, this page tripped</h2>
      <p className="lede">
        Something broke while drawing it. Your kids are safe: nothing here can move them without your wallet.
        {/* COPY: crash fallback */}
      </p>
      <div className="row start">
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
        <a className="btn ghost" href="#/" onClick={reset}>
          Back to the bridge
        </a>
      </div>
      <details className="hint">
        <summary>Details</summary>
        <span className="mono">{error.message}</span>
      </details>
    </Card>
  )
}
