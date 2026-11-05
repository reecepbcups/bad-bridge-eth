import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigSanity, Health, QueryState } from '../../trips/types'
import { Banners } from './Banners'

// The demo can't produce a config mismatch, so feed the banner hook results directly.

const state = <T,>(data: T | undefined): QueryState<T> => ({ data, error: null, isLoading: false, isFetching: false, refetch: () => undefined })
const hooks = vi.hoisted((): { health: unknown; sanity: unknown } => ({ health: undefined, sanity: undefined }))

vi.mock('../../trips/hooks', () => ({
  useHealth: () => hooks.health,
  useConfigSanity: () => hooks.sanity,
}))

const health = (frozen: boolean): Health => ({ hubHeight: 10, clientHeight: 9, lagBlocks: 1, lagMinutes: 0.1, frozen, stale: false })

describe('Banners', () => {
  it('shows nothing when all is well, or while loading', () => {
    hooks.health = state(health(false))
    hooks.sanity = state<ConfigSanity>({ ok: true, problems: [], status: 'ok' })
    const { container } = render(<Banners />)
    expect(container).toBeEmptyDOMElement()
    hooks.health = state(undefined)
    hooks.sanity = state(undefined)
    expect(render(<Banners />).container).toBeEmptyDOMElement()
  })

  it('says the bridge is stuck when the client is frozen', () => {
    hooks.health = state(health(true))
    hooks.sanity = state<ConfigSanity>({ ok: true, problems: [], status: 'ok' })
    render(<Banners />)
    expect(screen.getByRole('status')).toHaveTextContent('The bridge is stuck for now')
    expect(screen.getByRole('status')).toHaveTextContent('Kids that already made it across can still be claimed.')
  })

  it('explains a contract mismatch, preferring the hook message', () => {
    hooks.health = state(health(false))
    hooks.sanity = state<ConfigSanity>({
      ok: false,
      status: 'mismatch',
      problems: [
        { code: 'EscrowCollection', expected: 'cosmos1expectedaaaaaaaaaaaaaaaaaaa', actual: 'cosmos1actualbbbbbbbbbbbbbbbbbbbbb' },
        { code: 'BridgeEscrow', expected: '0x01', actual: '0x02', message: 'The bridge trusts another escrow.' },
      ],
    })
    render(<Banners />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Sending is switched off')
    expect(alert).toHaveTextContent('The escrow accepts cosmos1act…bbbb, but this site expects cosmos1exp…aaaa.')
    expect(alert).toHaveTextContent('The bridge trusts another escrow.')
  })

  it('flags escrow admins without switching sending off', () => {
    hooks.health = state(health(false))
    hooks.sanity = state<ConfigSanity>({
      ok: true,
      status: 'ok',
      problems: [],
      warnings: [{ code: 'EscrowAdmin', power: 'emergency unlock', admin: 'cosmos1admin', message: 'The escrow still has an emergency unlock admin.' }],
    })
    render(<Banners />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('The escrow still has admins')
    expect(screen.getByRole('status')).toHaveTextContent('The escrow still has an emergency unlock admin.')
  })

  it('leaves "not live yet" to the pick screen', () => {
    hooks.health = state(health(false))
    hooks.sanity = state<ConfigSanity>({ ok: false, status: 'not-live', problems: [{ code: 'NotLive' }] })
    expect(render(<Banners />).container).toBeEmptyDOMElement()
  })
})
