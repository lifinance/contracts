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
 * Several checks, because no one of them is enough. A source assertion catches
 * the spelling across the whole tree but cannot tell whether the replacement
 * works; a pairing against the class table in
 * `script/deploy/safe/spawn-env.ts` catches the scan and the withholding
 * drifting apart; and spawns against fixture `.env` files pin the bun
 * behaviour the replacement depends on, and the endpoint, provider-key and
 * webhook classes end to end, without any real credential taking part.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { afterAll, describe, expect, it } from 'bun:test'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  ALWAYS_WITHHELD,
  CREDENTIAL_CORES,
  NON_CREDENTIAL_NAMES,
  withheldValueFor,
  withholdCredentials,
} from './deploy/safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Names holding a credential, by the substring the name carries.
 *
 * Derived from the cores `withholdCredentials` withholds by, rather than
 * spelled out again here, because the two drifting apart is the failure this
 * file exists to prevent: a guard that reports a clean tree while the fix it
 * guards has stopped covering a class is worse than no guard. Widening one now
 * widens both, and a class dropped from the table goes red below.
 *
 * What this cannot see is a credential whose name carries none of those cores —
 * a `FOO_SECRET_SAUCE` is invisible to the scan here and to the sweep there
 * alike. Naming the classes is therefore a decision that has to be revisited
 * when a new kind of secret enters the store, not a pattern that grows by
 * itself.
 */
const CREDENTIAL_NAME = `[A-Z0-9_]*(?:${CREDENTIAL_CORES.join('|')})[A-Z0-9_]*`

/**
 * A `holder.NAME` or `holder['NAME']` access, with the name captured, whatever
 * the holder is called and through an optional chain.
 *
 * Only literal member access is visible here. A computed key (`env[name]`), a
 * concatenated one, `Reflect.deleteProperty`, and dropping a name by
 * rest-destructuring all withhold nothing in the same way and are all
 * invisible to a source scan — deciding them needs a parser and a
 * constant-folding pass. The hermetic spawn below is what covers the mechanism
 * itself; this pattern only catches the spellings people actually reach for.
 */
const CREDENTIAL_ACCESS = `[A-Za-z_$][\\w$.?]*(?:\\.(${CREDENTIAL_NAME})\\b|\\[['"\`](${CREDENTIAL_NAME})['"\`]\\])`

/** Matches `delete env.PRIVATE_KEY` and its bracketed and optional-chained forms. */
const DELETES_A_CREDENTIAL = new RegExp(`delete\\s+${CREDENTIAL_ACCESS}`, 'u')

/**
 * Matches `env.PRIVATE_KEY = undefined`, which leaves the name unset for the
 * child's re-load exactly as a `delete` does — measured, not assumed: a child
 * reports the fixture value's full length for both, and length 0 only for
 * `= ''`.
 *
 * Covered because the convention this file enforces says to *set* a name
 * rather than delete it, and `undefined` is the one value that obeys the
 * letter of that while reopening the hole it closes.
 */
const BLANKS_A_CREDENTIAL = new RegExp(
  `${CREDENTIAL_ACCESS}\\s*=\\s*undefined\\b`,
  'u'
)

/** The credential `code` unsets, by either spelling, or `undefined` for none. */
const credentialUnsetBy = (code: string): string | undefined => {
  const match =
    DELETES_A_CREDENTIAL.exec(code) ?? BLANKS_A_CREDENTIAL.exec(code)

  return match?.[1] ?? match?.[2]
}

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

/** Blanks block comments, keeping line and column positions intact. */
const blankBlockComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))

