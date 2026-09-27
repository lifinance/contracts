import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { normalizeAddressForNetwork } from './normalizeAddressStringForViem'

// Tron USDT: the same 20-byte identity in both encodings.
const TRON_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_AS_EVM = '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C'

const EVM_LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const EVM_CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

describe('normalizeAddressForNetwork', () => {
  it('checksums a lowercase hex address on an EVM network', () => {
    expect(normalizeAddressForNetwork('mainnet', EVM_LOWER)).toBe(
      EVM_CHECKSUMMED
    )
  })

  it('returns an already-checksummed address unchanged', () => {
    expect(normalizeAddressForNetwork('arbitrum', EVM_CHECKSUMMED)).toBe(
      EVM_CHECKSUMMED
    )
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeAddressForNetwork('base', `  ${EVM_LOWER}\n`)).toBe(
      EVM_CHECKSUMMED
    )
  })

  it('converts a Tron base58 address to checksummed hex', () => {
    expect(normalizeAddressForNetwork('tron', TRON_BASE58)).toBe(TRON_AS_EVM)
  })

  it('treats tronshasta as a Tron network', () => {
    expect(normalizeAddressForNetwork('tronshasta', TRON_BASE58)).toBe(
      TRON_AS_EVM
    )
  })

  it('matches the Tron network key case-insensitively', () => {
    expect(normalizeAddressForNetwork('TRON', TRON_BASE58)).toBe(TRON_AS_EVM)
  })

  it('trims a Tron base58 address before converting', () => {
    expect(normalizeAddressForNetwork('tron', ` ${TRON_BASE58} `)).toBe(
      TRON_AS_EVM
    )
  })

  it('passes a hex address through getAddress on a Tron network', () => {
    expect(normalizeAddressForNetwork('tron', TRON_AS_EVM.toLowerCase())).toBe(
      TRON_AS_EVM
    )
  })

  it('throws on an empty address', () => {
    expect(() => normalizeAddressForNetwork('mainnet', '')).toThrow(
      'Address string is empty'
    )
  })

  it('throws on a whitespace-only address', () => {
    expect(() => normalizeAddressForNetwork('tron', '   ')).toThrow(
      'Address string is empty'
    )
  })

  it('throws on a nullish address', () => {
    expect(() =>
      normalizeAddressForNetwork('mainnet', undefined as unknown as string)
    ).toThrow('Address string is empty')
  })

  it('rejects a Tron base58 address on a non-Tron network', () => {
    expect(() => normalizeAddressForNetwork('mainnet', TRON_BASE58)).toThrow()
  })

  it('rejects malformed hex on an EVM network', () => {
    expect(() => normalizeAddressForNetwork('mainnet', '0x1234')).toThrow()
  })

  // viem's getAddress re-derives the checksum instead of validating it.
  it('re-checksums a mixed-case address with a wrong checksum', () => {
    const badChecksum = EVM_CHECKSUMMED.replace('dA6', 'Da6')
    expect(normalizeAddressForNetwork('mainnet', badChecksum)).toBe(
      EVM_CHECKSUMMED
    )
  })

  it('rejects a non-hex string on an EVM network', () => {
    expect(() =>
      normalizeAddressForNetwork('mainnet', 'not-an-address')
    ).toThrow()
  })
})
