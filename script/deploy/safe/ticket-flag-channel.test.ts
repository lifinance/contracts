/**
 * Which channel each funnel accepts a Linear ticket through — the flag, the
 * environment variable, or both.
 *
 * `ticket-gate-placement.test.ts` covers where the check sits and
 * `proposal-intent.test.ts` what it decides. This file covers only the input
 * side: that a funnel offering `--ticket` actually reads it, and that a funnel
 * which does not is the one the documentation says is environment-only rather
 * than one that lost the wiring.
 */

import { readFileSync } from 'fs'
import { join, relative } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SCRIPT_ROOT = join(REPO_ROOT, 'script')

/** 20 seconds: long enough to reach the check, short enough that a run past it is cheap. */
const TIMEOUT_MS = 20_000

/**
 * Every funnel that refuses a run for a missing ticket, with the channels it
 * accepts one through and which helper it refuses in.
 *
 * Named by what may proceed: a funnel absent from this table is not exempt, it
 * is unclassified, and the last case fails on it. `flag: false` records which
 * channel a funnel offers today, not which one it could offer.
 */
const FUNNELS = [
  { script: 'deploy/safe/propose-to-safe.ts', flag: true, asserts: false },
  {
    script: 'deploy/safe/add-safe-owners-and-threshold.ts',
    flag: true,
    asserts: true,
  },
  { script: 'deploy/tron/propose-to-safe-tron.ts', flag: true, asserts: true },
  { script: 'tasks/unpauseAllDiamonds.ts', flag: true, asserts: true },
  // Its only caller, `cleanUpProdDiamond.ts`, declares no `--ticket`, so the
  // exported variable is the whole channel — `MultisigSigningProcess.md` §4.2.
  { script: 'safe/safeScriptHelpers.ts', flag: false, asserts: true },
] as const

