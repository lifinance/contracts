/**
 * Unit tests for the decision logic behind `manage-wallet-funds`. These cover the
 * parts that decide whether a fund movement is allowed — wallet resolution, the
 * same-wallet gate, value-loss enforcement, and the chain-support guard — so a
 * regression there fails here rather than on-chain. Network IO is not exercised.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  assertSameWallet,
  assertWithinSlippage,
  computeValueLossPct,
  flattenWalletKeys,
  isChainSupported,
  normalizeTokenArg,
  parseAmount,
  resolveEnvKeyForRole,
  scanEnvForPrivateKeyVars,
  NATIVE_SENTINEL,
  type IWalletKeysConfig,
} from './walletFundsHelpers'

const WALLET_KEYS: IWalletKeysConfig = {
  refundWallet: 'PRIVATE_KEY_REFUND_WALLET',
  devWallet: 'PRIVATE_KEY',
  deployerWallet: 'PRIVATE_KEY_PRODUCTION',
  backendSigner: {
    staging: 'PRIVATE_KEY_BACKEND_SIGNER_STAGING',
    production: 'PRIVATE_KEY_BACKEND_SIGNER_PRODUCTION',
  },
}

const A = '0x156CeBba59DEB2cB23742F70dCb0a11cC775591F' as const
const B = '0x08647cc950813966142A416D40C382e2c5DB73bB' as const

describe('flattenWalletKeys', () => {
  it('flattens nested groups into single role names', () => {
    const flat = flattenWalletKeys(WALLET_KEYS)
    expect(flat.devWallet).toBe('PRIVATE_KEY')
    expect(flat.backendSignerStaging).toBe('PRIVATE_KEY_BACKEND_SIGNER_STAGING')
    expect(flat.backendSignerProduction).toBe(
      'PRIVATE_KEY_BACKEND_SIGNER_PRODUCTION'
    )
  })
})

describe('resolveEnvKeyForRole', () => {
  it('resolves a known role', () => {
    expect(resolveEnvKeyForRole('refundWallet', WALLET_KEYS)).toBe(
      'PRIVATE_KEY_REFUND_WALLET'
    )
  })
  it('is case-insensitive', () => {
    expect(resolveEnvKeyForRole('DEVWALLET', WALLET_KEYS)).toBe('PRIVATE_KEY')
  })
  it('resolves flattened nested roles', () => {
    expect(resolveEnvKeyForRole('backendSignerProduction', WALLET_KEYS)).toBe(
      'PRIVATE_KEY_BACKEND_SIGNER_PRODUCTION'
    )
  })
  it('returns undefined for an unknown role', () => {
    expect(resolveEnvKeyForRole('mysteryWallet', WALLET_KEYS)).toBeUndefined()
  })
})

describe('scanEnvForPrivateKeyVars', () => {
  it('finds prefix and suffix key shapes, skips MNEMONIC and anvil and empties', () => {
    const found = scanEnvForPrivateKeyVars({
      PRIVATE_KEY: '0xabc',
      PRIVATE_KEY_REFUND_WALLET: '0xdef',
      SIGNER_PRIVATE_KEY: '0x123',
      DEPLOYER_PK: '0x456',
      MNEMONIC: 'word word',
      PRIVATE_KEY_ANVIL: '0x999',
      PRIVATE_KEY_EMPTY: '',
      ETH_NODE_URI_BSC: 'https://x',
    })
    expect(found).toEqual([
      'DEPLOYER_PK',
      'PRIVATE_KEY',
      'PRIVATE_KEY_REFUND_WALLET',
      'SIGNER_PRIVATE_KEY',
    ])
  })
})

describe('assertSameWallet', () => {
  it('passes when addresses match (any checksum casing)', () => {
    expect(() =>
      assertSameWallet(A, A.toLowerCase() as `0x${string}`)
    ).not.toThrow()
  })
  it('throws when addresses differ', () => {
    expect(() => assertSameWallet(A, B)).toThrow(/same-wallet gate/i)
  })
})

describe('computeValueLossPct', () => {
  it('computes percentage loss', () => {
    expect(computeValueLossPct('100', '97')).toBeCloseTo(3)
  })
  it('returns undefined without valid pricing', () => {
    expect(computeValueLossPct(undefined, '97')).toBeUndefined()
    expect(computeValueLossPct('0', '0')).toBeUndefined()
  })
})

describe('assertWithinSlippage', () => {
  it('passes within the cap', () => {
    expect(assertWithinSlippage('100', '98', 3).lossPct).toBeCloseTo(2)
  })
  it('throws over the cap', () => {
    expect(() => assertWithinSlippage('100', '90', 3)).toThrow(/exceeds/i)
  })
  it('refuses an unpriced route rather than broadcasting blind', () => {
    expect(() => assertWithinSlippage(undefined, undefined, 3)).toThrow(
      /no USD pricing/i
    )
  })
})

describe('isChainSupported', () => {
  const chains = [{ id: 1 }, { id: 56 }, { id: 8453 }]
  it('true for a listed chain', () => {
    expect(isChainSupported(56, chains)).toBe(true)
  })
  it('false for an unlisted (mid-add) chain', () => {
    expect(isChainSupported(999999, chains)).toBe(false)
  })
})

describe('parseAmount', () => {
  it('parses to base units', () => {
    expect(parseAmount('0.01', 18)).toBe(10000000000000000n)
    expect(parseAmount('50', 6)).toBe(50000000n)
  })
})

describe('normalizeTokenArg', () => {
  it('maps native to the sentinel', () => {
    expect(normalizeTokenArg('native')).toBe(NATIVE_SENTINEL)
  })
  it('checksums a raw address', () => {
    expect(normalizeTokenArg(A.toLowerCase())).toBe(A)
  })
  it('flags a symbol for API resolution', () => {
    expect(normalizeTokenArg('USDC')).toBe('SYMBOL')
  })
})
