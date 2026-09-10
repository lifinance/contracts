/**
 * Which channel each funnel accepts a Linear ticket through — the flag, the
 * environment variable, or both.
 *
 * `ticket-gate-placement.test.ts` covers where the check sits and
 * `proposal-intent.test.ts` what it decides. This file covers only the input
 * side: that a funnel offering `--ticket` actually reads it, and that a funnel
 * which does not is the one the documentation says is environment-only rather
 * than one that lost the wiring.
 *
 * Scoped to the funnels carrying an entry-point `assertTicketPresent`. Scripts
 * refused only at store time, inside `storeTransactionInMongoDB`, are a
 * different set and are not classified here.
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
 * Every funnel that refuses a run at its own entry, with the channels it
 * accepts a ticket through and the exact call the check is reached by.
 *
 * Named by what may proceed: a funnel absent from this table is not exempt, it
 * is unclassified, and the last case fails on it. `flag: false` records which
 * channel a funnel offers today, not which one it could offer. `call` is
 * matched verbatim, so forwarding the wrong value is a failure and not merely
 * forwarding nothing. `asserts: false` marks the funnel that resolves the
 * intent itself instead of calling `assertTicketPresent`, so the caller grep
 * must not expect to find it.
 */
const FUNNELS = [
  { script: 'deploy/safe/propose-to-safe.ts', flag: true, asserts: false },
  {
    script: 'deploy/safe/add-safe-owners-and-threshold.ts',
    flag: true,
    asserts: true,
    call: 'assertTicketPresent(args.ticket)',
  },
  {
    script: 'deploy/tron/propose-to-safe-tron.ts',
    flag: true,
    asserts: true,
    call: 'assertTicketPresent(options.ticket)',
    // The only funnel where the flag does not reach the check directly, so the
    // handoff `main` makes into `runPropose` is pinned as well.
    hop: 'ticket: args.ticket,',
  },
  {
    script: 'tasks/unpauseAllDiamonds.ts',
    flag: true,
    asserts: true,
    call: 'assertTicketPresent(args.ticket)',
  },
  // Its only caller, `cleanUpProdDiamond.ts`, declares no `--ticket`, so the
  // exported variable is the whole channel — `MultisigSigningProcess.md` §4.2.
  {
    script: 'safe/safeScriptHelpers.ts',
    flag: false,
    asserts: true,
    call: 'assertTicketPresent()',
  },
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

  // Detects a breach, does not prevent one — the isolation above is what does
  // that. Every line printed here follows the act it reports, so this fails the
  // run afterwards rather than stopping it; it exists so a dummy row in the
  // live proposal queue can never be mistaken for a passing suite.
  //
  // Carries a line for each funnel spawned below, including the signing step
  // that precedes the store on `add-safe-owners-and-threshold.ts` — a spent
  // signature is already a breach. Each has to be unsatisfiable by the refusal
  // text sitting beside it: the refusal itself contains the words "Safe
  // proposal", so a predicate on those would fire on every case and fail the
  // runs it exists to protect.
  if (
    /Transaction proposed|network\(s\) processed successfully|Transaction signed|successfully stored in MongoDB/i.test(
      output
    )
  )
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

// Both funnels whose check is reachable without proposing are spawned here:
// each check sits before any Safe client, so a refused value keeps the run off
// the proposing branch entirely. The first case is the pair for the rest — it
// says the environment is genuinely empty, so a later refusal naming a URL
// cannot have been satisfied by a value arriving from anywhere but the flag.
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

  // The second funnel this is reachable on: its check follows argument parsing
  // and a config-only network resolution, with no RPC, Ledger or Mongo before
  // it. The Tron funnel is the one that cannot join them — its check sits past
  // the timelock reads inside `runPropose`, so reaching it costs a live chain.
  it('names the value passed to add-safe-owners-and-threshold.ts', () => {
    const output = runRefused('deploy/safe/add-safe-owners-and-threshold.ts', [
      '--network',
      'mainnet',
      '--ticket',
      REFUSED_URL,
    ])

    expect(output).toContain('not a Linear issue link')
    expect(output).toContain(REFUSED_URL)
    expect(output).not.toContain('No Linear ticket supplied')
  })
})

// The source side of the classification, over every funnel including the two
// spawned above. It is the only cover the Tron funnel gets — its check sits
// past the timelock reads inside `runPropose`, so reaching it costs a live
// chain. A source check passes against a rewrite of the same bug, so these
// assert only the shape the flag has to travel in — declared, forwarded to the
// check, and given no `default` — and the last case makes an unclassified
// funnel fail rather than pass.
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

  it('reaches the check by the exact call its channel requires', () => {
    // Positive and verbatim, because the absence of a bare
    // `assertTicketPresent()` is satisfied by any argument at all: forwarding
    // the wrong field leaves the flag inert while still looking wired. A bare
    // call is correct only where the environment is the whole channel.
    const asserting = FUNNELS.filter((funnel) => funnel.asserts)

    for (const funnel of asserting) {
      const text = source(funnel.script)
      expect(text).toContain(funnel.call)
      if (funnel.flag) expect(text).not.toContain('assertTicketPresent()')
      if ('hop' in funnel) expect(text).toContain(funnel.hop)
    }

    // A second environment-only funnel would be a decision about where the flag
    // stops, not a detail: the cases above would still pass, and only this one
    // asks for it to be argued in §4.2 before the table records it.
    expect(asserting.filter((funnel) => !funnel.flag).length).toBe(1)
  })

  it.each(FUNNELS.filter((funnel) => funnel.flag).map((f) => f.script))(
    '%s gives the ticket argument no default to swallow the flag with',
    (script) => {
      // A citty argument with a `default` discards what the caller passed and
      // hands every run the same fabricated value, which parses — so the gate
      // records a link that leads nowhere on every proposal.
      expect(source(script)).not.toMatch(/ticket: \{[^}]*default:/s)
    }
  )

  it('classifies every script that calls the check', () => {
    // The fail-closed half. `FUNNELS` is a snapshot, so a funnel added later
    // lands in neither list and this case names it instead of ignoring it.
    // `--untracked` because the funnel this is meant to name is usually one
    // just written: without it the case passes at exactly the moment it should
    // fire, and only starts working once the new file has been staged.
    const grep = Bun.spawnSync(
      [
        'git',
        'grep',
        '-l',
        '--untracked',
        'assertTicketPresent',
        '--',
        'script',
      ],
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
