import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { getAddress } from 'viem'

import { parseTokenSweepList } from './tokenSweepHelpers'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

describe('parseTokenSweepList', () => {
  it('parses a valid list and checksums every address', () => {
    const raw = JSON.stringify({
      mainnet: [USDC.toLowerCase(), WETH.toLowerCase()],
      base: [USDC.toLowerCase()],
    })
    expect(parseTokenSweepList(raw)).toEqual({
      mainnet: [getAddress(USDC), getAddress(WETH)],
      base: [getAddress(USDC)],
    })
  })

  it('accepts an empty object', () => {
    expect(parseTokenSweepList('{}')).toEqual({})
  })

  it('rejects a JSON array at the top level', () => {
    expect(() => parseTokenSweepList('[]')).toThrow('must be a JSON object')
  })

  it('rejects a non-object top level', () => {
    expect(() => parseTokenSweepList('42')).toThrow('must be a JSON object')
  })

  it('rejects null', () => {
    expect(() => parseTokenSweepList('null')).toThrow('must be a JSON object')
  })

  it('rejects a non-array network entry', () => {
    expect(() =>
      parseTokenSweepList(JSON.stringify({ mainnet: USDC }))
    ).toThrow('must be an array')
  })

  it('rejects a non-string token address', () => {
    expect(() =>
      parseTokenSweepList(JSON.stringify({ mainnet: [123] }))
    ).toThrow('Non-string token address')
  })

  it('rejects a malformed token address', () => {
    expect(() =>
      parseTokenSweepList(JSON.stringify({ mainnet: ['0xnothex'] }))
    ).toThrow()
  })
})
