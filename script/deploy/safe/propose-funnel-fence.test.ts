/**
 * Whether anything other than the blessed wrapper can reach the Safe-proposal
 * storage function — and whether the rule that says so actually runs.
 *
 * Each case feeds a candidate call site to the real ESLint CLI on stdin under a
 * virtual path, so nothing is written into the tree: a probe file left behind by
 * a crashed run would itself fail the fence in CI.
 *
 * `propose-safe-tx.test.ts` covers what the wrapper does once a caller is
 * through it.
 */

import { readdirSync, readFileSync } from 'fs'
import { extname, join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const FENCE_CONFIG = './.eslintrc.funnel-fence.cjs'
const WORKFLOW = '.github/workflows/enforceProposalFunnel.yml'

/** Extensions ESLint can parse as a module, so any of them could carry a route. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']

/** The identifying fragment of the fence's message, not the whole paragraph. */
const REFUSAL = 'Safe proposals are created through proposeSafeTx()'

/** 90 seconds: an ESLint run plus a cold bun start, well short of a hang. */
const TIMEOUT_MS = 90_000

/**
 * Lints `source` as if it were the file at `virtualPath`.
 *
 * @param source - the candidate call site
 * @param virtualPath - repo-relative path it is judged as, which is what the
 *   allowlist matches on
 * @param useRepoConfig - lint with the repo-wide config instead of the fence's
 *   own, to show the fence is reachable from the config a commit is linted with
 */
const lint = async (
  source: string,
  virtualPath: string,
  useRepoConfig = false
): Promise<{ exitCode: number; output: string }> => {
  const args = useRepoConfig
    ? ['--stdin', '--stdin-filename', virtualPath]
    : [
        '--no-eslintrc',
        '-c',
        FENCE_CONFIG,
        // The flag CI runs with. Without it the cases below that carry an
        // `eslint-disable` would pass while the fence had judged nothing.
        '--no-inline-config',
        '--stdin',
        '--stdin-filename',
        virtualPath,
      ]

  // Async rather than `Bun.spawnSync`, whose options type pins stdin to
  // 'ignore': feeding the candidate on stdin is the point of this helper.
  const proc = Bun.spawn(['bunx', 'eslint', ...args], {
    cwd: REPO_ROOT,
    env: process.env as Record<string, string>,
    stdin: Buffer.from(source),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (proc.signalCode !== null && proc.signalCode !== undefined)
    throw new Error(
      `eslint was killed by ${proc.signalCode}, so its verdict proves nothing`
    )

  return { exitCode: proc.exitCode ?? -1, output: `${stdout}${stderr}` }
}

const BYPASS_PATH = 'script/tasks/proposeSomethingNew.ts'

describe('the funnel fence refuses a new propose route', () => {
  it(
    'refuses a plain import of the storage function',
    async () => {
      const result = await lint(
        `import { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a namespace member access, which an import restriction would miss',
    async () => {
      const result = await lint(
        `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
          `export const propose = safeUtils.storeTransactionInMongoDB\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a computed lookup, where the name is a string rather than an identifier',
    async () => {
      const result = await lint(
        `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
          `export const propose = safeUtils['storeTransactionInMongoDB']\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a template-literal lookup, which is neither an identifier nor a string',
    async () => {
      const result = await lint(
        `import * as safeUtils from '../deploy/safe/safe-utils'\n` +
          'export const propose = safeUtils[`storeTransactionInMongoDB`]\n',
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses an aliased import, which renames the funnel but not the reference',
    async () => {
      const result = await lint(
        `import { storeTransactionInMongoDB as persist } from '../deploy/safe/safe-utils'\n` +
          `export const propose = persist\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a dynamic import, which no import declaration carries',
    async () => {
      const result = await lint(
        `export const propose = async () =>\n` +
          `  (await import('../deploy/safe/safe-utils')).storeTransactionInMongoDB\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a file that disables the rule on itself',
    async () => {
      // An `eslint-disable` is the one rewrite people reach for by habit; the
      // suites in this directory already carry one for another rule.
      const result = await lint(
        `/* eslint-disable no-restricted-syntax */\n` +
          `import { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a route written at a module extension the repo-wide globs miss',
    async () => {
      const result = await lint(
        `import { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        'script/tasks/proposeSomethingNew.mjs'
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'refuses a re-export, so the name cannot be laundered through a third file',
    async () => {
      const result = await lint(
        `export { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )
})

describe('the allowlist is only what it claims to be', () => {
  it(
    'refuses the owner-change script, which the allowlist does not name',
    async () => {
      const result = await lint(
        `import { storeTransactionInMongoDB } from './safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        'script/deploy/safe/add-safe-owners-and-threshold.ts'
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it('grants no exemption beyond the files named in the config', async () => {
    const config = (await import(
      join(REPO_ROOT, '.eslintrc.funnel-fence.cjs')
    )) as { default: { overrides: { files: string[] }[] } }

    const allowed = config.default.overrides.flatMap(
      (override) => override.files
    )

    // Length and membership rather than a fixed order, so widening the
    // allowlist still fails here while reordering or retiring an entry does not.
    expect(allowed).toHaveLength(5)
    expect(allowed.sort()).toEqual(
      [
        '.eslintrc.funnel-fence.cjs',
        'script/deploy/safe/safe-utils.ts',
        'script/deploy/safe/propose-safe-tx.ts',
        'script/deploy/safe/safe-utils.test.ts',
        'script/deploy/tron/propose-to-safe-tron.ts',
      ].sort()
    )
  })
})

describe('the funnel fence lets compliant code through', () => {
  it(
    'accepts a new call site that goes through the wrapper',
    async () => {
      // Without this, a fence that refused every file would pass every case above.
      const result = await lint(
        `import { proposeSafeTx } from '../deploy/safe/propose-safe-tx'\n` +
          `export const propose = proposeSafeTx\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).toBe(0)
      expect(result.output).not.toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'accepts the wrapper itself, which is the one file allowed to name it',
    async () => {
      const result = await lint(
        `import { storeTransactionInMongoDB } from './safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        'script/deploy/safe/propose-safe-tx.ts'
      )

      expect(result.exitCode).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'leaves a mention in a comment alone',
    async () => {
      // Comments carry no identifier node. A text scan would refuse this.
      const result = await lint(
        `/** See storeTransactionInMongoDB for what the funnel ends in. */\n` +
          `export const propose = 1\n`,
        BYPASS_PATH
      )

      expect(result.exitCode).toBe(0)
    },
    TIMEOUT_MS
  )
})

describe('the fence runs where it has to run', () => {
  it(
    'fires through the repo-wide config, so a commit cannot land one',
    async () => {
      // A path that exists: the repo-wide config resolves types from
      // `tsconfig.eslint.json`, whose include is a filesystem glob, so a virtual
      // filename with no file behind it fails to parse before any rule runs.
      const result = await lint(
        `import { storeTransactionInMongoDB } from '../deploy/safe/safe-utils'\n` +
          `export const propose = storeTransactionInMongoDB\n`,
        'script/tasks/proposeFraxChainIdMappings.ts',
        true
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain(REFUSAL)
    },
    TIMEOUT_MS
  )

  it(
    'is the command CI runs, and that command passes on this tree',
    async () => {
      const result = Bun.spawnSync(['bun', 'lint:funnel'], {
        cwd: REPO_ROOT,
        env: process.env as Record<string, string>,
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
      expect(output).toContain('.eslintrc.funnel-fence.cjs')
    },
    TIMEOUT_MS
  )

  it('sweeps every module extension a propose route could be written at', () => {
    const script = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts['lint:funnel']
    if (!script) throw new Error('package.json declares no lint:funnel script')

    // A directory sweep judges only the extensions it is given, and the flag is
    // what the stdin cases above cannot prove about the traversal. Measured
    // against what the tree actually holds — `.mjs` is in use today — rather
    // than against a list written here.
    const present = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name))
        else if (MODULE_EXTENSIONS.includes(extname(entry.name)))
          present.add(extname(entry.name))
      }
    }
    walk(join(REPO_ROOT, 'script'))
    expect(present.size).toBeGreaterThan(0)

    const swept = (/--ext\s+(\S+)/.exec(script)?.[1] ?? '').split(',')
    for (const ext of present) expect(swept).toContain(ext)
    expect(script).toContain('--no-inline-config')
  })
})
