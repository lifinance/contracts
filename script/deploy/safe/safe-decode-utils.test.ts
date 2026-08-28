/**
 * Tests for role-name resolution and role-change display in safe-decode-utils.
 * Covers getRoleName (hash -> OZ AccessControl role name), formatRoleChange
 * (the grantRole / revokeRole / renounceRole display path) and the selector
 * resolution behind formatBatchSetContractSelectorWhitelist.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  describe,
  expect,
  it,
  afterEach,
  beforeEach,
  spyOn,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'
import { toFunctionSelector } from 'viem'

import {
  getRoleName,
  formatRoleChange,
  formatBatchSetContractSelectorWhitelist,
} from './safe-decode-utils'

const DEFAULT_ADMIN_ROLE = `0x${'00'.repeat(32)}`
// OpenZeppelin AccessControl role hashes (public, keccak256 of role names) —
// not private keys, despite matching the 64-hex-char shape.
const CANCELLER_ROLE =
  '0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783' // pre-commit-checker: not a secret
const PROPOSER_ROLE =
  '0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1' // pre-commit-checker: not a secret
const EXECUTOR_ROLE =
  '0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63' // pre-commit-checker: not a secret
const TIMELOCK_ADMIN_ROLE =
  '0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5' // pre-commit-checker: not a secret

describe('getRoleName', () => {
  it('resolves known OpenZeppelin role hashes', () => {
    expect(getRoleName(CANCELLER_ROLE)).toBe('CANCELLER_ROLE')
    expect(getRoleName(PROPOSER_ROLE)).toBe('PROPOSER_ROLE')
    expect(getRoleName(EXECUTOR_ROLE)).toBe('EXECUTOR_ROLE')
    expect(getRoleName(TIMELOCK_ADMIN_ROLE)).toBe('TIMELOCK_ADMIN_ROLE')
  })

  it('resolves DEFAULT_ADMIN_ROLE (bytes32 zero, not a keccak hash)', () => {
    expect(getRoleName(DEFAULT_ADMIN_ROLE)).toBe('DEFAULT_ADMIN_ROLE')
  })

  it('is case-insensitive on the hex digits', () => {
    const upperHex = `0x${CANCELLER_ROLE.slice(2).toUpperCase()}`
    expect(getRoleName(upperHex)).toBe('CANCELLER_ROLE')
  })

  it('accepts a hash without the 0x prefix', () => {
    expect(getRoleName(CANCELLER_ROLE.slice(2))).toBe('CANCELLER_ROLE')
  })

  it('returns empty string for an unknown role hash', () => {
    expect(getRoleName(`0x${'11'.repeat(32)}`)).toBe('')
  })
})

describe('formatRoleChange', () => {
  afterEach(() => {
    spyOn(consola, 'info').mockRestore()
  })

  // Output is ANSI-colored, but the function name and the "(ROLE_NAME)" label
  // are each emitted as contiguous substrings, so we assert on the raw joined
  // output without stripping escape codes.
  const capture = async (
    functionName: string,
    role: string,
    account: string
  ): Promise<string> => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatRoleChange(functionName, [role, account], 'mainnet')
    return infoSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  const account = '0xb05E63458A51731Aad26BdcD6E12246330E6095F'
  const ROLE_LABEL = /\([A-Z_]+_ROLE\)/

  it('labels the role on revokeRole (the previously unlabeled path)', async () => {
    const output = await capture('revokeRole', CANCELLER_ROLE, account)
    expect(output).toContain('Function:')
    expect(output).toContain('revokeRole')
    expect(output).toContain(CANCELLER_ROLE)
    expect(output).toContain('(CANCELLER_ROLE)')
  })

  it('labels the role on renounceRole', async () => {
    const output = await capture('renounceRole', PROPOSER_ROLE, account)
    expect(output).toContain('renounceRole')
    expect(output).toContain('(PROPOSER_ROLE)')
  })

  it('still labels the role on grantRole', async () => {
    const output = await capture('grantRole', CANCELLER_ROLE, account)
    expect(output).toContain('grantRole')
    expect(output).toContain('(CANCELLER_ROLE)')
  })

  it('omits the role label for an unknown role hash', async () => {
    const unknown = `0x${'11'.repeat(32)}`
    const output = await capture('revokeRole', unknown, account)
    expect(output).toContain('revokeRole')
    expect(output).toContain(unknown)
    expect(output).not.toMatch(ROLE_LABEL)
  })

  it('returns without logging when args are incomplete', async () => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatRoleChange('revokeRole', [CANCELLER_ROLE], 'mainnet')
    expect(infoSpy).not.toHaveBeenCalled()
  })
})

describe('decodeTransactionData', () => {
  it('resolves Timelock scheduleBatch from the local registry without any network call', async () => {
    const { decodeTransactionData } = await import('./safe-decode-utils')
    const originalFetch = globalThis.fetch
    // Any network access must not happen for locally-known selectors
    globalThis.fetch = (() => {
      throw new Error('network disabled in test')
    }) as unknown as typeof fetch
    try {
      const result = await decodeTransactionData('0x8f2a0bb0')
      expect(result.functionName).toBe(
        'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
describe('formatBatchSetContractSelectorWhitelist', () => {
  // Addresses absent from config/whitelist.json, so every selector below takes
  // the fallback path the whitelist lookup alone cannot answer.
  const CONTRACT = '0xEe80aaE1e39b1d25b9FC99c8edF02bCd81f9eA30'
  // Deliberately absent from every local source, so only the 4byte lookup
  // can name it.
  const FALLBACK_ONLY_SIGNATURE = 'fallbackOnlyProbe(uint256,address)'
  const FALLBACK_ONLY = toFunctionSelector(FALLBACK_ONLY_SIGNATURE)
  const TRANSFER = toFunctionSelector('transfer(address,uint256)')
  const UNKNOWN_SELECTOR = '0xdeadbeef'

  let cacheDir: string
  let originalCachePath: string | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-cache-'))
    originalCachePath = process.env.SELECTOR_SIGNATURE_CACHE_PATH
    process.env.SELECTOR_SIGNATURE_CACHE_PATH = path.join(
      cacheDir,
      'selector-signatures.json'
    )
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalCachePath === undefined)
      delete process.env.SELECTOR_SIGNATURE_CACHE_PATH
    else process.env.SELECTOR_SIGNATURE_CACHE_PATH = originalCachePath
    fs.rmSync(cacheDir, { recursive: true, force: true })
    spyOn(consola, 'info').mockRestore()
  })

  const stubFourByte = (signatures: Record<string, string>): (() => number) => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      const fnResults: Record<string, { name: string }[]> = {}
      for (const [selector, name] of Object.entries(signatures))
        fnResults[selector.toLowerCase()] = [{ name }]
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ ok: true, result: { function: fnResults } }),
      })
    }) as unknown as typeof fetch
    return () => calls
  }

  const capture = async (selectors: string[]): Promise<string> => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatBatchSetContractSelectorWhitelist(
      [selectors.map(() => CONTRACT), selectors, false],
      'mainnet'
    )
    return infoSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  it('keeps case-variant base58 contracts in separate groups', async () => {
    // Base58 is case-sensitive, so these are two different Tron contracts.
    const tronA = 'TQ2Fh2FLdWkhCPMTGKBHGNhCzWNwLoxdYY'
    const tronB = 'TQ2fh2fLdWkhCPMTGKBHGNhCzWNwLoxdYY'
    stubFourByte({ [FALLBACK_ONLY]: FALLBACK_ONLY_SIGNATURE })
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatBatchSetContractSelectorWhitelist(
      [[tronA, tronB], [FALLBACK_ONLY, TRANSFER], false],
      'tron'
    )
    const output = infoSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain(tronA)
    expect(output).toContain(tronB)
    // One "Contract:" line per address — a merged group would print only one.
    expect(output.match(/Contract:/g)?.length).toBe(2)
  })

  it('resolves a selector missing from whitelist.json via the 4byte lookup', async () => {
    stubFourByte({
      [FALLBACK_ONLY]: FALLBACK_ONLY_SIGNATURE,
    })
    const output = await capture([FALLBACK_ONLY])
    expect(output).toContain(FALLBACK_ONLY_SIGNATURE)
    expect(output).toContain('via 4byte.sourcify.dev')
    expect(output).not.toContain('signature unknown')
  })

  it('prefers the local registry and never calls 4byte for a locally-known selector', async () => {
    const callCount = stubFourByte({})
    const output = await capture([TRANSFER])
    expect(output).toContain('transfer(address,uint256)')
    expect(output).toContain('via well-known')
    expect(callCount()).toBe(0)
  })

  it('batches every unresolved selector of the call into one request', async () => {
    const callCount = stubFourByte({
      [FALLBACK_ONLY]: FALLBACK_ONLY_SIGNATURE,
    })
    await capture([FALLBACK_ONLY, TRANSFER, UNKNOWN_SELECTOR])
    expect(callCount()).toBe(1)
  })

  it('reports a selector no source can resolve as unknown', async () => {
    stubFourByte({})
    const output = await capture([UNKNOWN_SELECTOR])
    expect(output).toContain(UNKNOWN_SELECTOR)
    expect(output).toContain('signature unknown')
  })

  it('drops a 4byte signature that does not hash back to its selector', async () => {
    stubFourByte({ [FALLBACK_ONLY]: 'transfer(address,uint256)' })
    const output = await capture([FALLBACK_ONLY])
    expect(output).toContain('signature unknown')
    expect(output).not.toContain('transfer(address,uint256)')
  })
})
