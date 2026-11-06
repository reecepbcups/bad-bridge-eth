import { useBridge } from '../../chain/context'
import { ExtLink } from '../ExtLink'
import './Footer.css'

export function Footer() {
  const { deployment } = useBridge()
  const { eth, explorer, verifiedUrl } = deployment
  return (
    <footer className="footer">
      <span>
        <b>One way only:</b> Cosmos Hub → Ethereum. There's no bridge back.
      </span>
      <span>Same token IDs, same art. Metadata stays on IPFS; only the kid moves.</span>
      {eth.bridge && (
        <span>
          Bridge contract{' '}
          <ExtLink className="mono" href={explorer.ethAddress(eth.bridge)}>
            {eth.bridge}
          </ExtLink>
          {verifiedUrl && (
            <>
              {' '}· Contract is{' '}
              <ExtLink className="verified" href={verifiedUrl}>
                VERIFIED
              </ExtLink>
            </>
          )}
        </span>
      )}
    </footer>
  )
}