/** Matches the citty argument declaration, not a mention of the word. */
const TICKET_ARG = /^\s*ticket: \{$/m

const source = (script: string): string =>
  readFileSync(join(SCRIPT_ROOT, script), 'utf8')

/**
 * Spawns a funnel and returns what it printed.
 *
 * Only ever called with a ticket the parser must refuse, so the child cannot
 * reach a proposal: the point is which value the refusal names, and a run that
 * got past the check would be proposing for real.
 */
const runRefused = (
  script: string,
  args: string[],
  envTicket?: string
): string => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // These children are exercised as CLIs, not under a harness.
  delete env.NODE_ENV
  env.SAFE_PROPOSAL_TICKET = ''
  if (envTicket !== undefined) env.SAFE_PROPOSAL_TICKET = envTicket
  // Set, never deleted: bun loads the repo `.env` inside the child for every
  // name the passed environment leaves unset, so deleting these hands back a
  // real production signer key and the real proposal store — on the one funnel
  // whose next step signs on every production mainnet in turn.
  //
  // Malformed rather than merely wrong, so a child that got past the ticket
  // check dies before it can act: a key viem cannot parse throws where a
  // valid-but-unfunded one would derive an address and go on to open the
  // store, and a URI the driver rejects on construction throws where an
  // unreachable host would first spend 30 s selecting a server.
  for (const name of [
    'PRIVATE_KEY',
    'PRIVATE_KEY_PRODUCTION',
    'SAFE_SIGNER_PRIVATE_KEY',
  ])
    env[name] = 'blocked-in-tests-not-a-key'
  for (const name of ['MONGODB_URI', 'SC_MONGODB_URI'])
    env[name] = 'blocked-in-tests://no-store'

  const result = Bun.spawnSync(
    [process.execPath, join(SCRIPT_ROOT, script), ...args],
    {
      env,
      timeout: TIMEOUT_MS,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  const output = `${result.stdout.toString()}${result.stderr.toString()}`

  // Checked before the usability checks below: a child that reached the real
  // store is the failure most likely to present as a timeout, and the one
  // whose cost is a dummy row in the live proposal queue.
  //
  // Keyed on this funnel's own success lines, which have to be unsatisfiable
  // by the refusal text sitting beside them — the refusal itself contains the
  // words "Safe proposal", so a predicate on those fires on every case and
  // fails the runs it exists to protect.
  if (/Transaction proposed|network\(s\) processed successfully/i.test(output))
    throw new Error(
      'a probe reached a real Safe or proposal store — the child environment is not isolated'
    )

  // A killed child is not a result: without this, an assertion about what the
  // output does NOT contain passes on a run that never produced output.
  if (result.signalCode !== null && result.signalCode !== undefined)
    throw new Error(
      `child was killed by ${result.signalCode} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )

  return output
}

// `unpauseAllDiamonds.ts` is the funnel this can be shown on end to end: its
// check sits before any Safe client, and a refused value keeps the run off the
// proposing branch entirely. The first case is the pair for the rest — it says
// the environment is genuinely empty, so a later refusal naming a URL cannot
// have been satisfied by a value arriving from anywhere but the flag.
describe('a funnel that offers --ticket reads it', () => {
  const REFUSED_URL = 'https://example.com/issue/EXSC-1'
  const PRODUCTION_MAINNET = [
    '--environment',
    'production',
    '--networks',
    'mainnet',
  ]

  it('refuses with the absent message when neither channel is set', () => {
    expect(
      runRefused('tasks/unpauseAllDiamonds.ts', PRODUCTION_MAINNET)
    ).toContain('No Linear ticket supplied')
  })

  it('names the value passed to --ticket, so the flag was what it read', () => {
    const output = runRefused('tasks/unpauseAllDiamonds.ts', [
      ...PRODUCTION_MAINNET,
      '--ticket',
      REFUSED_URL,
    ])

    expect(output).toContain('not a Linear issue link')
    expect(output).toContain(REFUSED_URL)
    // The other refusal would mean the flag was declared and then dropped.
    expect(output).not.toContain('No Linear ticket supplied')
  })

  it('lets the flag win over a valid environment variable', () => {
    // Precedence in the direction that can be observed safely: a good flag over
    // a bad variable would have to be shown by a run that proposes.
    const output = runRefused(
      'tasks/unpauseAllDiamonds.ts',
      [...PRODUCTION_MAINNET, '--ticket', REFUSED_URL],
      'https://linear.app/lifi-linear/issue/EXSC-960'
    )

    expect(output).toContain('not a Linear issue link')
    expect(output).toContain(REFUSED_URL)
  })
})

// The remaining funnels are checked on their source rather than by spawning
// them: `add-safe-owners-and-threshold.ts` and the Tron funnel both propose for
// real once a ticket parses, and neither has a branch that reads the flag
// without heading for a proposal. A source check passes against a rewrite of
// the same bug, so these assert only the shape the flag has to travel in —
// declared, and forwarded to the check — and the last case makes an
// unclassified funnel fail rather than pass.
describe('every funnel is classified, and the classification matches its source', () => {
  it.each(FUNNELS.filter((funnel) => funnel.flag).map((f) => f.script))(
    '%s declares a ticket argument',
    (script) => {
      expect(source(script)).toMatch(TICKET_ARG)
    }
  )

  it.each(FUNNELS.filter((funnel) => !funnel.flag).map((f) => f.script))(
    '%s declares none, matching its documented channel',
    (script) => {
      expect(source(script)).not.toMatch(TICKET_ARG)
    }
  )

  it('leaves no flag-bearing funnel calling the check with nothing to read', () => {
    // A bare `assertTicketPresent()` is correct only where the environment is
    // the whole channel. Anywhere else it means a declared flag is inert, which
    // is worse than no flag: the run refuses while the operator can see the
    // value they passed.
    const asserting = FUNNELS.filter((funnel) => funnel.asserts)

    for (const { script, flag } of asserting)
      if (flag) expect(source(script)).not.toContain('assertTicketPresent()')
      // The present half: the bare form is what an environment-only funnel is
      // supposed to look like, so its absence everywhere would make the loop
      // above vacuous.
      else expect(source(script)).toContain('assertTicketPresent()')

    expect(asserting.filter((funnel) => !funnel.flag).length).toBe(1)
  })

  it('classifies every script that calls the check', () => {
    // The fail-closed half. `FUNNELS` is a snapshot, so a funnel added later
    // lands in neither list and this case names it instead of ignoring it.
    const grep = Bun.spawnSync(
      ['git', 'grep', '-l', 'assertTicketPresent', '--', 'script'],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' }
    )

    const callers = grep.stdout
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((path) => relative('script', path))
      .filter((path) => !path.endsWith('.test.ts'))
      // The module the check is defined in is not a caller of it.
      .filter((path) => path !== 'deploy/safe/proposal-intent.ts')

    const expected = FUNNELS.filter((funnel) => funnel.asserts).map(
      (funnel) => funnel.script
    )

    // Pairs the set comparison with a floor: an empty grep result would
    // otherwise make the comparison trivially true.
    expect(callers.length).toBe(expected.length)
    expect(new Set(callers)).toEqual(new Set(expected))
  })
})
