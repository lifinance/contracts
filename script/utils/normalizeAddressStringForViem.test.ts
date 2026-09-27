/**
 * Pins normalizeAddressForNetwork against one real Tron/EVM address pair, so a devkit or viem
 * upgrade that shifts base58 decoding or checksum rules fails here before it reaches a script.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normalizeAddressForNetwork } from './normalizeAddressStringForViem'

const TRON_USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_USDT_HEX = '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C'

describe('normalizeAddressForNetwork', () => {
  it('checksums a lowercase EVM address', () => {
    expect(
      normalizeAddressForNetwork(
        'mainnet',
        '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'
      )
    ).toBe(TRON_USDT_HEX)
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeAddressForNetwork('arbitrum', `  ${TRON_USDT_HEX}\n`)).toBe(
      TRON_USDT_HEX
    )
  })

  it.each(['tron', 'tronshasta', 'TRON'])(
    'converts a base58 address to checksummed hex on %s',
    (networkId) => {
      expect(normalizeAddressForNetwork(networkId, TRON_USDT_BASE58)).toBe(
        TRON_USDT_HEX
      )
    }
  )

  it('trims a base58 address before converting it', () => {
    expect(normalizeAddressForNetwork('tron', ` ${TRON_USDT_BASE58} `)).toBe(
      TRON_USDT_HEX
    )
  })

  it('accepts an already-hex address on a Tron network', () => {
    expect(
      normalizeAddressForNetwork(
        'tron',
        '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'
      )
    ).toBe(TRON_USDT_HEX)
  })

  it.each(['', '   ', '\t\n'])('rejects an empty address %j', (raw) => {
    expect(() => normalizeAddressForNetwork('mainnet', raw)).toThrow(
      'Address string is empty'
    )
  })

  it('rejects a base58 address on a non-Tron network', () => {
    expect(() =>
      normalizeAddressForNetwork('mainnet', TRON_USDT_BASE58)
    ).toThrow(/is invalid/)
  })

  it('rejects a base58 address with a bad checksum on Tron', () => {
    expect(() =>
      normalizeAddressForNetwork('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6x')
    ).toThrow('Invalid address provided')
  })

  it('rejects a malformed hex address', () => {
    expect(() => normalizeAddressForNetwork('mainnet', '0x1234')).toThrow(
      /is invalid/
    )
  })
})
