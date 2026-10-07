/**
 * Whether anything other than the blessed wrapper can reach the Safe-proposal
 * storage function — and whether the fence that says so actually runs.
 *
 * Each case judges a candidate call site in memory under a virtual path, so
 * nothing is written into the tree: a probe file left behind by a crashed run
 * would itself fail the fence in CI.
 *
 * `propose-safe-tx.test.ts` covers what the wrapper does once a caller is
 * through it.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { extname, join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { findViolations, MODULE_EXTENSIONS } from '../../utils/fence-runner'

import { FUNNEL_ALLOWLIST, FUNNEL_FENCE } from './funnel-fence'
import { withholdCredentials } from './spawn-env'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const FENCE_SCRIPT = 'script/deploy/safe/funnel-fence.ts'
const WORKFLOW = '.github/workflows/enforceProposalFunnel.yml'

/** The identifying fragment of the fence's message, not the whole paragraph. */
const REFUSAL = 'Safe proposals are created through proposeSafeTx()'

/** 90 seconds: a tsx run over the tree plus a cold bun start, well short of a hang. */
const TIMEOUT_MS = 90_000

const PACKAGE_JSON = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
) as {
  scripts: Record<string, string>
  'lint-staged': Record<string, string[]>
}

/** The `*.{ts,js}` lint-staged commands, in the order a commit runs them. */
const LINT_STAGED_TS = PACKAGE_JSON['lint-staged']['*.{ts,js}'] ?? []

/** The lint-staged entry that runs this fence on the staged files. */
const STAGED_FENCE = LINT_STAGED_TS.find((command) =>
  command.includes(FENCE_SCRIPT)
)

const lint = (source: string, virtualPath: string): string =>
  findViolations(FUNNEL_FENCE, source, virtualPath).join('\n')

const spawnEnv = (): Record<string, string> => {
  const env = { ...process.env } as Record<string, string>
  withholdCredentials(env)
  // `bun test` sets NODE_ENV=test, under which consola drops the success summary
  // the CI run prints; the child should log as it does in CI.
  env['NODE_ENV'] = 'development'
  return env
}

const BYPASS_PATH = 'script/tasks/proposeSomethingNew.ts'

const DIRECT_IMPORT =
  `import { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n` +
  `export const propose = storeTransactionInMongoDB\n`

describe('the funnel fence refuses a new propose route', () => {
  const REFUSED: Array<[string, string, string]> = [
    ['a plain import of the storage function', DIRECT_IMPORT, BYPASS_PATH],
    [
      'a namespace member access, which an import restriction would miss',
      `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
        `export const propose = safeUtils.storeTransactionInMongoDB\n`,
      BYPASS_PATH,
    ],
    [
      'a computed lookup, where the name is a string rather than an identifier',
      `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
        `export const propose = safeUtils['storeTransactionInMongoDB']\n`,
      BYPASS_PATH,
    ],
    [
      'a template-literal lookup, which is neither an identifier nor a string',
      `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
        'export const propose = safeUtils[`storeTransactionInMongoDB`]\n',
      BYPASS_PATH,
    ],
    [
      'a template lookup padded with an empty substitution before the name',
      `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
        // eslint-disable-next-line no-template-curly-in-string -- module source under test, not a template
        'export const propose = safeUtils[`storeTransactionInMongoDB${""}`]\n',
      BYPASS_PATH,
    ],
    [
      'a template lookup padded with an empty substitution after the name',
      `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
        // eslint-disable-next-line no-template-curly-in-string -- module source under test, not a template
        'export const propose = safeUtils[`${""}storeTransactionInMongoDB`]\n',
      BYPASS_PATH,
    ],
    [
      'a template lookup with the name between two empty substitutions',
      `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
        // eslint-disable-next-line no-template-curly-in-string -- module source under test, not a template
        'export const propose = safeUtils[`${""}storeTransactionInMongoDB${""}`]\n',
      BYPASS_PATH,
    ],
    [
      'an aliased import, which renames the funnel but not the reference',
      `import { storeTransactionInMongoDB as persist } from '../deploy/safe/safe-utils'\n` +
        `export const propose = persist\n`,
      BYPASS_PATH,
    ],
    [
      'a dynamic import, which no import declaration carries',
      `export const propose = async () =>\n` +
        `  (await import('../deploy/safe/safe-utils')).storeTransactionInMongoDB\n`,
      BYPASS_PATH,
    ],
    [
      // An `eslint-disable` is the one rewrite people reach for by habit; the
      // suites in this directory already carry one for another rule.
      'a file that disables the rule on itself',
      `/* eslint-disable no-restricted-syntax */\n${DIRECT_IMPORT}`,
      BYPASS_PATH,
    ],
    [
      'a file that disables oxlint on itself',
      `/* oxlint-disable */\n${DIRECT_IMPORT}`,
      BYPASS_PATH,
    ],
    [
      'a route written at a module extension the repo-wide globs miss',
      DIRECT_IMPORT,
      'script/tasks/proposeSomethingNew.mjs',
    ],
    [
      'a route written as CommonJS',
      `const { storeTransactionInMongoDB } = require('../deploy/safe/safe-utils')\n` +
        `module.exports = storeTransactionInMongoDB\n`,
      'script/tasks/proposeSomethingNew.cts',
    ],
    [
      'a re-export, so the name cannot be laundered through a third file',
      `export { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n`,
      BYPASS_PATH,
    ],
  ]

  it.each(REFUSED)('refuses %s', (_name, source, virtualPath) => {
    expect(lint(source, virtualPath)).toContain(REFUSAL)
  })
})

