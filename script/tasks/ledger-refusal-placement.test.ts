/**
 * Where the Ledger refusals sit in `cleanUpProdDiamond.ts`.
 *
 * `cli-flags.test.ts` and `safe-utils.test.ts` cover what the readers and the
 * resolver decide. Nothing covered the call sites: commenting out all three
 * `assertLedgerProposesOnce()` calls left the suite green. A refusal that never
 * fires is the defect it was added to prevent.
 *
 * Spawns the real entry point, following `facetCompanionReminder.test.ts`.
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

/**
 * The guards all precede any network work, so a refusal arrives well inside
 * this. A run that gets PAST a guard goes on to do real work and is killed here
 * instead — for those cases the assertion is a post-guard marker, not the exit.
 */
const TIMEOUT_MS = 4000

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
    ['--all-networks', ['--all-networks', '--environment', 'production']],
    ['--allNetworks', ['--allNetworks', '--environment', 'production']],
  ])('refuses a fleet sweep (%s)', (_label, args) => {
    // Each network opens a transport that is never closed and asks for its own
    // confirmation. Failing up front beats stalling mid-sweep with some
    // networks proposed and some not.
    expect(run(...args, '--ledger')).toContain('cannot be combined')
  })

  it('refuses several periphery names on one network', () => {
    // The periphery loop calls sendOrPropose once per name — the fleet hazard
    // on a single network, which the --all-networks check alone did not cover.
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

// Both cases here run past their guard into real work and are killed at
// TIMEOUT_MS, so they need more than bun's default per-test budget.
describe('a Ledger run that proposes once is not refused', () => {
  it('allows a single periphery name', () => {
    // The refusal must key on the proposal count, not on the flag being present:
    // refusing every --ledger run would remove the option this package adds.
    // Reaching the removal line is the proof it got past the guard — asserting
    // only the absence of the refusal would also pass if it never got that far.
    const output = run(
      '--network',
      'mainnet',
      '--environment',
      'production',
      '--periphery',
      '["Executor"]',
      '--ledger'
    )

    expect(output).not.toContain('cannot be combined')
    expect(output).toContain('Removing periphery: Executor')
  }, 15_000)

  it('allows a fleet sweep without a Ledger', () => {
    const output = run('--all-networks', '--environment', 'production')

    expect(output).not.toContain('cannot be combined')
    expect(output).toContain('Fleet facet-removal sweep')
  }, 15_000)
})

describe('the argv readers are wired into the real command', () => {
  it('refuses a value it cannot read, rather than guessing', () => {
    // `--ledgerLive=no` resolved to true before the readers landed, deriving
    // from a different account with no warning.
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
