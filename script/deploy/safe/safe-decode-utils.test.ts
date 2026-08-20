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

import composerWhitelistJson from '../../../config/composerWhitelist.json'
import whitelistJson from '../../../config/whitelist.json'
import mainnetDeployments from '../../../deployments/mainnet.json'
import tronDeployments from '../../../deployments/tron.json'
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'

import {
  getRoleName,
  formatRoleChange,
  formatBatchSetContractSelectorWhitelist,
  formatWhitelistDeployLogCheck,
} from './safe-decode-utils'

/** Fails the test loudly rather than silently skipping when repo data moves. */
const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`test fixture missing: ${what}`)
  return value
}

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

describe('formatWhitelistDeployLogCheck', () => {
  // The decision table is exercised through explicit inputs, so these are
  // deliberately role-neutral: which address is live and which is superseded is
  // whatever the arguments of a given case say it is.
  const NETWORK = 'mainnet'
  const ADDRESS_A = '0xC748171a028401BfD0c0F0a757ab4A1F93b00576'
  const ADDRESS_B = '0x5Bf8351f8C349634911965Bd000fE9c625C1A0d9'

  const check = (
    overrides: Partial<Parameters<typeof formatWhitelistDeployLogCheck>[0]>
  ): string =>
    formatWhitelistDeployLogCheck({
      network: NETWORK,
      contractAddress: ADDRESS_A,
      whitelisted: true,
      ...overrides,
    })

  it('confirms an added pair whose address is the current deployment', () => {
    const output = check({
      peripheryName: 'FeeForwarder',
      registeredAddress: ADDRESS_A,
      deployLogName: 'FeeForwarder',
    })
    expect(output).toContain('✅ matches deployments')
  })

  it('flags an added pair the deploy log disagrees with', () => {
    const output = check({
      contractAddress: ADDRESS_B,
      peripheryName: 'FeeForwarder',
      registeredAddress: ADDRESS_A,
    })
    expect(output).toContain('whitelist.json and deployments disagree')
    expect(output).toContain('FeeForwarder')
  })

  it('flags an added pair for a periphery the deploy log does not know', () => {
    const output = check({ peripheryName: 'FeeForwarder' })
    expect(output).toContain("❌ no deployments entry for 'FeeForwarder'")
  })

  it('accepts removing a superseded address without raising an alarm', () => {
    const output = check({
      contractAddress: ADDRESS_B,
      peripheryName: 'FeeForwarder',
      registeredAddress: ADDRESS_A,
      whitelisted: false,
    })
    expect(output).toContain('superseded')
    expect(output).not.toContain('❌')
  })

  it('warns when a removal targets the current deployment', () => {
    const output = check({
      peripheryName: 'FeeForwarder',
      registeredAddress: ADDRESS_A,
      deployLogName: 'FeeForwarder',
      whitelisted: false,
    })
    expect(output).toContain('⚠️')
    expect(output).toContain('FeeForwarder')
  })

  it('warns on a removal of a deploy-log address whitelist.json does not label', () => {
    const output = check({ deployLogName: 'Executor', whitelisted: false })
    expect(output).toContain('⚠️')
    expect(output).toContain('Executor')
  })

  it('warns on a removal of an address the deploy log still points at under another name', () => {
    const output = check({
      contractAddress: ADDRESS_B,
      peripheryName: 'FeeForwarder',
      registeredAddress: ADDRESS_A,
      deployLogName: 'FeeForwarderLegacy',
      whitelisted: false,
    })
    expect(output).toContain('⚠️')
    expect(output).toContain('FeeForwarderLegacy')
    expect(output).not.toContain('superseded')
  })
  it('says nothing when neither source knows the address', () => {
    expect(check({ contractAddress: ADDRESS_B })).toBe('')
    expect(check({ contractAddress: ADDRESS_B, whitelisted: false })).toBe('')
  })

  it('annotates an address the deploy log knows but whitelist.json does not label', () => {
    const output = check({ deployLogName: 'Executor' })
    expect(output).toContain('deployments: Executor')
  })
  it('compares addresses case-insensitively', () => {
    const output = check({
      contractAddress: ADDRESS_A.toLowerCase(),
      peripheryName: 'FeeForwarder',
      registeredAddress: ADDRESS_A.toUpperCase().replace('0X', '0x'),
    })
    expect(output).toContain('✅ matches deployments')
  })
})

