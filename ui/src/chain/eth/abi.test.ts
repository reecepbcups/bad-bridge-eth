import { toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { bridgeAbi, lightClientAbi, multicall3WriteAbi, routerAbi } from './abi'

// Errors hash like functions: the first 4 bytes of keccak256(signature).
// From `forge inspect BadBridge methodIdentifiers` and `forge inspect BadBridge errors` in eth/.
const FORGE_FUNCTIONS: Record<string, string> = {
  'ESCROW()': '0xe681c4aa',
  'ROUTER()': '0x32fe7b26',
  'clientId()': '0x6bb3471a',
  'claim(uint32)': '0x04951891',
  'claimMany(uint32[])': '0x3948ff7a',
  'lightClient()': '0xb5700e68',
  'ownerOf(uint256)': '0x6352211e',
  'proven(uint32)': '0xec703b2c',
  'submitBatch(uint64,(uint128,bytes32,bytes32),(bytes32,bytes,bytes))': '0x76b1905c',
}
const FORGE_ERRORS: Record<string, string> = {
  'NotProven(uint32)': '0x713871e1',
  'ClientFrozen()': '0x59869f4e',
  'BadConsensusState()': '0x198d4204',
  'BadVKey()': '0xe2aad271',
  'RootMismatch()': '0x5ade0455',
  'BadPath(uint256)': '0xbbfe13b9',
  'ERC721NonexistentToken(uint256)': '0x7e273289',
  'ERC721InvalidSender(address)': '0x73c6ac6e',
  'ERC721InvalidReceiver(address)': '0x64a0ae92',
}

type Input = { type: string; components?: readonly Input[] }
type Item = { type: string; name?: string; inputs?: readonly Input[] }
// Struct params report type "tuple"/"tuple[]"; expand to the canonical (t1,t2,...) form forge prints.
const typeOf = (input: Input): string =>
  input.type.startsWith('tuple') ? `(${(input.components ?? []).map(typeOf).join(',')})${input.type.slice('tuple'.length)}` : input.type
const signature = (item: Item) => `${item.name}(${(item.inputs ?? []).map(typeOf).join(',')})`
const selectors = (items: readonly Item[]) => Object.fromEntries(items.map((x) => [signature(x), toFunctionSelector(signature(x))]))

describe('abi', () => {
  it('matches BadBridge.sol selector for selector', () => {
    expect(selectors(bridgeAbi.filter((x) => x.type === 'function'))).toEqual(FORGE_FUNCTIONS)
    expect(selectors(bridgeAbi.filter((x) => x.type === 'error'))).toEqual(FORGE_ERRORS)
  })

  it('has the ISP1ICS07Tendermint clientState()/getConsensusStateHash()/MEMBERSHIP_PROGRAM_VKEY() and Multicall3 aggregate3 selectors', () => {
    const lightClientFns = Object.fromEntries(lightClientAbi.filter((x) => x.type === 'function').map((x) => [x.name, toFunctionSelector(x)]))
    expect(lightClientFns).toEqual({
      clientState: '0xbd3ce6b0',
      getConsensusStateHash: '0x23842fb8',
      MEMBERSHIP_PROGRAM_VKEY: '0xe45a6d0d',
    })
    expect(toFunctionSelector(multicall3WriteAbi.find((x) => x.type === 'function')!)).toBe('0x82ad56cb')
  })

  // From `cast sig "getCounterparty(string)"`: IICS02Client on Eureka's ICS26Router (cosmos/ibc-contracts).
  it('has the IICS02Client getCounterparty() selector', () => {
    expect(toFunctionSelector(routerAbi.find((x) => x.type === 'function' && x.name === 'getCounterparty')!)).toBe('0xb0777bfa')
  })
})
