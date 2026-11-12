import { useBridge } from '../../chain/context'
import { ExtLink } from '../ExtLink'
import { shortAddress } from '../format'
import './ContractBar.css'

/** Pinned to the bottom of the screen on every page: the bridge contract, its verified source, and the collection on OpenSea. */
export function ContractBar() {
  const { deployment } = useBridge()
  const { eth, explorer, verifiedUrl } = deployment
  if (!eth.bridge) return null
  const opensea = explorer.openseaCollection()
  return (
    <div className="contract-bar">
      <div className="contract-bar-inner">
        <span>
          Bridge contract{' '}
          <ExtLink className="mono" href={explorer.ethAddress(eth.bridge)}>
            <span className="full">{eth.bridge}</span>
            <span className="short">{shortAddress(eth.bridge)}</span>
          </ExtLink>
          {verifiedUrl && (
            <>
              {' '}·{' '}
              <ExtLink className="verified" href={verifiedUrl}>
                VERIFIED
              </ExtLink>
            </>
          )}
        </span>
        {opensea && (
          <ExtLink className="btn ghost small opensea" href={opensea} aria-label={`${deployment.collectionName} on OpenSea`}>
            <OpenSeaLogo /> OpenSea
          </ExtLink>
        )}
      </div>
    </div>
  )
}

// simplified lookalike of the OpenSea mark, not the official asset
function OpenSeaLogo() {
  return (
    <svg viewBox="0 0 90 90" width="18" height="18" aria-hidden="true">
      <circle cx="45" cy="45" r="45" fill="#2081E2" />
      <path d="M22 47 34 28c2 4 5 11 3 15-1 2-2 3-3 4Z" fill="#fff" />
      <path d="M44 18c9 6 15 16 15 27 0 3-1 6-2 8H44Z" fill="#fff" />
      <path d="M18 57h54c-2 9-9 15-18 15H34c-8 0-14-6-16-15Z" fill="#fff" />
    </svg>
  )
}