describe('whitelist pair rendering on Tron', () => {
  // viem's decodeFunctionData yields hex for a Tron proposal while both
  // config/whitelist.json and the deploy log store base58, so the periphery
  // match has to be network-aware rather than a case fold.
  it('resolves a periphery contract passed in the decoded hex form', async () => {
    const name = 'FeeCollector'
    const base58 = required(
      (tronDeployments as Record<string, string>)[name],
      `deployments/tron.json ->  `
    )
    const labelled = (
      (whitelistJson as { PERIPHERY: Record<string, { name: string }[]> })
        .PERIPHERY.tron ?? []
    ).some((entry) => entry.name === name)
    expect(labelled).toBe(true)

    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatBatchSetContractSelectorWhitelist(
      [[normalizeAddressForNetwork('tron', base58)], ['0xe0cbc5f2'], true],
      'tron'
    )
    const output = infoSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain(`PERIPHERY/${name}`)
    expect(output).toContain('✅ matches deployments')
  })
})

describe('whitelist deploy-log check against the repo config', () => {
  const render = async (
    network: string,
    address: string,
    selector: string,
    whitelisted: boolean
  ): Promise<string> => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    await formatBatchSetContractSelectorWhitelist(
      [[address], [selector], whitelisted],
      network
    )
    const output = infoSpy.mock.calls.map((call) => String(call[0])).join('\n')
    infoSpy.mockRestore()
    return output
  }

  // Composer's whitelist entries are merged from config/composerWhitelist.json
  // by updateWhitelistPeriphery.ts and never reach a deploy log, so checking
  // them against deployments would flag every correct pair on every network.
  it('checks a Composer pair against composerWhitelist.json, not the deploy log', async () => {
    const composerEntries =
      (
        composerWhitelistJson as Record<
          string,
          { address: string; functionSelectors: { selector: string }[] }[]
        >
      ).mainnet ?? []
    const entry = required(
      composerEntries[0],
      'composerWhitelist.json -> mainnet[0]'
    )
    const composerSelector = required(
      entry.functionSelectors[0],
      'composerWhitelist.json -> mainnet[0].functionSelectors[0]'
    ).selector
    const added = await render('mainnet', entry.address, composerSelector, true)
    expect(added).toContain('matches composerWhitelist.json')
    expect(added).not.toContain('no deployments entry')

    const removed = await render(
      'mainnet',
      entry.address,
      composerSelector,
      false
    )
    expect(removed).toContain('composerWhitelist.json still lists')
  })

  it('says nothing about a third-party DEX contract in either direction', async () => {
    const owned = new Set(
      Object.values(
        mainnetDeployments as unknown as Record<string, string>
      ).map((address) => address.toLowerCase())
    )
    const dex = (
      whitelistJson as unknown as {
        DEXS: {
          contracts?: Record<
            string,
            { address: string; functions?: Record<string, string> }[]
          >
        }[]
      }
    ).DEXS.flatMap((item) => item.contracts?.mainnet ?? []).find(
      (contract) =>
        !owned.has(contract.address.toLowerCase()) &&
        Object.keys(contract.functions ?? {}).length > 0
    )
    expect(dex).toBeDefined()
    if (!dex) return
    const selector = required(
      Object.keys(dex.functions ?? {})[0],
      'a DEXS mainnet contract with at least one selector'
    )

    for (const whitelisted of [true, false]) {
      const output = await render('mainnet', dex.address, selector, whitelisted)
      expect(output).not.toContain('✅')
      expect(output).not.toContain('❌')
      expect(output).not.toContain('⚠️')
      expect(output).not.toContain('deployments')
    }
  })
})
