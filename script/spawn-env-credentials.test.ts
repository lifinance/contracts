/**
 * Guards every shipped test against `delete`-ing a credential out of a child's
 * environment, which does not withhold it.
 *
 * Bun re-loads the repo `.env` inside a spawned child for every name the passed
 * environment leaves unset, so deleting a credential name hands the real value
 * back. The blast radius is the *failing* path, which mutation testing
 * manufactures deliberately: a probe whose only barrier is the refusal it is
 * testing will, the moment that refusal is mutated away, run a real CLI with a
 * real production key.
 *
 * Two checks, because either alone is weak. A source assertion catches the
 * spelling across the whole tree but cannot tell whether the replacement
 * actually works; a spawn against a fixture `.env` pins the bun behaviour the
 * replacement depends on, without any real credential taking part.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterAll, describe, expect, it } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Names holding a signing secret or a proposal-store URI. Matched by substring
 * rather than enumerated because the wallet keys come in generations — pauser,
 * refund and withdraw wallets sit alongside several retired deployer ones — so
 * an enumeration would silently stop covering the next name added.
 *
 * The keyed RPC endpoints, explorer and provider API keys and Slack webhooks
 * are deliberately outside this: deleting one of those is often how a fallback
 * gets tested, and matching them would put a marker on every such test to
 * withhold something no signature depends on.
 *
 * The store half anchors on the full URI suffix rather than on the driver name
 * alone, so the logging toggle that shares that prefix is not mistaken for a
 * credential.
 */
const CREDENTIAL_NAME =
  '[A-Z0-9_]*(?:PRIVATE_KEY|MNEMONIC|MONGODB_URI)[A-Z0-9_]*'

/**
 * Matches `delete env.PRIVATE_KEY`, `delete env['PRIVATE_KEY']`,
 * `delete process.env.PRIVATE_KEY` and the optional-chained forms, whatever the
 * holder is called.
 *
 * Only literal member access is visible here. A computed key
 * (`delete env[name]`), a concatenated one, `Reflect.deleteProperty`, and
 * dropping a name by rest-destructuring all withhold nothing in the same way
 * and are all invisible to a source scan — deciding them needs a parser and a
 * constant-folding pass. The hermetic spawn below is what covers the mechanism
 * itself; this pattern only catches the spelling people actually reach for.
 */
const DELETES_A_CREDENTIAL = new RegExp(
  `delete\\s+[A-Za-z_$][\\w$.?]*(?:\\.${CREDENTIAL_NAME}\\b|\\[['"\`]${CREDENTIAL_NAME}['"\`]\\])`,
  'u'
)

/**
 * Marks a delete whose reason is written down next to it. The reason is free
 * text after the prefix, because there is more than one legitimate shape: a
 * child spawned into a fixture directory with no `.env` has nothing to
 * re-load, and an in-process test that needs the name genuinely unset is not
 * spawning at all.
 *
 * Annotated rather than inferred, because whether a spawn's `cwd` can reach a
 * `.env` is not decidable from the call site: it depends on a value computed
 * elsewhere. Writing the reason down puts the burden on whoever adds the next
 * one.
 */
const EXEMPTION_MARKER = 'spawn-env:'

/**
 * This file, which holds the violation as test data below and would otherwise
 * report itself. Excluded by exact path rather than by a pattern, so the
 * exclusion cannot widen to cover a real offender — a test below pins it at
 * exactly one file.
 */
const SELF = 'script/spawn-env-credentials.test.ts'

/**
 * Every *tracked* test file under the script tree. Tracked, because
 * `git ls-files` is what makes the guard land with the code it guards: a new
 * offender is invisible here until it is staged, and red from then on.
 */
