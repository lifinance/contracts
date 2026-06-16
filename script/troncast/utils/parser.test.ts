/**
 * Unit tests for troncast CLI parameter parsing helpers.
 *
 * Focus: extractCallParams, which turns citty's raw positional list (`args._`) into the ordered
 * function arguments for a `troncast call`. Covers the cast-style multi-token form, the historical
 * comma-joined form, trimming, non-string coercion, and the zero-argument case.
 */
import {
  describe,
  it,
  expect,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { extractCallParams } from './parser'

describe('extractCallParams', () => {
  it('returns no params when only address + signature are present', () => {
    expect(
      extractCallParams(['CONTRACT', 'diamond() returns (address)'])
    ).toEqual([])
  })

  it('returns the single trailing positional as one param', () => {
    expect(
      extractCallParams(['TOKEN', 'balanceOf(address)', 'TWALLET'])
    ).toEqual(['TWALLET'])
  })

  it('splits a lone comma-joined positional (historical CSV form)', () => {
    expect(
      extractCallParams(['TL', 'hasRole(bytes32,address)', '0xrole,TSAFE'])
    ).toEqual(['0xrole', 'TSAFE'])
  })

  it('keeps multiple separate positionals as distinct params (cast-style)', () => {
    expect(
      extractCallParams(['TL', 'hasRole(bytes32,address)', '0xrole', 'TSAFE'])
    ).toEqual(['0xrole', 'TSAFE'])
  })

  it('trims whitespace around separate positionals', () => {
    expect(
      extractCallParams(['C', 'f(uint256,uint256)', ' 1 ', ' 2 '])
    ).toEqual(['1', '2'])
  })

  it('trims whitespace around comma-joined values', () => {
    expect(extractCallParams(['C', 'f(uint256,uint256)', '1, 2'])).toEqual([
      '1',
      '2',
    ])
  })

  it('coerces non-string positionals to strings', () => {
    expect(extractCallParams(['C', 'f(uint256,bool)', 123, true])).toEqual([
      '123',
      'true',
    ])
  })

  it('returns no params for an empty positional list', () => {
    expect(extractCallParams([])).toEqual([])
  })
})
