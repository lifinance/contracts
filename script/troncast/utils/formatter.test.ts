/**
 * Unit tests for troncast value formatting.
 * Run these when changing how raw TRX values are displayed.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { formatValue } from './formatter'

describe('formatValue', () => {
  it('formats a numeric value using the default six decimals', () => {
    expect(formatValue(1_500_000)).toBe('1.5 TRX')
  })

  it('uses a custom decimals argument', () => {
    expect(formatValue(12_345, 2)).toBe('123.45 TRX')
  })

  it('formats zero', () => {
    expect(formatValue(0)).toBe('0 TRX')
  })

  it('parses a string value with the default decimals', () => {
    expect(formatValue('2500000')).toBe('2.5 TRX')
  })

  it('parses a string value with custom decimals', () => {
    expect(formatValue('1234', 3)).toBe('1.234 TRX')
  })
})
