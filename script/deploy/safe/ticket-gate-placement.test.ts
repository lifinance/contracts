/**
 * Where the ticket check sits, not what it decides.
 *
 * `proposal-intent.test.ts` covers the decision. Nothing covered the placement,
 * and deleting all three `assertTicketPresent()` call sites left the suite fully
 * green while two of the three were in the wrong place — refusing runs that
 * create no proposal at all. Both halves matter and neither implies the other:
 * a guard that never fires is a hole, and a guard that fires on a read-only run
 * is an outage.
 *
 * Spawns the real entry points, following `facetCompanionReminder.test.ts`.
 * `DOTENV_CONFIG_PATH` is pointed at an empty file so a developer's own
 * `SAFE_PROPOSAL_TICKET` cannot make these pass locally and fail in CI.
 */

import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REFUSAL = 'No Linear ticket supplied'

/** Long enough to reach the gate, short enough that a run past it is cheap. */
const TIMEOUT_MS = 20_000

const run = (
  script: string,
  args: string[],
  ticket?: string
): { output: string; refused: boolean } => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DOTENV_CONFIG_PATH: '/dev/null',
  }
  if (ticket === undefined) delete env.SAFE_PROPOSAL_TICKET
  else env.SAFE_PROPOSAL_TICKET = ticket

  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '..', '..', script), ...args],
    {
      env,
      timeout: TIMEOUT_MS,
      // stdin closed so an interactive prompt cannot hang the suite.
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  // Both streams: consola writes errors to stderr, progress to stdout, and the
  // absence of progress is half of what these assert.
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  return { output, refused: output.includes(REFUSAL) }
}

describe('the ticket gate fires on the paths that propose', () => {
  it('refuses a Safe-owner change with no ticket', () => {
    // Reaches the proposing branch: without the gate this asks for a device
    // confirmation per network before failing at the store.
    expect(
      run('deploy/safe/add-safe-owners-and-threshold.ts', [
        '--network',
        'mainnet',
        '--owners',
        '0x1111111111111111111111111111111111111111',
      ]).refused
    ).toBe(true)
  })

  it('refuses an unpause run BEFORE it signs anything', () => {
    // The refusal message alone proves nothing here: the funnel backstop emits
    // the identical text, so a deleted early check still "refuses" — after
    // reading the Safe, taking a nonce and signing. Asserting the absence of the
    // per-network progress is what separates the two.
    const result = run('tasks/unpauseAllDiamonds.ts', [
      '--environment',
      'production',
      '--networks',
      'mainnet',
    ])

    expect(result.refused).toBe(true)
    expect(result.output).not.toContain('Processing network now')
    expect(result.output).not.toContain('Generated transaction hash')
  })

  it('refuses a malformed ticket on the same path', () => {
    expect(
      run(
        'deploy/safe/add-safe-owners-and-threshold.ts',
        [
          '--network',
          'mainnet',
          '--owners',
          '0x1111111111111111111111111111111111111111',
        ],
        'https://example.com/issue/EXSC-1'
      ).output
    ).toContain('not a Linear issue link')
  })
})

describe('the ticket gate does not fire on paths that create no proposal', () => {
  // Each of these was refused by an earlier placement of the guard. A read-only
  // or direct-send run needs no ticket, and refusing one is a self-inflicted
  // outage on a path that touches nothing.
  it('lets a read-only Safe-owner audit run', () => {
    expect(
      run('deploy/safe/add-safe-owners-and-threshold.ts', [
        '--network',
        'mainnet',
        '--check',
      ]).refused
    ).toBe(false)
  })

  it('lets an unpause run reach its own network filtering first', () => {
    // Selects nothing, so the run stops at "no matching active networks" — which
    // is downstream of where the gate belongs and upstream of any proposal. The
    // earlier placement produced the ticket refusal here instead, on a run that
    // proposes nothing and contacts no chain.
    const result = run('tasks/unpauseAllDiamonds.ts', [
      '--environment',
      'staging',
      '--networks',
      'doesnotexist',
    ])

    expect(result.refused).toBe(false)
    expect(result.output).toContain('No matching active networks')
  })
})
