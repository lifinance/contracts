import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { parseTronAddressOutput, parseTroncastArrayOutput } from './tronUtils'

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
