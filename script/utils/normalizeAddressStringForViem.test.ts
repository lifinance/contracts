/**
 * Unit tests for `normalizeAddressForNetwork`.
 * Run these when changing how config or Mongo addresses become viem addresses.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normalizeAddressForNetwork } from './normalizeAddressStringForViem'

/** EIP-55 example from the checksum spec. */
const EIP55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const EIP55_LOWER = EIP55.toLowerCase()

/** USDT on Tron; the 0x form is the same 20 bytes, checksummed. */
const USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_HEX = '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C'

/** TVM zero address in base58. */
const TRON_ZERO_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

describe('normalizeAddressForNetwork', () => {
  describe('EVM networks', () => {
    it('checksums a lowercase hex address', () => {
      expect(normalizeAddressForNetwork('mainnet', EIP55_LOWER)).toBe(EIP55)
    })

    it('keeps a correctly checksummed address', () => {
      expect(normalizeAddressForNetwork('polygon', EIP55)).toBe(EIP55)
    })

    it('trims whitespace before checksumming', () => {
      expect(normalizeAddressForNetwork('arbitrum', `  ${EIP55_LOWER}\n`)).toBe(
        EIP55
      )
    })

    it('rewrites a mismatched checksum to the canonical form', () => {
      const mismatched = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
      expect(normalizeAddressForNetwork('mainnet', mismatched)).toBe(EIP55)
    })
  })

  describe('Tron networks', () => {
    it('converts a base58 address to checksummed hex', () => {
      expect(normalizeAddressForNetwork('tron', USDT_BASE58)).toBe(USDT_HEX)
    })

    it('checksums that same address when it is already 0x hex', () => {
      expect(normalizeAddressForNetwork('tron', USDT_HEX.toLowerCase())).toBe(
        USDT_HEX
      )
    })

    it('treats the network key case-insensitively', () => {
      expect(normalizeAddressForNetwork('TRON', USDT_BASE58)).toBe(USDT_HEX)
    })

    it('converts base58 on tronshasta', () => {
      expect(normalizeAddressForNetwork('TronShasta', ` ${USDT_BASE58} `)).toBe(
        USDT_HEX
      )
    })

    it('maps the Tron zero address to the EVM zero address', () => {
      expect(normalizeAddressForNetwork('tron', TRON_ZERO_BASE58)).toBe(
        ZERO_ADDRESS
      )
    })
  })

  describe('rejections', () => {
    it('rejects an empty address string', () => {
      expect(() => normalizeAddressForNetwork('mainnet', '')).toThrow(
        'Address string is empty'
      )
    })

    it('rejects an address that is only whitespace', () => {
      expect(() => normalizeAddressForNetwork('tron', '   ')).toThrow(
        'Address string is empty'
      )
    })

    it('rejects a missing address', () => {
      const missing = undefined as unknown as string
      expect(() => normalizeAddressForNetwork('mainnet', missing)).toThrow(
        'Address string is empty'
      )
    })

    it('rejects a base58 address on a non-Tron network', () => {
      expect(() => normalizeAddressForNetwork('mainnet', USDT_BASE58)).toThrow(
        /is invalid/
      )
    })

    it('rejects a hex address that is not 20 bytes', () => {
      expect(() => normalizeAddressForNetwork('mainnet', '0x123')).toThrow(
        /is invalid/
      )
    })

    it('rejects a base58 string that is not a Tron address', () => {
      expect(() =>
        normalizeAddressForNetwork('tron', 'TNotARealAddress')
      ).toThrow(/Non-base58/)
    })

    it('rejects Tron hex that still carries the 41 prefix', () => {
      expect(() =>
        normalizeAddressForNetwork(
          'tron',
          '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'
        )
      ).toThrow(/is invalid/)
    })
  })
})