/**
 * A line terminator between `delete` and its operand is legal grammar — the
 * spec puts no `[no LineTerminator here]` restriction there — so a per-line
 * scan would walk straight past `delete\n  env.PRIVATE_KEY`. Joining the
 * operand onto the keyword's line first also carries any trailing marker
 * comment with it, which keeps the exemption attached to its own delete.
 *
 * The whole member expression is collapsed, not just the gap after the
 * keyword, because prettier breaks a `delete` whose code alone passes 80
 * columns — across the dot, and across the brackets for a computed key.
 * Either leaves the holder alone as the statement (`delete process.env`),
 * carrying no name for the pattern to match.
 *
 * One limit the collapse introduces: a marker on a continuation line now
 * exempts the delete it was joined to. That is what carries the marker back
 * onto a statement prettier split, and there is no way to tell that case from
 * a marker parked on a continuation line to silence a neighbour. Reaching it
 * needs code no formatter would leave, and no shipped test is affected.
 */
const joinDeleteOperands = (source: string): string =>
  source
    .replace(
      /\bdelete\s+[A-Za-z_$][\w$]*(?:\s*\??\.\s*[\w$]+|\s*\??\.?\s*\[[^\]]*\])*/gu,
      (expression) =>
        `delete ${expression.replace(/^delete\s+/u, '').replace(/\s+/gu, '')}`
    )
    // The same break on the other spelling: prettier puts `undefined` on its
    // own line when the assignment passes 80 columns, leaving a statement that
    // ends at the `=` and carries no value to judge.
    .replace(/=\s*\n\s*undefined\b/gu, '= undefined')

/**
 * One entry per statement, not per line: a marker earns an exemption for the
 * unset it sits beside, and `a; b` on one line is two unsets of which only the
 * annotated one may pass.
 */
const statements = (source: string): string[] =>
  joinDeleteOperands(blankBlockComments(source))
    .split('\n')
    .flatMap((line) => line.split(';'))

/**
 * Statements that unset a credential and carry no marker.
 *
 * The marker is read before line comments are dropped, because the marker IS a
 * line comment; the drop then keeps prose that merely mentions a deletion —
 * a "never do this" example, say — from being reported as one.
 */
