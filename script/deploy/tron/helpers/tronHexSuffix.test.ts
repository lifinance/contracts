/**
 * Tests for `tronHexSuffix` — the ` (0x…)` companion suffix that
 * confirm-safe-tx / safe-decode-utils append next to Tron base58 addresses.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { tronHexSuffix } from './tronHexSuffix'

// Mainnet deployer wallet from config/global.json: stable EVM↔base58 pair.
const EVM_DEPLOYER = '0xb137683965ADC470f140df1a1D05B0D25C14E269'
const EVM_DEPLOYER_LOWER = EVM_DEPLOYER.toLowerCase()

describe('tronHexSuffix', () => {
  it('returns empty string for non-Tron networks', () => {
    expect(tronHexSuffix('mainnet', EVM_DEPLOYER)).toBe('')
  })

  it('returns checksummed hex in parens for a 0x EVM-style address on Tron', () => {
    expect(tronHexSuffix('tron', EVM_DEPLOYER_LOWER)).toBe(` (${EVM_DEPLOYER})`)
  })

  it('returns checksummed hex unchanged when input is already checksummed', () => {
    expect(tronHexSuffix('tron', EVM_DEPLOYER)).toBe(` (${EVM_DEPLOYER})`)
  })

  it('returns empty string when getAddress throws (too-short hex)', () => {
    expect(tronHexSuffix('tron', '0xdeadbeef')).toBe('')
  })

  it('returns empty string for unrecognizable input on Tron', () => {
    expect(tronHexSuffix('tron', 'not-an-address')).toBe('')
  })

  it('is case-insensitive for the network key', () => {
    expect(tronHexSuffix('TRON', EVM_DEPLOYER)).toBe(` (${EVM_DEPLOYER})`)
  })
})
