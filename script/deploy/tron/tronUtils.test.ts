import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { parseTronAddressOutput } from './tronUtils'

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