const unexemptedDeletions = (source: string): string[] =>
  statements(source).filter((statement) => {
    const unset = credentialUnsetBy(statement.replace(/\/\/.*$/u, ''))

    return (
      unset !== undefined &&
      !statement.includes(EXEMPTION_MARKER) &&
      // Judged on the name actually unset, never on the statement's text: a
      // reviewed non-credential mentioned anywhere else in the same statement
      // — a sibling condition, say — would otherwise exempt the real
      // credential being unset beside it.
      !NON_CREDENTIAL_NAMES.includes(unset)
    )
  })

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

  it('sees a delete prettier broke across the brackets', () => {
    // The computed-key half of the same formatter break. The collapse has to
    // reach across a newline inside the brackets, or this form reads as
    // `delete holder` — a clean result for the very shape it claims to cover.
    expect(
      unexemptedDeletions(
        "  delete childEnv[\n    'PRIVATE_KEY_PRODUCTION'\n  ]\n"
      )
    ).toEqual(["  delete childEnv['PRIVATE_KEY_PRODUCTION']"])
  })

  it('leaves a reviewed non-credential deletable without a marker', () => {
    // The scan and the sweep have to agree: this name matches a core but is
    // not withheld, so demanding a marker for it would be asking for a reason
    // to withhold something no class claims.
    expect(
      unexemptedDeletions('  delete env.NO_ETHERSCAN_API_KEY_REQUIRED\n')
    ).toEqual([])
    // Anchored, so a longer name is still judged on its cores.
    expect(
      unexemptedDeletions('  delete env.PRIVATE_KEY_ANVIL_PRODUCTION\n')
    ).toEqual(['  delete env.PRIVATE_KEY_ANVIL_PRODUCTION'])
  })

  it('does not let a non-credential elsewhere in the statement excuse one', () => {
    // The exemption is keyed on the name actually unset. Read off the
    // statement's text instead, a reviewed non-credential in a sibling
    // condition silently exempts the real credential being deleted beside it.
    expect(
      unexemptedDeletions(
        '  if (env.PRIVATE_KEY_ANVIL) delete env.PRIVATE_KEY_PRODUCTION\n'
      )
    ).toEqual([
      '  if (env.PRIVATE_KEY_ANVIL) delete env.PRIVATE_KEY_PRODUCTION',
    ])
  })

  it('sees a credential set to undefined, which unsets it as a delete does', () => {
    // The convention says to set rather than delete, and `undefined` is the
    // one value that keeps the letter of that while leaving the name unset for
    // the child's re-load. Both the flat and the prettier-broken spelling.
    expect(unexemptedDeletions('  env.PRIVATE_KEY = undefined\n')).toEqual([
      '  env.PRIVATE_KEY = undefined',
    ])
    expect(
      unexemptedDeletions(
        "  childEnv['PRIVATE_KEY_PRODUCTION'] =\n    undefined\n"
      )
    ).toEqual(["  childEnv['PRIVATE_KEY_PRODUCTION'] = undefined"])
  })

  it('sees a delete prettier broke across the dot', () => {
    // What the formatter produces from `delete process.env.X // marker` once
    // the comment pushes the line past 80 columns. Uncollapsed, the statement
    // reads `delete process.env`, which carries no name for the scan to match.
    expect(
      unexemptedDeletions(
        '        delete process.env\n          .PRIVATE_KEY\n'
      )
    ).toEqual(['        delete process.env.PRIVATE_KEY'])
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

  it('judges two deletes sharing one line separately', () => {
    // A marker sits at the end of the line, so a line-wide reading of it lets
    // one justified delete carry an unjustified neighbour past the guard.
    expect(
      unexemptedDeletions(
        `delete env.PRIVATE_KEY; delete env.MNEMONIC // ${EXEMPTION_MARKER} fixture cwd`
      )
    ).toEqual(['delete env.PRIVATE_KEY'])
  })

  it('does not report prose that merely mentions a deletion', () => {
    // Both comment shapes, because this file's own guidance is written in them:
    // describing the hazard must not be indistinguishable from committing it.
    expect(
      unexemptedDeletions('  // never write delete env.PRIVATE_KEY here\n')
    ).toEqual([])
    expect(
      unexemptedDeletions('/**\n * Not this: delete env.MNEMONIC\n */\n')
    ).toEqual([])
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
      // One real name per class, so a class dropped from the table in
      // `spawn-env.ts` goes red here rather than quietly narrowing the scan.
      'delete env.ETH_NODE_URI',
      'delete env.ETH_NODE_URI_ARBITRUM',
      'delete env.MAINNET_ETHERSCAN_API_KEY',
      'delete env.TRONGRID_API_KEY',
      'delete env.TENDERLY_ACCESS_KEY',
      'delete env.LEDGER_SYNC_TOKEN',
      'delete env.WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS',
      'delete env.SLACK_WEBHOOK_SC_GENERAL',
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
      // The empty string is a real value to the child, not an unset one —
      // pinned against a spawn below — so it is a legitimate way to clear a
      // name and must stay distinguishable from `= undefined`.
      "env.PRIVATE_KEY = ''",
      'delete env.NODE_ENV',
      'delete env.SAFE_PROPOSAL_TICKET',
      'delete env.ENVIRONMENT',
      'delete env.ENABLE_MONGODB_LOGGING',
      // The near misses no core must swallow: a list of token contracts is
      // not a `SYNC_TOKEN`, and neither a verification toggle nor a network
      // exclusion list is a key or an endpoint.
      'delete env.ALLOW_TOKEN_CONTRACTS',
      'delete env.DO_NOT_VERIFY_IN_THESE_NETWORKS',
      'delete env.ZKSYNC_NATIVE_VERIFIER',
    ])
      expect(DELETES_A_CREDENTIAL.test(source), source).toBe(false)
  })
})

