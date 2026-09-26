import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normalizeAddressForNetwork } from './normalizeAddressStringForViem'

const TRON_USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_USDT_HEX = '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C'
const EVM_CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

describe('normalizeAddressForNetwork', () => {
  describe('EVM networks', () => {
    it('checksums a lowercase hex address', () => {
      expect(
        normalizeAddressForNetwork('mainnet', EVM_CHECKSUMMED.toLowerCase())
      ).toBe(EVM_CHECKSUMMED)
    })

    it('returns an already checksummed address unchanged', () => {
      expect(normalizeAddressForNetwork('arbitrum', EVM_CHECKSUMMED)).toBe(
        EVM_CHECKSUMMED
      )
    })

    it('trims surrounding whitespace', () => {
      expect(normalizeAddressForNetwork('base', `  ${EVM_CHECKSUMMED}\n`)).toBe(
        EVM_CHECKSUMMED
      )
    })

    it('rejects a Tron base58 address on a non-Tron network', () => {
      expect(() =>
        normalizeAddressForNetwork('mainnet', TRON_USDT_BASE58)
      ).toThrow()
    })

    it('rejects malformed hex', () => {
      expect(() => normalizeAddressForNetwork('mainnet', '0x1234')).toThrow()
    })

    // viem's getAddress recomputes the checksum instead of validating it.
    it('re-checksums a mixed-case address with a wrong checksum', () => {
      const badChecksum = EVM_CHECKSUMMED.replace('dA6', 'Da6')
      expect(normalizeAddressForNetwork('mainnet', badChecksum)).toBe(
        EVM_CHECKSUMMED
      )
    })
  })

  describe('Tron networks', () => {
    it('converts base58 to the checksummed hex of the same 20 bytes', () => {
      expect(normalizeAddressForNetwork('tron', TRON_USDT_BASE58)).toBe(
        TRON_USDT_HEX
      )
    })

    it('treats the network key case-insensitively', () => {
      expect(normalizeAddressForNetwork('TRON', TRON_USDT_BASE58)).toBe(
        TRON_USDT_HEX
      )
    })

    it('handles the tronshasta testnet key', () => {
      expect(normalizeAddressForNetwork('tronshasta', TRON_USDT_BASE58)).toBe(
        TRON_USDT_HEX
      )
    })

    it('trims whitespace before decoding base58', () => {
      expect(normalizeAddressForNetwork('tron', ` ${TRON_USDT_BASE58} `)).toBe(
        TRON_USDT_HEX
      )
    })

    it('passes a 0x hex address through getAddress', () => {
      expect(
        normalizeAddressForNetwork('tron', TRON_USDT_HEX.toLowerCase())
      ).toBe(TRON_USDT_HEX)
    })

    it('rejects a base58 string with a bad checksum', () => {
      const corrupted = `${TRON_USDT_BASE58.slice(0, -1)}u`
      expect(() => normalizeAddressForNetwork('tron', corrupted)).toThrow()
    })
  })

  describe('empty input', () => {
    it.each(['', '   ', '\n\t'])('rejects %p', (raw) => {
      expect(() => normalizeAddressForNetwork('mainnet', raw)).toThrow(
        'Address string is empty'
      )
    })

    it('rejects undefined at runtime', () => {
      expect(() =>
        normalizeAddressForNetwork('tron', undefined as unknown as string)
      ).toThrow('Address string is empty')
    })
  })
})
