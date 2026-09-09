/**
 * Guards every shipped test against `delete`-ing a credential out of a child's
 * environment, which does not withhold it.
 *
 * Bun re-loads the repo `.env` inside a spawned child for every name the passed
 * environment leaves unset, so deleting a credential name hands the real value
 * back. Measured rather than assumed: a child spawned with
 * `PRIVATE_KEY_PRODUCTION` deleted reports it at its real 64-character length,
 * and at 18 characters when the name is set to `malformed-in-tests` instead.
 *
 * This matters most in exactly the tests that look safest. The blast radius of
 * a spawn test is the *failing* path, and mutation testing manufactures that
 * path deliberately — so a probe whose only barrier is the refusal it is
 * testing will, the moment that refusal is mutated away, run a real CLI with a
 * real production key. Three files on `main` did this; `strict-flag-placement`
 * spawns `deploy-safe.ts` and `execute-pending-timelock-tx.ts`.
 *
 * A source assertion rather than a behavioural one, because the behaviour it
 * would have to observe is a child holding a live credential — which is the
 * thing being prevented.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Names whose real value must never reach a spawned child. Every one of these
 * is declared in the repo `.env`, which is what makes deleting them worse than
 * useless.
 */
const CREDENTIAL_NAMES = [
  'PRIVATE_KEY',
  'PRIVATE_KEY_PRODUCTION',
  'SAFE_SIGNER_PRIVATE_KEY',
  'TIMELOCK_EXECUTOR_PRIVATE_KEY',
  'MONGODB_URI',
  'SC_MONGODB_URI',
] as const

/**
 * Matches `delete env.PRIVATE_KEY`, `delete env['PRIVATE_KEY']` and
 * `delete process.env.PRIVATE_KEY` for any of the names above, whatever the
 * holder is called.
 */
const DELETES_A_CREDENTIAL = new RegExp(
  `delete\\s+[A-Za-z_$][\\w$.]*(?:\\.(?:${CREDENTIAL_NAMES.join(
    '|'
  )})\\b|\\[['"\`](?:${CREDENTIAL_NAMES.join('|')})['"\`]\\])`,
  'u'
)

/**
 * The one legitimate reason to delete instead of set: the child's `cwd` is a
 * fixture directory with no `.env`, so there is nothing for bun to re-load and
 * the delete really does unset. `funnel-deploy-gate.cli.test.ts` is that case —
 * it spawns into a `mkdtempSync` repo — and its assertions depend on the
 * key-absent message, which a malformed value would replace.
 *
 * Annotated rather than inferred, because whether a spawn's `cwd` can reach a
 * `.env` is not decidable from the call site: it depends on a value computed
 * elsewhere. Writing the reason down puts the burden on whoever adds the next
 * one.
 */
const EXEMPTION_MARKER = 'spawn-env: child cwd has no .env'

/** Tracked test files under the script tree — the ones that spawn CLIs. */
const shippedTests = (): string[] =>
  execFileSync('git', ['ls-files', 'script', 'tasks'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.endsWith('.test.ts'))

/** Lines that delete a credential and do not carry the marker. */
const unexemptedDeletions = (source: string): string[] =>
  source
    .split('\n')
    .filter(
      (line) =>
        DELETES_A_CREDENTIAL.test(line) && !line.includes(EXEMPTION_MARKER)
    )

describe('no shipped test deletes a credential from a child environment', () => {
  it('enumerates the tree, so a clean result is not vacuous', () => {
    expect(shippedTests().length).toBeGreaterThan(100)
  })

  it('finds no unexempted test deleting a credential name', () => {
    const offenders = shippedTests().filter(
      (path) =>
        unexemptedDeletions(readFileSync(join(REPO_ROOT, path), 'utf8'))
          .length > 0
    )

    expect(offenders).toEqual([])
  })

  it('counts the exemption as an exemption only on its own line', () => {
    // Otherwise one annotated delete would license every other delete in the
    // file, which is how an exemption list stops meaning anything.
    expect(
      unexemptedDeletions(
        [
          `  delete env.PRIVATE_KEY // ${EXEMPTION_MARKER}`,
          '  delete env.PRIVATE_KEY_PRODUCTION',
        ].join('\n')
      )
    ).toEqual(['  delete env.PRIVATE_KEY_PRODUCTION'])
  })

  it('recognises each form the deletion is written in', () => {
    // The paired present: without this, a pattern that matched nothing at all
    // would report the same clean result as a tree that is genuinely clean.
    for (const source of [
      'delete env.PRIVATE_KEY',
      "delete env['PRIVATE_KEY_PRODUCTION']",
      'delete process.env.SC_MONGODB_URI',
      'delete childEnv.MONGODB_URI',
    ])
      expect(DELETES_A_CREDENTIAL.test(source), source).toBe(true)
  })

  it('does not object to setting one, or to deleting a non-credential', () => {
    // Setting a malformed value is the fix, so it must not trip the guard, and
    // an unset of NODE_ENV is legitimate — `.env` does not declare it, so
    // deleting it really does unset it.
    for (const source of [
      "env.PRIVATE_KEY = 'malformed-in-tests'",
      'delete env.NODE_ENV',
      'delete env.SAFE_PROPOSAL_TICKET',
      'delete env.ENVIRONMENT',
    ])
      expect(DELETES_A_CREDENTIAL.test(source), source).toBe(false)
  })
})