describe('the guard and the withholding cannot disagree about a name', () => {
  it('withholds something for every core it scans for', () => {
    // The drift this pairing exists to stop, in the direction that matters: a
    // core the scan enforces but the sweep does not act on would put markers
    // on tests while handing children the real value.
    for (const core of CREDENTIAL_CORES)
      expect(withheldValueFor(`PREFIX_${core}_SUFFIX`), core).toBeDefined()
  })

  it('withholds nothing for a name no core claims', () => {
    // The paired absence: a `withheldValueFor` that returned a value for
    // everything would satisfy the assertion above while clobbering the whole
    // environment.
    for (const name of ['NODE_ENV', 'PRODUCTION', 'SALT', 'FOO_SECRET_SAUCE'])
      expect(withheldValueFor(name), name).toBeUndefined()
  })

  it('exempts the reviewed non-credentials from the sweep as well', () => {
    // These match a core and are deliberately not withheld, so the sweep must
    // leave them alone; the scan's own tolerance for them is asserted above.
    expect(NON_CREDENTIAL_NAMES.length).toBeGreaterThan(0)
    for (const name of NON_CREDENTIAL_NAMES)
      expect(withheldValueFor(name), name).toBeUndefined()
  })

  it('gives every URL-shaped class a scheme fetch refuses', () => {
    // The property, not the spelling: asserting the sentinel substring would
    // pass just as well for `https://hooks.slack.com/services/malformed-…`,
    // which a run that got past the check under test would really post to.
    for (const name of [
      'SC_MONGODB_URI',
      'ETH_NODE_URI_ARBITRUM',
      'WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS',
    ]) {
      const withheld = withheldValueFor(name)
      expect(withheld, name).toBeDefined()
      expect(new URL(withheld as string).protocol, name).not.toMatch(
        /^https?:$/u
      )
    }
  })

  it('gives the signing class a value viem cannot parse', () => {
    // The provider keys share this value, so one refusal covers both classes;
    // what a given explorer rejects is not decidable here.
    const signing = withheldValueFor('PRIVATE_KEY_PRODUCTION')
    if (signing === undefined)
      throw new Error('no class claims the signing key, so nothing is withheld')

    expect(() => privateKeyToAccount(signing as Hex)).toThrow()
    expect(withheldValueFor('MAINNET_ETHERSCAN_API_KEY')).toBe(signing)
  })

  it('pins exactly the names the sweep cannot be trusted to reach', () => {
    // The set, not a property of its members: a loop over the list cannot see
    // a name dropped FROM the list, and dropping one is the whole failure —
    // the Safe signer key is unset in the store, so the sweep never sees it
    // and this list is the only thing withholding it.
    expect([...ALWAYS_WITHHELD].sort()).toEqual([
      'MONGODB_URI',
      'PRIVATE_KEY',
      'PRIVATE_KEY_PRODUCTION',
      'SAFE_SIGNER_PRIVATE_KEY',
      'SC_MONGODB_URI',
    ])
    // And each must still be claimed by a class, or the pin sets nothing.
    for (const name of ALWAYS_WITHHELD)
      expect(withheldValueFor(name), name).toBeDefined()
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
      timeout: 20_000, // 20 seconds: a hermetic child that has to spawn bun
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

  it('re-loads a name set to undefined, and does not for an empty string', () => {
    // Why the scan treats `= undefined` as a deletion and `= ''` as a value.
    // Both obey the convention's letter — neither is a `delete` — but only one
    // of them actually keeps the file's value out of the child.
    expect(lengthInChild((env) => (env[NAME] = undefined as never))).toBe(
      String(FIXTURE_VALUE.length)
    )
    expect(lengthInChild((env) => (env[NAME] = ''))).toBe('0')
  })
})

describe('withholdCredentials withholds each class from a real child', () => {
  /**
   * End to end: a fixture `.env` a child would
   * re-load, a `withholdCredentials` pass over the environment it is handed,
   * and the child reporting back what it actually sees. Synthetic values
   * throughout, lengths only.
   *
   * Asserted against the class values rather than against "not the fixture",
   * because a child that saw `undefined` would also satisfy the weaker form
   * while the child in the real probes would be re-loading the store.
   */
  const FIXTURE = {
    // A query string, which is the shape most of the store's endpoints have;
    // the writer below quotes every value so the `&` survives the re-load.
    ETH_NODE_URI_ZZPROBE: 'https://probe.invalid/x?chain=1&dkey=from-fixture',
    MAINNET_ETHERSCAN_API_KEY: 'explorer-key-from-fixture',
    WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS: 'webhook-from-fixture',
    NO_ETHERSCAN_API_KEY_REQUIRED: 'true',
  } as const

  const fixture = mkdtempSync(join(tmpdir(), 'spawn-env-classes-'))
  writeFileSync(
    join(fixture, '.env'),
    Object.entries(FIXTURE)
      .map(([name, value]) => `${name}="${value}"\n`)
      .join('')
  )
  const child = join(fixture, 'report-lengths.ts')
  writeFileSync(
    child,
    `const names = ${JSON.stringify(Object.keys(FIXTURE))}\n` +
      'console.log(\n' +
      '  JSON.stringify(\n' +
      '    Object.fromEntries(\n' +
      '      names.map((n) => [\n' +
      '        n,\n' +
      "        process.env[n] === undefined ? 'undefined' : process.env[n].length,\n" +
      '      ])\n' +
      '    )\n' +
      '  )\n' +
      ')\n'
  )

  afterAll(() => rmSync(fixture, { force: true, recursive: true }))

  /** What the child reports each name's length to be, given `present` in env. */
  const lengthsInChild = (
    present: Record<string, string>
  ): Record<string, number | string> => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...present,
    }
    delete env.NODE_ENV
    withholdCredentials(env)

    const result = Bun.spawnSync([process.execPath, child], {
      cwd: fixture,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000, // 20 seconds: a hermetic child that has to spawn bun
    })
    if (result.signalCode)
      throw new Error(
        `child killed by ${result.signalCode}, so its output proves nothing`
      )

    return JSON.parse(result.stdout.toString().trim())
  }

  it('replaces an endpoint, a provider key and a webhook the parent holds', () => {
    const lengths = lengthsInChild(FIXTURE)

    for (const name of [
      'ETH_NODE_URI_ZZPROBE',
      'MAINNET_ETHERSCAN_API_KEY',
      'WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS',
    ] as const) {
      const withheld = withheldValueFor(name)
      expect(withheld, name).toBeDefined()
      expect(lengths[name], name).toBe((withheld as string).length)
      // The paired negative: equal lengths would let a coincidence pass.
      expect(lengths[name], name).not.toBe(FIXTURE[name].length)
    }
  })

  it('leaves a reviewed non-credential at the value it was given', () => {
    // Withholding this one would hand a verification run a key that looks
    // present, which is a behaviour change rather than a withholding.
    expect(lengthsInChild(FIXTURE).NO_ETHERSCAN_API_KEY_REQUIRED).toBe(
      FIXTURE.NO_ETHERSCAN_API_KEY_REQUIRED.length
    )
  })

  it('does NOT cover a name the spawning process does not hold', () => {
    // The documented limit of the sweep, asserted rather than described: it can
    // only replace names in the environment it is handed, and the child
    // re-loads the file for every name that environment leaves unset. The five
    // names in `ALWAYS_WITHHELD` are the ones pinned against this; every other
    // class depends on the parent having loaded the store.
    const lengths = lengthsInChild({})

    expect(lengths.ETH_NODE_URI_ZZPROBE).toBe(
      FIXTURE.ETH_NODE_URI_ZZPROBE.length
    )
  })

  it('withholds the pinned names even when the parent does not hold them', () => {
    // The other side of that limit: these five do not depend on the parent, so
    // a child spawned from a process with no store loaded still cannot re-load
    // them.
    const pinned = 'PRIVATE_KEY_PRODUCTION'
    const env: Record<string, string> = {}
    withholdCredentials(env)

    expect(env[pinned]).toBeDefined()
    expect(env[pinned]).toContain('malformed-in-tests')
  })
})
