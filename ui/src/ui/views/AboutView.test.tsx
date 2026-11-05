import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fakeBridge, fakeChain, LIVE, NOT_LIVE } from '../../trips/fakes'
import { AboutView } from './AboutView'

// The trust list says what's true of this deployment, from live reads, not what we hope is true.

const REECE = 'cosmos1reece3m8g4m3d0qrpj93rnnseudnpzhrey64rr'
const BADKIDS_ADMIN = 'cosmos1s8qx0zvz8yd6e4x0mqmqf7fr9vvfn6226hkvrq'

function trustList() {
  return within(screen.getByRole('heading', { name: 'Why you can trust it' }).nextElementSibling as HTMLElement)
}

describe('AboutView trust facts', () => {
  it('names the admins of a test escrow and collection, and never claims "no admin keys"', async () => {
    const chain = fakeChain()
    chain.contracts.set(LIVE.hub.escrow ?? '', { codeId: 750, admin: REECE })
    chain.contracts.set(LIVE.hub.cw721, { codeId: 431, admin: BADKIDS_ADMIN })
    chain.proxies.set(LIVE.eth.router.toLowerCase(), '0x17fa3A98D0239a399927C7c3CCdE142e08Deb7B5')
    const { wrapper } = fakeBridge(chain)
    render(<AboutView />, { wrapper })

    expect(await screen.findByText('This test escrow has an admin')).toBeInTheDocument()
    expect(screen.getByText('The ReeceBadTestTwo contract has an admin')).toBeInTheDocument()
    expect(trustList().getAllByRole('link', { name: /cosmos1ree…64rr/ })[0]).toHaveAttribute('href', `https://www.mintscan.io/cosmos/address/${REECE}`)
    expect(screen.getByText(/the Eureka router that points to it can be upgraded/)).toBeInTheDocument()
    expect(screen.getByText(/governance can freeze that client or replace the router's entry/)).toBeInTheDocument()
    expect(screen.queryByText(/No admin keys/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Nobody can pause/i)).not.toBeInTheDocument()
    expect(screen.getByText(/One catch: the ReeceBadTestTwo contract has an admin/)).toBeInTheDocument()
    expect(document.title).toBe('About · Bad Bridge')
  })

  it('merges the caveat when the collection and escrow share an admin', async () => {
    const chain = fakeChain()
    chain.contracts.set(LIVE.hub.escrow ?? '', { codeId: 750, admin: REECE })
    chain.contracts.set(LIVE.hub.cw721, { codeId: 431, admin: REECE })
    const { wrapper } = fakeBridge(chain)
    render(<AboutView />, { wrapper })

    expect(await screen.findByText('The ReeceBadTestTwo contract and this test escrow share an admin')).toBeInTheDocument()
    expect(screen.queryByText('This test escrow has an admin')).not.toBeInTheDocument()
    expect(screen.queryByText('The ReeceBadTestTwo contract has an admin')).not.toBeInTheDocument()
  })

  it('says "no admin" only when the admin is empty', async () => {
    const chain = fakeChain()
    chain.contracts.set(LIVE.hub.escrow ?? '', { codeId: 750, admin: null })
    chain.contracts.set(LIVE.hub.cw721, { codeId: 431, admin: null })
    const { wrapper } = fakeBridge(chain)
    render(<AboutView />, { wrapper })
    expect(await screen.findByText('The escrow has no upgrade admin.')).toBeInTheDocument()
    expect(screen.getByText('Emergency unlock is renounced.')).toBeInTheDocument()
    expect(screen.getByText('The ReeceBadTestTwo contract has no admin.')).toBeInTheDocument()
    expect(screen.queryByText(/router that points to it/)).not.toBeInTheDocument()
    expect(screen.queryByText(/One catch/)).not.toBeInTheDocument()
  })

  it("says it couldn't check, rather than guessing", async () => {
    const { wrapper } = fakeBridge(fakeChain({ contracts: new Map() }))
    render(<AboutView />, { wrapper })
    expect(await screen.findByText("Couldn't check who can change the escrow just now.")).toBeInTheDocument()
    expect(screen.queryByText('The escrow has no upgrade admin.')).not.toBeInTheDocument()
  })

  it('distinguishes renounced migration authority from an active emergency-unlock admin', async () => {
    const { wrapper } = fakeBridge(fakeChain({ emergencyAdmin: REECE }))
    render(<AboutView />, { wrapper })
    expect(await screen.findByText('The escrow has no upgrade admin.')).toBeInTheDocument()
    expect(screen.getByText('The escrow has an emergency-unlock admin.')).toBeInTheDocument()
    expect(screen.queryByText('Emergency unlock is renounced.')).not.toBeInTheDocument()
    expect(screen.queryByText('BadBridge has no owner.')).not.toBeInTheDocument()
  })

  it('before launch, only the collection is checked', async () => {
    const chain = fakeChain()
    chain.contracts.set(NOT_LIVE.hub.cw721, { codeId: 434, admin: BADKIDS_ADMIN })
    const { wrapper } = fakeBridge(chain, { deployment: NOT_LIVE })
    render(<AboutView />, { wrapper })
    expect(await screen.findByText('The Bad Kids contract has an admin')).toBeInTheDocument()
    expect(screen.queryByText(/escrow has/)).not.toBeInTheDocument()
    expect(screen.queryByText(/It leans on IBC Eureka/)).not.toBeInTheDocument()
  })
})

describe('AboutView health strip', () => {
  it('calls a frozen client "Stuck"', async () => {
    const { wrapper } = fakeBridge(fakeChain({ client: { latestHeight: 9_900, frozen: true } }))
    render(<AboutView />, { wrapper })
    const health = await screen.findByLabelText('Bridge health')
    expect(health).toHaveTextContent('Stuck')
    expect(health).not.toHaveTextContent('Paused')
  })
})