describe('the allowlist is only what it claims to be', () => {
  it('refuses the owner-change script, which the allowlist does not name', () => {
    expect(
      lint(
        `import { storeTransactionInMongoDB } from './safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        'script/deploy/safe/add-safe-owners-and-threshold.ts'
      )
    ).toContain(REFUSAL)
  })

  it('grants no exemption beyond the files named in the fence', () => {
    // Length and membership rather than a fixed order, so widening the
    // allowlist still fails here while reordering or retiring an entry does not.
    expect(FUNNEL_ALLOWLIST).toHaveLength(5)
    expect([...FUNNEL_ALLOWLIST].sort()).toEqual(
      [
        'script/deploy/safe/funnel-fence.ts',
        'script/deploy/safe/safe-utils.ts',
        'script/deploy/safe/propose-safe-tx.ts',
        'script/deploy/safe/safe-utils.test.ts',
        'script/deploy/tron/propose-to-safe-tron.ts',
      ].sort()
    )
  })
})

describe('the funnel fence lets compliant code through', () => {
  it('accepts a new call site that goes through the wrapper', () => {
    // Without this, a fence that refused every file would pass every case above.
    expect(
      lint(
        `import { proposeSafeTx } from '../deploy/safe/propose-safe-tx'\n` +
          `export const propose = proposeSafeTx\n`,
        BYPASS_PATH
      )
    ).toBe('')
  })

  it('accepts the wrapper itself, which is the one file allowed to name it', () => {
    expect(
      lint(
        `import { storeTransactionInMongoDB } from './safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        'script/deploy/safe/propose-safe-tx.ts'
      )
    ).toBe('')
  })

  it('leaves a mention in a comment alone', () => {
    // Comments carry no syntax node. A text scan would refuse this.
    expect(
      lint(
        `/** See storeTransactionInMongoDB for what the funnel ends in. */\n` +
          `export const propose = 1\n`,
        BYPASS_PATH
      )
    ).toBe('')
  })
})

describe('the fence runs where it has to run', () => {
  it('runs on staged files with the command CI runs on the tree', () => {
    // `bun lint:funnel` is this entry plus the tree to sweep.
    expect(STAGED_FENCE).toBeDefined()
    expect(PACKAGE_JSON.scripts['lint:funnel']).toBe(`${STAGED_FENCE} .`)
  })

  it('runs after the fixers and before the type check in lint-staged', () => {
    // A fixer after the fence would commit code the fence never judged.
    const position = (fragment: string): number =>
      LINT_STAGED_TS.findIndex((command) => command.includes(fragment))

    expect(position('prettier --write')).toBe(0)
    expect(position('oxlint')).toBe(1)
    expect(position(FENCE_SCRIPT)).toBe(2)
    expect(position('script/utils/node-runtime-fence.ts')).toBe(3)
    expect(position('typecheck-files.sh')).toBe(4)
  })

  it(
    'fires through the lint-staged entry, so a commit cannot land one',
    () => {
      if (!STAGED_FENCE)
        throw new Error('package.json lint-staged has no funnel-fence entry')

      // Outside the tree, so a crashed run leaves nothing the CI sweep would see.
      const dir = mkdtempSync(join(tmpdir(), 'funnel-fence-'))
      try {
        const file = join(dir, 'proposeSomethingNew.ts')
        writeFileSync(
          file,
          `/* eslint-disable no-restricted-syntax */\n${DIRECT_IMPORT}`
        )

        const result = Bun.spawnSync([...STAGED_FENCE.split(' '), file], {
          cwd: REPO_ROOT,
          env: spawnEnv(),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: TIMEOUT_MS,
        })

        expect(result.exitCode).not.toBe(0)
        expect(
          `${result.stdout.toString()}${result.stderr.toString()}`
        ).toContain(REFUSAL)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS
  )

  it(
    'is the command CI runs, and that command passes on this tree',
    () => {
      const result = Bun.spawnSync(['bun', 'lint:funnel'], {
        cwd: REPO_ROOT,
        env: spawnEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: TIMEOUT_MS,
      })

      const output = `${result.stdout.toString()}${result.stderr.toString()}`
      expect(result.exitCode).toBe(0)

      const workflow = readFileSync(join(REPO_ROOT, WORKFLOW), 'utf8')
      expect(workflow).toContain('run: bun lint:funnel')
      // A job the fence's verdict can be skipped or downgraded through would report
      // green without having judged anything.
      expect(workflow).not.toContain('continue-on-error')
      expect(workflow).not.toContain('paths:')
      expect(workflow).not.toContain('outputs')
      // Paired with the exit code above: a script that does not exist also exits
      // non-zero, and one wired to something else would pass while judging nothing.
      expect(output).toMatch(
        /funnel fence: [1-9]\d* file\(s\) checked, 0 refused/
      )
    },
    TIMEOUT_MS
  )

  it('judges every module extension a propose route could be written at', () => {
    // Measured against what the tree actually holds — `.mjs` is in use today —
    // rather than against a list written here.
    const present = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name))
        else present.add(extname(entry.name))
      }
    }
    walk(join(REPO_ROOT, 'script'))
    walk(join(REPO_ROOT, 'tasks'))

    const moduleLike = [...present].filter((ext) =>
      /^\.[cm]?[jt]sx?$/.test(ext)
    )
    expect(moduleLike.length).toBeGreaterThan(0)
    for (const ext of moduleLike) expect(MODULE_EXTENSIONS).toContain(ext)
  })
})
