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
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'

import {
  getRoleName,
  formatRoleChange,
  formatBatchSetContractSelectorWhitelist,
  formatDecodedArg,
  formatDecodedTxDataForDisplay,
  formatTimelockScheduleBatch,
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

describe('formatDecodedArg', () => {
  it('renders a tuple array carrying bigints instead of failing the decode', () => {
    // initFrax((uint256 chainId, uint32 eid)[]) shape: viem decodes the numeric
    // fields as bigints, which a plain JSON.stringify throws on — taking the
    // whole decode down and leaving the operator approving an unshown payload.
    const arg = [
      { chainId: 1n, eid: 30101 },
      { chainId: 480n, eid: 30319 },
    ]

    const output = formatDecodedArg(arg)

    expect(output).toContain('"chainId":"1"')
    expect(output).toContain('"chainId":"480"')
    expect(output).toContain('30319')
  })

  it('renders nested bigints at any depth', () => {
    const output = formatDecodedArg({ outer: [{ inner: [7n] }] })

    expect(output).toBe('{"outer":[{"inner":["7"]}]}')
  })

  it('still renders a top-level bigint bare, without JSON quoting', () => {
    expect(formatDecodedArg(10800n)).toBe('10800')
  })

  it('renders a nested address in the network format, like a top-level one', () => {
    const address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
    const nested = formatDecodedArg({ target: address }, 'tron')

    expect(nested).toContain(formatDecodedArg(address, 'tron'))
    expect(nested).not.toContain(`"${address}"`)
  })

  it('leaves a nested non-address string untouched', () => {
    expect(formatDecodedArg({ name: 'FraxFacet' }, 'tron')).toBe(
      '{"name":"FraxFacet"}'
    )
  })
})

/**
 * The decoded display, driven through the real formatter.
 *
 * `formatDecodedTxDataForDisplay` prints one screen above the sanitised detail
 * block, so anything it renders raw lands closer to the sign prompt than the
 * lines the signer is told to read. Every case below encodes a payload and runs
 * the formatter; none of them scans the source, because a scanner cannot decide
 * where a value came from.
 */
describe('formatDecodedTxDataForDisplay renders no proposer-controlled text raw', () => {
  const ESC = String.fromCharCode(27)
  /** Colour codes this module writes itself; nothing else may remain. */
  // eslint-disable-next-line no-control-regex -- these are the codes the module writes
  const OWN_COLOURS = /\u001b\[(?:0|3[0-9]|90)m/gu
  // eslint-disable-next-line no-control-regex -- finding the escapes is the point
  const TERMINAL_DRIVING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
  const CONTEXT = { chainId: 1, network: 'mainnet' }

  /** Repaints the screen, then forges a plausible `To:` line under it. */
  const REPAINT = `${ESC}[2J${ESC}[H  To:  0x0000000000000000000000000000000000000001`

  let originalFetch: typeof globalThis.fetch
  let cacheDir: string
  let originalCachePath: string | undefined

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decode-display-cache-'))
    originalCachePath = process.env.SELECTOR_SIGNATURE_CACHE_PATH
    process.env.SELECTOR_SIGNATURE_CACHE_PATH = path.join(
      cacheDir,
      'selector-signatures.json'
    )
    originalFetch = globalThis.fetch
    // Offline by construction: an unresolved selector must not depend on what
    // 4byte.sourcify.dev happens to answer today.
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { function: {} } }),
      })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalCachePath === undefined)
      delete process.env.SELECTOR_SIGNATURE_CACHE_PATH
    else process.env.SELECTOR_SIGNATURE_CACHE_PATH = originalCachePath
    fs.rmSync(cacheDir, { recursive: true, force: true })
    spyOn(consola, 'info').mockRestore()
    spyOn(consola, 'warn').mockRestore()
  })

  const render = async (
    data: unknown,
    context: { chainId: number; network: string; indent?: string } = CONTEXT
  ): Promise<string[]> => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    const warnSpy = spyOn(consola, 'warn').mockImplementation(
      (() => {}) as never
    )
    await formatDecodedTxDataForDisplay(data as never, context)
    return [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((call) =>
      String(call[0])
    )
  }

  const expectInert = (lines: string[]): void => {
    for (const line of lines)
      expect(line.replace(OWN_COLOURS, '').match(TERMINAL_DRIVING)).toBeNull()
  }

  it('renders a hostile registerPeripheryContract name inert and says so', async () => {
    // A cleanly decoding call, encoded exactly as this repository encodes it:
    // the whole payload is the `string` argument's content.
    const lines = await render(
      encodeFunctionData({
        abi: parseAbi(['function registerPeripheryContract(string,address)']),
        args: [
          `GasZipPeriphery${REPAINT}`,
          '0x1111111111111111111111111111111111111111',
        ],
      })
    )

    expectInert(lines)
    const nameLine = lines.find((line) => line.includes('Periphery Name:'))
    expect(nameLine).toBe(
      'Periphery Name: \u001b[33mGasZipPeriphery[2J[H To: 0x0000000000000000000000000000000000000001\u001b[0m\u001b[33m ⚠ sanitised for display — stored 71, printable 67\u001b[0m'
    )
  })

  it('clips a name long enough to scroll the verdict away', async () => {
    // Needs no escape sequence at all: half a million characters of a valid
    // `string` argument pushed the target address and the deployments verdict
    // off the top of the screen, leaving the prompt. The lookup still keys on
    // the whole stored value, so clipping the display cannot change the verdict.
    const lines = await render(
      encodeFunctionData({
        abi: parseAbi(['function registerPeripheryContract(string,address)']),
        args: [
          'A'.repeat(500_000),
          '0x1111111111111111111111111111111111111111',
        ],
      })
    )
    const nameLine = lines.find((line) => line.includes('Periphery Name:'))

    expect(nameLine?.length).toBeLessThan(500)
    expect(nameLine).toContain('clipped for display')
  })

  it('leaves a hex payload argument whole', async () => {
    // Paired present, and the reason the bound is by shape rather than blanket:
    // a hex payload is what the signature covers, so its length is its own
    // disclosure and clipping it would hide the thing being approved.
    const long = `0x${'ab'.repeat(400)}`
    expect(formatDecodedArg(long)).toContain(long.slice(2).toLowerCase())
    expect(formatDecodedArg(long)).not.toContain('clipped for display')
  })

  it('does not vouch for a name the calldata does not contain', async () => {
    // `GasZipPeriphery` is a real mainnet deployment at this address, and a
    // zero-width space inside the stored name sanitises away. Keying the
    // deployments lookup on the printable text therefore matched an entry the
    // calldata never named and printed a ✅ about it: this check has to decide
    // on the stored value even though it shows the printable one.
    const spoofed = await render(
      encodeFunctionData({
        abi: parseAbi(['function registerPeripheryContract(string,address)']),
        args: [
          'GasZip​Periphery',
          '0x363d698649cd04f9692Ab86e8365b227c1ee859d',
        ],
      })
    )
    const spoofedLine = spoofed.find((line) =>
      line.includes('Periphery Address:')
    )

    expect(spoofedLine).not.toContain('matches deployments')
    expect(spoofedLine).toContain('no deployments entry')
  })

  it('still vouches for the name the calldata really holds', async () => {
    // Paired present for the case above, in its own test because `render`'s spy
    // accumulates across calls — two renders in one test and `find` returns the
    // first match, which would have asserted this against the spoofed line.
    const lines = await render(
      encodeFunctionData({
        abi: parseAbi(['function registerPeripheryContract(string,address)']),
        args: ['GasZipPeriphery', '0x363d698649cd04f9692Ab86e8365b227c1ee859d'],
      })
    )

    expect(lines.find((line) => line.includes('Periphery Address:'))).toContain(
      'matches deployments'
    )
  })

  it('renders a benign registerPeripheryContract call unchanged', async () => {
    const lines = await render(
      encodeFunctionData({
        abi: parseAbi(['function registerPeripheryContract(string,address)']),
        args: ['GasZipPeriphery', '0x1111111111111111111111111111111111111111'],
      })
    )

    expect(lines).toContain(
      'Periphery Name: \u001b[33mGasZipPeriphery\u001b[0m'
    )
    // No notice anywhere: a benign row must render exactly as it did before.
    expect(lines.some((line) => line.includes('⚠'))).toBe(false)
  })

  it('bounds and sanitises the raw preview when nothing decodes', async () => {
    const lines = await render(`0x99887766${'ab'.repeat(400)}`)

    const raw = lines.find((line) => line.includes('Data (raw):'))
    expect(raw).toBe(
      `Data (raw): \u001b[90m0x99887766${'ab'.repeat(
        28
      )}\u001b[0m\u001b[33m ⚠ clipped for display — stored 810, shown 66\u001b[0m`
    )
  })

  it('sanitises the raw preview reached through the catch arm', async () => {
    // `data.slice` is called outside every inner try, so a row shape that has
    // no `slice` lands in the outer catch — the arm that echoes viem's message
    // (which quotes its input back) and then the row's own bytes.
    const lines = await render({
      substring: () => '0xdeadbeef',
      toString: () => `0x${REPAINT}`,
    })

    expectInert(lines)
    expect(lines.some((line) => line.includes('Failed to decode data:'))).toBe(
      true
    )
    expect(lines.find((line) => line.includes('Data (raw):'))).toContain(
      '[2J[H To: 0x00000000'
    )
  })

  it('sanitises the error message on the catch arm', async () => {
    const lines = await render({
      substring: () => '0xdeadbeef',
      slice: () => {
        throw new Error(`viem echoed back ${REPAINT}`)
      },
      toString: () => '0x1234',
    })

    expectInert(lines)
    expect(lines.find((line) => line.includes('Failed to decode data:'))).toBe(
      'Failed to decode data: viem echoed back [2J[H To: 0x0000000000000000000000000000000000000001\u001b[33m ⚠ sanitised for display — stored 73, printable 69\u001b[0m'
    )
  })

  it('sanitises a signature the 4byte lookup supplied', async () => {
    // Remote text, and a proposer picks which of it is fetched by picking the
    // selector. The selector is derived from the hostile signature because
    // `resolveSelectorsViaFourByte` drops a name that does not hash back to the
    // selector it was asked about — a stub ignoring that would leave this
    // assertion observing the raw-preview arm instead of this route.
    const hostileSignature = `evil${ESC}[2J(uint256)`
    const selector = toFunctionSelector(hostileSignature)
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: { function: { [selector]: [{ name: hostileSignature }] } },
          }),
      })) as unknown as typeof fetch

    const lines = await render(selector)
    expectInert(lines)
    // The 4byte name really did reach a line, so the assertion above is about
    // that route and not about the preview the raw arm would have printed.
    expect(lines.some((line) => line.includes('evil'))).toBe(true)
  })

  it('sanitises through the nested scheduleBatch recursion', async () => {
    const inner = encodeFunctionData({
      abi: parseAbi(['function registerPeripheryContract(string,address)']),
      args: [`Patcher${REPAINT}`, '0x2222222222222222222222222222222222222222'],
    })
    const lines = await render(
      encodeFunctionData({
        abi: parseAbi([
          'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
        ]),
        args: [
          ['0x3333333333333333333333333333333333333333'],
          [0n],
          [inner],
          `0x${'00'.repeat(32)}`,
          `0x${'11'.repeat(32)}`,
          86400n,
        ],
      })
    )

    expectInert(lines)
    // The nested frame really was entered, so the assertion above is about the
    // recursion rather than about the batch header alone.
    expect(lines.some((line) => line.includes('Periphery Name:'))).toBe(true)
  })
})

