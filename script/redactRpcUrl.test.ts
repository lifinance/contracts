/**
 * Regression tests for redactRpcUrl (script/helperFunctions.sh).
 *
 * `getRPCUrl` returns the keyed `ETH_NODE_URI_<NETWORK>` on stdout, and several scripts echo that
 * value into a log line — one of them ungated. The provider key sits in the path or the query, so
 * the whole URL has to go.
 */
import { execFileSync } from 'child_process'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Call redactRpcUrl with the given value and return its output.
 *
 * @param value - the text to redact
 */
function redact(value: string): string {
  return execFileSync(
    'bash',
    [
      '-c',
      'source script/helperFunctions.sh >/dev/null 2>&1; redactRpcUrl "$1"',
      'harness',
      value,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
}

describe('redactRpcUrl', () => {
  it.each([
    ['a key in the path', 'https://lb.drpc.org/ogrpc/KEY123'],
    ['a key in the query', 'https://eth.example/v1?dkey=KEY123'],
    [
      'a key as the whole path segment',
      'https://eth-mainnet.nodereal.io/v1/KEY123',
    ],
    ['a websocket endpoint', 'wss://eth.example/ws/KEY123'],
  ])('removes %s', (_name, url) => {
    const out = redact(url)
    expect(out).not.toContain('KEY123')
    expect(out).toBe('[redacted-url]')
  })

  it('redacts a URL embedded in a longer line, keeping the rest', () => {
    const out = redact(
      'Analyzing tx 0xabc on network: mainnet with RPC URL: https://x.io/v1/KEY123'
    )
    expect(out).not.toContain('KEY123')
    expect(out).toContain('Analyzing tx 0xabc on network: mainnet')
  })

  it('leaves text with no endpoint untouched', () => {
    // Paired negative: a redactor that returned a constant would satisfy every case above.
    expect(redact('no endpoint here')).toBe('no endpoint here')
  })

  it('redacts every endpoint on the line, not just the first', () => {
    const out = redact('primary https://a.io/K1 fallback https://b.io/K2')
    expect(out).not.toContain('K1')
    expect(out).not.toContain('K2')
  })
})
