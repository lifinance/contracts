/**
 * Where the Ledger refusals sit in `cleanUpProdDiamond.ts`, not what they
 * decide. The two headless `assertLedgerProposesOnce()` call sites are driven as
 * real runs; the third sits behind `multiselectWithSearch`, which needs a TTY,
 * so its placement is asserted on the source instead.
 *
 * `DOTENV_CONFIG_PATH` is emptied so a developer's own `.env` cannot make these
 * pass locally and fail in CI.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

/** Every refusal here precedes any network work, so it arrives well inside this. */
const TIMEOUT_MS = 20_000

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

describe('the interactive periphery multiselect refuses before it proposes', () => {
  // Asserted on the source, not by running it: the selection sits behind
  // `multiselectWithSearch`, which needs a TTY. Without this, deleting the
  // guard from that branch breaks no test.
  const source = readFileSync(
    join(import.meta.dir, 'cleanUpProdDiamond.ts'),
    'utf8'
  )
  const BRANCH_MARKER = `action === 'Periphery(s)'`
  const markerAt = source.indexOf(BRANCH_MARKER)
  const branch = markerAt === -1 ? '' : source.slice(markerAt)

  it('still has the branch it claims to guard', () => {
    // A rename here would silently empty the slice and pass every ordering
    // assertion below on an empty string.
    expect(markerAt).toBeGreaterThan(-1)
  })

  it('guards between the selection and the first proposal', () => {
    const selectAt = branch.indexOf('multiselectWithSearch(')
    const guardAt = branch.indexOf('assertLedgerProposesOnce(')
    const proposeAt = branch.indexOf('sendOrPropose(')

    expect(selectAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(selectAt)
    expect(proposeAt).toBeGreaterThan(guardAt)
  })

  it('counts the selection, so a single removal still goes through', () => {
    // Whitespace-tolerant: prettier reflows this call whenever the surrounding
    // indentation changes, and that is not a regression.
    expect(branch).toMatch(/assertLedgerProposesOnce\(\s*selected\.length/)
  })
})
