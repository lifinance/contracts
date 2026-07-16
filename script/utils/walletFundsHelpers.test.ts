/**
 * Unit tests for the decision logic behind `manage-wallet-funds`. These cover the
 * parts that decide whether a fund movement is allowed — wallet resolution, the
 * same-wallet gate, value-loss enforcement, and the chain-support guard — so a
 * regression there fails here rather than on-chain. Network IO is not exercised.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  assertKeyMatchesRole,
  assertSameWallet,
  assertSlippage,
  assertWithinSlippage,
  chainUsesErc20Gas,
  computeValueLossPct,
  flattenWalletKeys,
  isChainSupported,
  normalizeTokenArg,
  parseAmount,
  recordedAddressForRole,
  resolveAmountSelection,
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

describe('assertSlippage', () => {
  it('accepts values within 0..100', () => {
    expect(() => assertSlippage(3)).not.toThrow()
    expect(() => assertSlippage(0)).not.toThrow()
  })
  it('rejects NaN (which would silently pass the loss check)', () => {
    expect(() => assertSlippage(NaN)).toThrow(/max-slippage/i)
  })
  it('rejects negative and out-of-range values', () => {
    expect(() => assertSlippage(-1)).toThrow()
    expect(() => assertSlippage(101)).toThrow()
  })
})

describe('resolveAmountSelection', () => {
  it('returns null for amount mode', () => {
    expect(resolveAmountSelection('0.5', undefined)).toBeNull()
  })
  it('returns the validated percent for percent mode', () => {
    expect(resolveAmountSelection(undefined, '25')).toBe(25)
  })
  it('rejects both modes at once', () => {
    expect(() => resolveAmountSelection('0.5', '25')).toThrow(/exactly one/i)
  })
  it('rejects neither mode', () => {
    expect(() => resolveAmountSelection(undefined, undefined)).toThrow(
      /exactly one/i
    )
  })
  it('rejects out-of-range or non-numeric percent', () => {
    expect(() => resolveAmountSelection(undefined, '0')).toThrow()
    expect(() => resolveAmountSelection(undefined, '150')).toThrow()
    expect(() => resolveAmountSelection(undefined, 'abc')).toThrow()
  })
})

describe('chainUsesErc20Gas', () => {
  it('false for a normal native-gas chain', () => {
    expect(
      chainUsesErc20Gas({ nativeCurrency: 'BNB', nativeAddress: '' })
    ).toBe(false)
    expect(chainUsesErc20Gas({ nativeCurrency: 'ETH' })).toBe(false)
    expect(
      chainUsesErc20Gas({
        nativeCurrency: 'ETH',
        nativeAddress: '0x0000000000000000000000000000000000000000',
      })
    ).toBe(false)
    expect(chainUsesErc20Gas({ nativeAddress: NATIVE_SENTINEL })).toBe(false)
  })
  it('true for an ERC-20 gas-token predeploy (arc-style)', () => {
    expect(
      chainUsesErc20Gas({
        nativeCurrency: 'USDC',
        nativeAddress: '0x3600000000000000000000000000000000000000',
        feeTokenAddress: null,
      })
    ).toBe(true)
  })
  it('true for the tempo "no native currency" model (0x0 native + feeTokenAddress)', () => {
    expect(
      chainUsesErc20Gas({
        nativeCurrency: 'N/A',
        nativeAddress: '0x0000000000000000000000000000000000000000',
        feeTokenAddress: '0x20c0000000000000000000000000000000000000',
      })
    ).toBe(true)
  })
  it('true when only nativeCurrency signals no native asset', () => {
    expect(chainUsesErc20Gas({ nativeCurrency: 'n/a' })).toBe(true)
  })
})

const GLOBAL_CONFIG_FIXTURE: Record<string, unknown> = {
  refundWallet: A,
  devWallet: B,
  backendSigner: {
    staging: '0x981CCF8c09633F6F2AF3fe661C285ca1DB09caE1',
    production: '0xAF4B7A83591a6c4c8B9d1341C3F08BBc3b800fc5',
  },
  walletKeys: { devWallet: 'PRIVATE_KEY' }, // non-address string, must be ignored
}

describe('recordedAddressForRole', () => {
  it('resolves a direct top-level role', () => {
    expect(recordedAddressForRole('refundWallet', GLOBAL_CONFIG_FIXTURE)).toBe(
      A
    )
  })
  it('resolves a flattened nested role (backendSignerProduction → backendSigner.production)', () => {
    expect(
      recordedAddressForRole('backendSignerProduction', GLOBAL_CONFIG_FIXTURE)
    ).toBe('0xAF4B7A83591a6c4c8B9d1341C3F08BBc3b800fc5')
  })
  it('returns undefined for an unknown role', () => {
    expect(
      recordedAddressForRole('mysteryWallet', GLOBAL_CONFIG_FIXTURE)
    ).toBeUndefined()
  })
  it('ignores non-address values (e.g. a nested env-var name)', () => {
    expect(
      recordedAddressForRole('walletKeysDevWallet', GLOBAL_CONFIG_FIXTURE)
    ).toBeUndefined()
  })
})

describe('assertKeyMatchesRole', () => {
  it('passes when the derived address matches the recorded one (any casing)', () => {
    expect(() =>
      assertKeyMatchesRole(
        'refundWallet',
        A.toLowerCase() as `0x${string}`,
        GLOBAL_CONFIG_FIXTURE
      )
    ).not.toThrow()
  })
  it('throws when the derived address differs from the recorded one', () => {
    expect(() =>
      assertKeyMatchesRole('refundWallet', B, GLOBAL_CONFIG_FIXTURE)
    ).toThrow(/Refusing to proceed/i)
  })
  it('passes for a role with no recorded address (scratch key — nothing to check)', () => {
    expect(() =>
      assertKeyMatchesRole('mysteryWallet', A, GLOBAL_CONFIG_FIXTURE)
    ).not.toThrow()
  })
  it('validates the nested-role path', () => {
    expect(() =>
      assertKeyMatchesRole('backendSignerProduction', A, GLOBAL_CONFIG_FIXTURE)
    ).toThrow(/Refusing to proceed/i)
  })
})
