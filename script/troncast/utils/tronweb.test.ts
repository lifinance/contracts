/**
 * `parseValue` decides how much TRX a `troncast send` carries, so a value it
 * loses or rounds is value the operator did not agree to send.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { parseValue } from './tronweb'

describe('parseValue — TRX to SUN', () => {
  it.each([
    ['1tron', '1000000'],
    ['0.1tron', '100000'],
    // 4.1 * 1e6 is 4099999.9999999995 in floating point, and 2128 of the
    // ~14,000 amounts with up to six decimals multiply just as untidily.
    ['4.1tron', '4100000'],
    ['12.345678tron', '12345678'],
    ['0.000001tron', '1'],
    ['0tron', '0'],
    // Shifted digit-wise rather than multiplied, so this does not become the
    // string "1e+21", which is not a SUN amount.
    ['1000000000000000tron', '1000000000000000000000'],
  ])('converts %s to %s SUN', (input, expected) => {
    expect(parseValue(input)).toBe(expected)
  })

  it('refuses an amount finer than one SUN rather than rounding it away', () => {
    // 0.4 SUN. Rounded it becomes 0, which would broadcast a zero-value call
    // for a nonzero --value.
    expect(() => parseValue('0.0000004tron')).toThrow(/finer than one SUN/)
  })

  it.each(['abctron', '-1tron', '1.2.3tron', 'tron', '1e6tron'])(
    'refuses the malformed amount %s',
    (input) => {
      expect(() => parseValue(input)).toThrow(/Invalid TRX amount/)
    }
  )

  it('passes a SUN amount through, suffixed or bare', () => {
    expect(parseValue('100000sun')).toBe('100000')
    expect(parseValue('1000000')).toBe('1000000')
  })
})
