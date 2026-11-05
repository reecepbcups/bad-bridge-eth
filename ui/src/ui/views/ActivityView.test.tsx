import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordActivity, resetActivityStorage } from '../../activity/storage'
import { fakeBridge, fakeChain, LIVE, networkError } from '../../trips/fakes'
import { ActivityView } from './ActivityView'

const HUB_HASH = 'AB'.repeat(32)
const ETH_OK = `0x${'cd'.repeat(32)}`
const ETH_BAD = `0x${'ef'.repeat(32)}`
const REQUEST_ID = `0x${'12'.repeat(32)}`
const T0 = Date.parse('2026-09-27T17:00:00Z')

beforeEach(() => {
  localStorage.clear()
  resetActivityStorage()
})

afterEach(() => {
  localStorage.clear()
  resetActivityStorage()
})

describe('ActivityView', () => {
  it('says so when nothing has been signed', () => {
    const { wrapper } = fakeBridge()
    render(<ActivityView />, { wrapper })
    expect(screen.getByText('Nothing signed yet')).toBeInTheDocument()
    expect(document.title).toBe('Activity · Bad Bridge')
  })

  it('lists everything newest first with live status and explorer links', async () => {
    recordActivity(LIVE.id, { action: 'send', hash: HUB_HASH, kids: [7, 9], at: T0 })
    recordActivity(LIVE.id, { action: 'sign-proof-request', requestId: REQUEST_ID, kids: [7, 9], at: T0 + 1 })
    recordActivity(LIVE.id, { action: 'submit-proof', hash: ETH_BAD, at: T0 + 2 })
    recordActivity(LIVE.id, { action: 'claim', hash: ETH_OK, kids: [7], at: T0 + 3 })
    const chain = fakeChain()
    chain.txs.set(HUB_HASH, 'confirmed')
    chain.txs.set(ETH_BAD, 'failed')
    // ETH_OK not set: still pending
    const { wrapper } = fakeBridge(chain)
    render(<ActivityView />, { wrapper })

    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => within(r).getByText(/Claim|Submit proof|Sign proof request|Send kids to escrow/).textContent)).toEqual([
      'Claim',
      'Submit proof',
      'Sign proof request',
      'Send kids to escrow',
    ])
    const [claim, submit, sign, send] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(await within(claim).findByText('pending')).toBeInTheDocument()
    expect(within(claim).getByText('Ethereum')).toBeInTheDocument()
    expect(within(claim).getByText('#7')).toBeInTheDocument()
    expect(within(claim).getByRole('link')).toHaveAttribute('href', LIVE.explorer.ethTx(ETH_OK))
    expect(await within(submit).findByText('failed')).toBeInTheDocument()
    expect(within(sign).getByText('signed')).toBeInTheDocument()
    expect(within(sign).getByText('Succinct')).toBeInTheDocument()
    expect(within(sign).getByRole('link')).toHaveAttribute('href', `https://explorer.succinct.xyz/request/${REQUEST_ID}`)
    expect(await within(send).findByText('confirmed')).toBeInTheDocument()
    expect(within(send).getByText('#7 & #9')).toBeInTheDocument()
    expect(within(send).getByRole('link')).toHaveAttribute('href', LIVE.explorer.hubTx(HUB_HASH))
  })

  it('shows unknown when the status read fails', async () => {
    recordActivity(LIVE.id, { action: 'nudge', hash: HUB_HASH, at: T0 })
    const chain = fakeChain({ fail: { txStatus: networkError() } })
    const { wrapper } = fakeBridge(chain)
    render(<ActivityView />, { wrapper })
    expect(await screen.findByText('unknown')).toBeInTheDocument()
    expect(screen.getByText('Nudge')).toBeInTheDocument()
  })
})
