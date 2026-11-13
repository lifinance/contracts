import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { TronWeb } from 'tronweb'

import {
  parseTronAddressOutput,
  parseTroncastArrayOutput,
  tronExistingDeploymentMode,
} from './tronUtils'

describe('tronExistingDeploymentMode', () => {
  const ADDR = 'TDCo8wrqwRVC7HaRAAsuCdbnS4AdAdtcn9'
  // A solc-shaped runtime: body, then a CBOR metadata trailer and its length word.
  const runtime = (body: string): string =>
    `${body}a264697066735822${'11'.repeat(34)}64736f6c634300081d0033`
  const THIS_BUILD = runtime('608060405260016000')
  const OLDER_BUILD = runtime('608060405260026000')

  const OUT_ROOT = mkdtempSync(join(tmpdir(), 'tron-propose-only-'))
  mkdirSync(join(OUT_ROOT, 'EcoFacet.sol'))
  writeFileSync(
    join(OUT_ROOT, 'EcoFacet.sol', 'EcoFacet.json'),
    JSON.stringify({ deployedBytecode: { object: `0x${THIS_BUILD}` } })
  )
  afterAll(() => rmSync(OUT_ROOT, { recursive: true, force: true }))

  /** A TronWeb whose `getContractInfo` answers `read()` and records the address asked. */
  const fakeTronWeb = (
    read: () => Promise<{ runtimecode?: string } | null>
  ) => {
    const asked: string[] = []
    const tronWeb = {
      trx: {
        getContractInfo: async (address: string) => {
          asked.push(address)
          return read()
        },
      },
    } as unknown as TronWeb
    return { asked, tronWeb }
  }

  const proposeOnlyMode = (tronWeb: TronWeb) => {
    const mode = tronExistingDeploymentMode(true, 'EcoFacet', tronWeb, OUT_ROOT)
    if (mode.kind !== 'proposeOnly') throw new Error(`got ${mode.kind}`)
    return mode
  }

  const rejection = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('expected a rejection')
  }

  it('prompts when --proposeOnly is off', () => {
    const { tronWeb } = fakeTronWeb(async () => null)

    expect(tronExistingDeploymentMode(false, 'EcoFacet', tronWeb)).toEqual({
      kind: 'prompt',
    })
  })

  it('accepts a recorded address holding this checkout build', async () => {
    const { asked, tronWeb } = fakeTronWeb(async () => ({
      runtimecode: THIS_BUILD,
    }))

    await proposeOnlyMode(tronWeb).assertThisBuild(ADDR)
    expect(asked).toEqual([ADDR])
  })

  it('refuses a recorded address holding an older build', async () => {
    const { tronWeb } = fakeTronWeb(async () => ({ runtimecode: OLDER_BUILD }))

    expect(
      await rejection(proposeOnlyMode(tronWeb).assertThisBuild(ADDR))
    ).toContain(`EcoFacet (${ADDR}): on-chain code differs`)
  })

  it('refuses a recorded address with no code', async () => {
    const { tronWeb } = fakeTronWeb(async () => ({}))

    expect(
      await rejection(proposeOnlyMode(tronWeb).assertThisBuild(ADDR))
    ).toContain('no code at that address')
  })

  it('reports a failed read as the read error, not as missing code', async () => {
    const { tronWeb } = fakeTronWeb(async () => {
      throw new Error('503 Service Unavailable')
    })

    expect(
      await rejection(proposeOnlyMode(tronWeb).assertThisBuild(ADDR))
    ).toBe('503 Service Unavailable')
  })
})

