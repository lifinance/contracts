/**
 * Regression tests for redactVerifyCmd (script/helperFunctions.sh).
 *
 * Explorer API keys are passed to `forge verify-contract` as command arguments and the
 * command is echoed into CI logs. Redaction therefore has to survive keys that contain
 * whitespace or newlines, which a substitution over the joined command string does not.
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
 * Call redactVerifyCmd with the given arguments and return its trimmed output.
 *
 * @param args - arguments to pass to redactVerifyCmd
 */
function redact(args: string[]): string {
  return execFileSync(
    'bash',
    [
      '-c',
      'source script/helperFunctions.sh >/dev/null 2>&1; redactVerifyCmd "$@"',
      'harness',
      ...args,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).trim()
}

describe('redactVerifyCmd', () => {
  it('redacts the value of both API-key flags', () => {
    const output = redact([
      'forge',
      'verify-contract',
      '--etherscan-api-key',
      'secret-etherscan',
      '--verifier-api-key',
      'secret-verifier',
    ])

    expect(output).not.toContain('secret-etherscan')
    expect(output).not.toContain('secret-verifier')
    expect(output).toContain('--etherscan-api-key ***REDACTED***')
    expect(output).toContain('--verifier-api-key ***REDACTED***')
  })

  it('redacts the equals form of both API-key flags', () => {
    const output = redact([
      '--etherscan-api-key=secret-etherscan',
      '--verifier-api-key=secret-verifier',
    ])

    expect(output).not.toContain('secret-etherscan')
    expect(output).not.toContain('secret-verifier')
    expect(output).toContain('--etherscan-api-key=***REDACTED***')
    expect(output).toContain('--verifier-api-key=***REDACTED***')
  })

  it('redacts a key containing whitespace without leaking its tail', () => {
    const output = redact([
      '--etherscan-api-key',
      'leading tail-of-the-key',
      '--chain-id',
      '1',
    ])

    expect(output).not.toContain('tail-of-the-key')
    expect(output).toContain('--chain-id 1')
  })

  it('redacts a key containing a newline without leaking its tail', () => {
    const output = redact([
      '--verifier-api-key',
      'leading\ntail-of-the-key',
      '--chain-id',
      '1',
    ])

    expect(output).not.toContain('tail-of-the-key')
    expect(output).toContain('--chain-id 1')
  })

  it('redacts an empty key value without shifting the remaining arguments', () => {
    const output = redact(['--etherscan-api-key', '', '--chain-id', '1'])

    expect(output).toBe('--etherscan-api-key ***REDACTED*** --chain-id 1')
  })

  it('keeps arguments separated when a non-key argument contains whitespace', () => {
    const output = redact(['--constructor-args', 'a b', '--chain-id', '1'])

    expect(output).toContain('--chain-id 1')
    expect(output).toMatch(/--constructor-args\s+('a b'|a\\ b)/)
  })

  it('does not fail when the API-key flag has no value at all', () => {
    expect(redact(['--chain-id', '1', '--etherscan-api-key'])).toBe(
      '--chain-id 1 --etherscan-api-key'
    )
  })

  it('returns nothing when called without arguments', () => {
    expect(redact([])).toBe('')
  })
})
