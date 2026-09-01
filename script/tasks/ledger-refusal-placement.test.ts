/**
 * Where the Ledger refusals sit in `cleanUpProdDiamond.ts`, not what they
 * decide. Covers the two headless `assertLedgerProposesOnce()` call sites; the
 * third sits behind `multiselectWithSearch` and is unreachable with stdin closed.
 *
 * `DOTENV_CONFIG_PATH` is emptied so a developer's own `.env` cannot make these
 * pass locally and fail in CI.
 */

import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

/** Every refusal here precedes any network work, so it arrives well inside this. */
const TIMEOUT_MS = 20_000 // 4 seconds

const run = (...args: string[]): string => {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'cleanUpProdDiamond.ts'), ...args],
    {
      env: {
        ...(process.env as Record<string, string>),
        DOTENV_CONFIG_PATH: '/dev/null',
      },
      timeout: TIMEOUT_MS,
      // stdin closed: the interactive paths prompt, and a prompt would hang.
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  // Nullable: a run killed at the timeout may have produced neither stream.
  return `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`
}

describe('a Ledger run that would propose more than once is refused', () => {
  it.each([
    [
      '--all-networks',
      ['--all-networks', '--environment', 'production', '--yes'],
    ],
    [
      '--allNetworks',
      ['--allNetworks', '--environment', 'production', '--yes'],
    ],
  ])('refuses a fleet sweep that will propose (%s)', (_label, args) => {
    expect(run(...args, '--ledger')).toContain('cannot be combined')
  })

  it('refuses several periphery names on one network', () => {
    expect(
      run(
        '--network',
        'mainnet',
        '--environment',
        'production',
        '--periphery',
        '["Executor","FeeCollector"]',
        '--ledger'
      )
    ).toContain('cannot be combined')
  })
})

describe('the argv readers are wired into the real command', () => {
  it('refuses a value it cannot read, rather than guessing', () => {
    expect(
      run(
        '--network',
        'mainnet',
        '--environment',
        'production',
        '--periphery',
        '["Executor"]',
        '--ledger',
        '--ledgerLive=no'
      )
    ).toContain("accepts no value, 'true' or 'false'")
  })

  it('refuses the same flag twice', () => {
    expect(
      run(
        '--network',
        'mainnet',
        '--environment',
        'production',
        '--periphery',
        '["Executor"]',
        '--ledger=false',
        '--ledger'
      )
    ).toContain('given more than once')
  })
})
