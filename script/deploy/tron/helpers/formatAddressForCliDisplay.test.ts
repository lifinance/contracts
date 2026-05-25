/**
 * Tests for the Tron CLI address display helpers.
 *
 * Covers `formatAddressForNetworkCliDisplay` (hex/41/base58 → base58 for Tron,
 * pass-through otherwise) and `tronHexSuffix` (the ` (0x…)` companion suffix
 * for showing the EVM-style hex alongside Tron base58 in CLI output).
 */
// eslint-disable-next-line import/no-unresolved
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import {
  formatAddressForNetworkCliDisplay,
  tronHexSuffix,
} from './formatAddressForCliDisplay'

// TronWeb's codec only needs a fullHost string; no network calls happen for
// address codec ops, so any URL works for unit tests.
const originalRpc = process.env.ETH_NODE_URI_TRON

// Mainnet deployer wallet from config/global.json: stable EVM↔base58 pair.
const EVM_DEPLOYER = '0xb137683965ADC470f140df1a1D05B0D25C14E269'
const EVM_DEPLOYER_LOWER = EVM_DEPLOYER.toLowerCase()
const B58_DEPLOYER = 'TS8EymUNucdNwseZMcLZRzTLy7Yz768yeD'
const TRON_41_DEPLOYER = '41b137683965adc470f140df1a1d05b0d25c14e269'

beforeAll(() => {
  process.env.ETH_NODE_URI_TRON =
    process.env.ETH_NODE_URI_TRON ?? 'http://localhost'
})

afterAll(() => {
  if (originalRpc === undefined) delete process.env.ETH_NODE_URI_TRON
  else process.env.ETH_NODE_URI_TRON = originalRpc
})

describe('formatAddressForNetworkCliDisplay', () => {
  it('passes through unchanged for non-Tron networks', () => {
    expect(formatAddressForNetworkCliDisplay('mainnet', EVM_DEPLOYER)).toBe(
      EVM_DEPLOYER
    )
  })

  it('returns base58 untouched on Tron', () => {
    expect(formatAddressForNetworkCliDisplay('tron', B58_DEPLOYER)).toBe(
      B58_DEPLOYER
    )
  })

  it('converts 0x hex to base58 on Tron', () => {
    expect(formatAddressForNetworkCliDisplay('tron', EVM_DEPLOYER)).toBe(
      B58_DEPLOYER
    )
  })

  it('converts lowercase 0x hex to base58 on Tron', () => {
    expect(formatAddressForNetworkCliDisplay('tron', EVM_DEPLOYER_LOWER)).toBe(
      B58_DEPLOYER
    )
  })

  it('converts 41-prefixed hex to base58 on Tron', () => {
    expect(formatAddressForNetworkCliDisplay('tron', TRON_41_DEPLOYER)).toBe(
      B58_DEPLOYER
    )
  })

  it('returns input unchanged when value is not a recognizable address', () => {
    expect(formatAddressForNetworkCliDisplay('tron', 'not-an-address')).toBe(
      'not-an-address'
    )
  })

  it('is case-insensitive for the network key', () => {
    expect(formatAddressForNetworkCliDisplay('TRON', EVM_DEPLOYER)).toBe(
      B58_DEPLOYER
    )
  })
})

describe('tronHexSuffix', () => {
  it('returns empty string for non-Tron networks', () => {
    expect(tronHexSuffix('mainnet', EVM_DEPLOYER)).toBe('')
    expect(tronHexSuffix('mainnet', B58_DEPLOYER)).toBe('')
  })

  it('returns checksummed hex in parens for a base58 Tron address', () => {
    expect(tronHexSuffix('tron', B58_DEPLOYER)).toBe(` (${EVM_DEPLOYER})`)
  })

  it('returns checksummed hex in parens for a 0x EVM-style address on Tron', () => {
    expect(tronHexSuffix('tron', EVM_DEPLOYER_LOWER)).toBe(` (${EVM_DEPLOYER})`)
  })

  it('returns checksummed hex in parens for a 41-prefixed Tron hex', () => {
    expect(tronHexSuffix('tron', TRON_41_DEPLOYER)).toBe(` (${EVM_DEPLOYER})`)
  })

  it('returns empty string for unrecognizable input on Tron', () => {
    expect(tronHexSuffix('tron', 'not-an-address')).toBe('')
  })

  it('returns empty string when checksum conversion throws', () => {
    // Too-short 0x string fails getAddress() — exercises the catch branch.
    expect(tronHexSuffix('tron', '0xdeadbeef')).toBe('')
  })

  it('is case-insensitive for the network key', () => {
    expect(tronHexSuffix('TRON', B58_DEPLOYER)).toBe(` (${EVM_DEPLOYER})`)
  })
})