describe('formatTimelockScheduleBatch — driven by the stored row', () => {
  const ESC = String.fromCharCode(27)

  const captureBatch = async (target: unknown): Promise<string[]> => {
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    try {
      await formatTimelockScheduleBatch(
        [
          [target],
          [0n],
          ['0x'],
          `0x${'00'.repeat(32)}`,
          `0x${'11'.repeat(32)}`,
          86400n,
        ],
        'mainnet'
      )
      return infoSpy.mock.calls.map((call) => String(call[0]))
    } finally {
      infoSpy.mockRestore()
    }
  }

  it('shows a target that is not an address as stored, with no link', async () => {
    // Sanitising an address produces a *different* address that still looks
    // like one, which is how the periphery check came to vouch for a name the
    // calldata never held. So an unparseable target is reported rather than
    // repaired, and loses its name and explorer link: there is nothing left to
    // vouch for, and a link built from a non-address is worse than none.
    const line = (
      await captureBatch(`0x1111111111111111111111111111111111111111${ESC}[2J`)
    ).find((text) => text.includes('target='))

    expect(line).toContain('not a valid address')
    expect(line).not.toContain(`${ESC}[2J`)
    expect(line).not.toContain('http')
  })

  it('still names and links a target that is an address', async () => {
    // Paired present: the refusal above is about the value, not about the
    // feature having been switched off.
    const line = (
      await captureBatch('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')
    ).find((text) => text.includes('target='))

    expect(line).toContain('http')
    expect(line).not.toContain('not a valid address')
  })

  it('renders a hostile payload selector inert', async () => {
    // `execute-pending-timelock-tx` hands `deserializeScheduleParams(row)`
    // straight in, so these are stored strings rather than ABI-decoded bytes:
    // the payload need not be hex at all, and the selector is simply its first
    // ten characters. Driving the function directly is the only way to reach
    // that, since `bytes` recovered from calldata is always valid hex.
    const infoSpy = spyOn(consola, 'info').mockImplementation(
      (() => {}) as never
    )
    try {
      await formatTimelockScheduleBatch(
        [
          ['0x1111111111111111111111111111111111111111'],
          [0n],
          [`0xbeef${ESC}[2Jfake`],
          `0x${'00'.repeat(32)}`,
          `0x${'11'.repeat(32)}`,
          86400n,
        ],
        'mainnet'
      )
      const line = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes('selector='))

      // Present: the stored value did reach the line, so the absence below is
      // about sanitising rather than about the line never being printed.
      expect(line).toContain('0xbeef')
      expect(line).not.toContain(`${ESC}[2J`)
    } finally {
      infoSpy.mockRestore()
    }
  })
})

describe('formatDecodedArg — a decoded string is proposer-controlled', () => {
  const ESC = String.fromCharCode(27)

  it('renders a hostile decoded string inert and discloses it', () => {
    expect(formatDecodedArg(`${ESC}[2Jfake`)).toBe(
      '[2Jfake\u001b[33m ⚠ sanitised for display — stored 8, printable 7\u001b[0m'
    )
  })

  it('renders a hostile string nested in a tuple inert, with no notice', () => {
    // The notice would land inside a JSON string, where its own colour codes
    // are escaped into visible text and read as part of the value.
    const rendered = formatDecodedArg([`${ESC}[2Jfake`, 1n])
    expect(rendered).toBe('["[2Jfake","1"]')
    expect(rendered).not.toContain(ESC)
  })

  it('leaves a benign string exactly as it was', () => {
    expect(formatDecodedArg('GasZipPeriphery')).toBe('GasZipPeriphery')
    expect(formatDecodedArg(['a', 1n])).toBe('["a","1"]')
  })
})