const allShippedTests = (): string[] =>
  execFileSync('git', ['ls-files', 'script', 'tasks'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.endsWith('.test.ts'))

const shippedTests = (): string[] =>
  allShippedTests().filter((path) => path !== SELF)

/**
 * A line terminator between `delete` and its operand is legal grammar — the
 * spec puts no `[no LineTerminator here]` restriction there — so a per-line
 * scan would walk straight past `delete\n  env.PRIVATE_KEY`. Joining the
 * operand onto the keyword's line first also carries any trailing marker
 * comment with it, which keeps the exemption line-scoped.
 */
const joinDeleteOperands = (source: string): string =>
  source.replace(/\bdelete\s+/gu, 'delete ')

/** Lines that delete a credential and do not carry the marker. */
const unexemptedDeletions = (source: string): string[] =>
  joinDeleteOperands(source)
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

  it('excludes exactly one file, this one', () => {
    // The self-exclusion is the guard's only blind spot, so it is pinned by
    // count: a second entry could hide a real offender behind the same reason.
    const all = allShippedTests()

    expect(all).toContain(SELF)
    expect(all.length - shippedTests().length).toBe(1)
  })

  it('sees a delete whose operand is on the next line', () => {
    // Legal grammar: nothing in the spec forbids a line terminator between
    // `delete` and its operand, so a per-line scan walks past this.
    expect(unexemptedDeletions('  delete\n    env.PRIVATE_KEY\n')).toEqual([
      '  delete env.PRIVATE_KEY',
    ])
  })

  it('keeps the marker attached across that join', () => {
    // The exemption must survive the newline it was written across, or the fix
    // above turns every annotated delete back into an offender.
    expect(
      unexemptedDeletions(
        `  delete\n    env.PRIVATE_KEY // ${EXEMPTION_MARKER} fixture cwd\n`
      )
    ).toEqual([])
  })

  it('counts the exemption as an exemption only on its own line', () => {
    // Otherwise one annotated delete would license every other delete in the
    // file, which is how an exemption list stops meaning anything.
    expect(
      unexemptedDeletions(
        [
          `  delete env.PRIVATE_KEY // ${EXEMPTION_MARKER} fixture cwd`,
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
      'delete env.SAFE_SIGNER_PRIVATE_KEY',
      'delete env.PRIVATE_KEY_PAUSER_WALLET',
      'delete env.PRIVATE_KEY_REFUND_WALLET',
      'delete env.PRIVATE_KEY_WITHDRAW_WALLET',
      'delete env.PRIVATE_KEY_PRODUCTION_OLD_V3',
      'delete env.MNEMONIC',
      'delete env?.PRIVATE_KEY',
      "delete process.env?.['PRIVATE_KEY_PRODUCTION']",
    ])
      expect(DELETES_A_CREDENTIAL.test(source), source).toBe(true)
  })

  it('does not object to setting one, or to deleting a non-credential', () => {
    // Setting a malformed value is the fix, so it must not trip the guard, and
    // these unsets are legitimate: none of these names holds a credential, so
    // whatever a child re-loads for them cannot be one. `ENABLE_MONGODB_LOGGING`
    // is the near miss the store half must not swallow.
    for (const source of [
      "env.PRIVATE_KEY = 'malformed-in-tests'",
      'delete env.NODE_ENV',
      'delete env.SAFE_PROPOSAL_TICKET',
      'delete env.ENVIRONMENT',
      'delete env.ENABLE_MONGODB_LOGGING',
    ])
      expect(DELETES_A_CREDENTIAL.test(source), source).toBe(false)
  })
})

describe('setting a credential, unlike deleting it, withholds it from a child', () => {
  /**
   * Hermetic: a fixture directory holding its own env file and the child that
   * reports back, so the behaviour is pinned without a real credential taking
   * part. Lengths only, never values.
   */
  const NAME = 'PRIVATE_KEY_PRODUCTION'
  const FIXTURE_VALUE = 'value-from-fixture-env'
  const PASSED_VALUE = 'malformed-in-tests'

  const fixture = mkdtempSync(join(tmpdir(), 'spawn-env-'))
  writeFileSync(join(fixture, '.env'), `${NAME}=${FIXTURE_VALUE}\n`)
  const child = join(fixture, 'report-length.ts')
  writeFileSync(
    child,
    `const v = process.env[${JSON.stringify(NAME)}]\n` +
      `console.log(v === undefined ? 'undefined' : String(v.length))\n`
  )

  afterAll(() => rmSync(fixture, { force: true, recursive: true }))

  /** What the child reports the name's length to be, or `'undefined'`. */
  const lengthInChild = (
    mutate: (env: Record<string, string>) => void
  ): string => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    }
    delete env.NODE_ENV
    delete env[NAME] // spawn-env: what a delete leaves behind is the case under test
    mutate(env)

    const result = Bun.spawnSync([process.execPath, child], {
      cwd: fixture,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    })
    if (result.signalCode)
      throw new Error(
        `child killed by ${result.signalCode}, so its output proves nothing`
      )

    return result.stdout.toString().trim()
  }

  it('re-loads a deleted name from the env file in cwd', () => {
    // The defect itself. Without this half the assertion below would pass just
    // as well on a bun that never re-loaded anything, and the whole fix would
    // be guarding against nothing.
    expect(lengthInChild(() => undefined)).toBe(String(FIXTURE_VALUE.length))
  })

  it('lets a passed value win over that re-load', () => {
    // What `withholdCredentials` rests on. If bun ever gave the env file
    // precedence, the placement probes would start handing children real keys
    // again with every suite still green.
    expect(lengthInChild((env) => (env[NAME] = PASSED_VALUE))).toBe(
      String(PASSED_VALUE.length)
    )
  })
})