describe('parseTronAddressOutput', () => {
  const ADDR = 'TDCo8wrqwRVC7HaRAAsuCdbnS4AdAdtcn9'

  it('returns a bare address unchanged', () => {
    expect(parseTronAddressOutput(ADDR)).toBe(ADDR)
  })

  it('trims surrounding whitespace and quotes', () => {
    expect(parseTronAddressOutput(`  "${ADDR}"\n`)).toBe(ADDR)
  })

  // Regression: callTronContract prepends TronWeb's diagnostic lines to the return value.
  // Trimming the whole blob left it starting with the first diagnostic line, so every
  // "does this look like a T... address" test failed and the caller reported the contract as
  // unregistered — four false failures on tron's periphery-registered invariant, while the
  // registry actually held the correct addresses.
  it('extracts the address from output preceded by TronWeb diagnostics', () => {
    const output = [
      // RPC URL intentionally a placeholder: a real endpoint here would match an .env
      // value and trip the pre-commit secret scanner.
      '⚙ Initializing TronWeb with mainnet network: <rpc-url>',
      '⚙ Calling getPeripheryContract on TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
      '⚙ Parsing param 0: ERC20Proxy as string',
      "⚙ Formatted params: [ 'ERC20Proxy' ]",
      '⚙ Function signature: getPeripheryContract(string)',
      ADDR,
    ].join('\n')
    expect(parseTronAddressOutput(output)).toBe(ADDR)
  })

  it('ignores trailing blank lines after the address', () => {
    expect(parseTronAddressOutput(`⚙ Calling foo\n${ADDR}\n\n`)).toBe(ADDR)
  })

  it('returns an empty string when there is no non-diagnostic line', () => {
    expect(
      parseTronAddressOutput('⚙ Initializing TronWeb\n⚙ Calling foo')
    ).toBe('')
  })

  it('returns an empty string for empty input', () => {
    expect(parseTronAddressOutput('')).toBe('')
  })
})

describe('parseTroncastArrayOutput', () => {
  // Regression: getAllContractSelectorPairs() returns `address[],bytes4[][]`. callTronContract
  // prepends the troncast command echo (`$ bun run …`) and TronWeb's diagnostic lines — one of
  // which, "⚙ Formatted params: []", itself contains a `[`. The old parser trimmed the whole
  // blob and required it to start with `[`; it started with `$ bun run …` instead, so it threw
  // "Expected array format" and the whitelist-integrity invariant reported the swallowed
  // "Whitelist configuration not available" on tron. This is the real captured mainnet output.
  const REAL_OUTPUT = [
    '$ bun run script/troncast/index.ts call "TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt" "getAllContractSelectorPairs() returns (address[],bytes4[][])" --rpc-url <rpc-url>',
    '⚙ Initializing TronWeb with mainnet network: <rpc-url>',
    '⚙ Calling getAllContractSelectorPairs on TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
    '⚙ Formatted params: []',
    '⚙ Function signature: getAllContractSelectorPairs()',
    '[[TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2 TA7qd9KpEBH7qASAxxUpjWVfE3GiTwpd7q] [[0x3ccfd60b 0xd0e30db0] [0xe0cbc5f2 0xeedd56e1]]]',
  ].join('\n')

  it('parses the address[],bytes4[][] payload past the echo and diagnostic lines', () => {
    const parsed = parseTroncastArrayOutput(REAL_OUTPUT)
    expect(parsed).toEqual([
      [
        'TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2',
        'TA7qd9KpEBH7qASAxxUpjWVfE3GiTwpd7q',
      ],
      [
        ['0x3ccfd60b', '0xd0e30db0'],
        ['0xe0cbc5f2', '0xeedd56e1'],
      ],
    ])
  })

  it('does not mistake the "[" inside "⚙ Formatted params: []" for the payload start', () => {
    // If the diagnostic line were not stripped, the first `[` in the blob would be the empty
    // params array, and the parser would return `[]` instead of the real pairs.
    const parsed = parseTroncastArrayOutput(REAL_OUTPUT)
    expect((parsed[0] as unknown[]).length).toBe(2)
  })

  it('parses a bare bracketed payload with no diagnostics', () => {
    expect(parseTroncastArrayOutput('[[TAbc] [[0x11111111]]]')).toEqual([
      ['TAbc'],
      [['0x11111111']],
    ])
  })

  it('handles an empty on-chain result (no whitelisted pairs)', () => {
    const output = ['⚙ Initializing TronWeb', '[[] []]'].join('\n')
    expect(parseTroncastArrayOutput(output)).toEqual([[], []])
  })

  it('throws when no bracketed payload is present after stripping diagnostics', () => {
    expect(() =>
      parseTroncastArrayOutput('⚙ Initializing TronWeb\n⚙ Calling foo')
    ).toThrow('Expected array format')
  })

  it('throws on empty input', () => {
    expect(() => parseTroncastArrayOutput('')).toThrow('Expected array format')
  })
})
