import { describe, expect, it } from 'vitest'
import { DEPLOYMENTS } from '../config/deployments'
import { claimedToast, formatEth } from './Claim'

describe('formatEth', () => {
  it('shows wei as ETH to two significant figures', () => {
    expect(formatEth('218000000000000')).toBe('0.00022 ETH')
    expect(formatEth('79000000000000')).toBe('0.000079 ETH')
    expect(formatEth('600000000000000')).toBe('0.0006 ETH')
    expect(formatEth('1234500000000000000')).toBe('1.2 ETH')
    expect(formatEth('0')).toBe('0 ETH')
    expect(formatEth('999')).toBe('< 0.000001 ETH')
    expect(formatEth('nope')).toBe('nope wei')
  })
})

describe('claimedToast', () => {
  it('is the same everywhere: kids in the order given, one body, an Etherscan link', () => {
    const explorer = DEPLOYMENTS['reece-test'].explorer
    expect(claimedToast([9176, 6413], '0xabc', explorer)).toEqual({
      tone: 'ok',
      title: 'Claimed #9176 & #6413',
      body: 'Minted on Ethereum. Welcome home.',
      link: { href: 'https://etherscan.io/tx/0xabc', label: 'See it on Etherscan' },
    })
    expect(claimedToast([1, 2, 3, 4], '0xabc', explorer).title).toBe('Claimed 4 kids')
  })
})
