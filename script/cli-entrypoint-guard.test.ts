/**
 * Guards the CLIs that a non-interactive caller runs via `bunx tsx` against
 * `import.meta.main`.
 *
 * Whether that guard fires depends on the runtime `bunx` hands the `tsx` bin to,
 * which is not a property of the repo: measured `undefined` under the pinned tsx
 * on Node 18.20.8, 22.23.2 and 26.8.1 alike (see `script/utils/is-entrypoint.ts`),
 * yet CI run 35696395137 on bun 1.3.13 shows `bunx tsx healthCheckAllNetworks.ts`
 * reaching code behind the guard. So the same line is live on one machine and a
 * silent `exit 0` on the next, and neither is a state the repo pins.
 *
 * A caller that cannot tell `exit 0` from real work launders that no-op into a
 * success: `sendOrPropose` reported a Safe proposal it had never created, on
 * every Tron production rollout, until EXSC-1087. Scope is the set of such
 * callers - shell scripts, GitHub workflow steps, and `package.json` scripts -
 * rather than the whole tree, because a module a human imports or runs by hand
 * reports its own silence. The remaining shipped modules still carrying the
 * guard are tracked in EXSC-971, and asserting over them here would only encode
 * a baseline (see `bun-only-api-placement.test.ts`, which makes the same scoping
 * argument for `import.meta.dir`).
 *
 * A source assertion rather than a behavioural one, for the reason that file
 * gives: `bun test` provides the API, so under a test runner the offending line
 * works. Spawning the CLI from a test does not help either - `bunx tsx` launched
 * from inside `bun test` returns no output at all, whichever spawn API is used.
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Matches a read of the API, not a mention of it: `assert-direct-broadcast-gate.ts`
 * documents in a comment why it does not use `import.meta.main`, and must not be
 * reported. The lookbehind keeps an unrelated `foo.import.meta.main` from matching.
 */
const IMPORT_META_MAIN = /(?<!\.)\bimport\s*\.\s*meta\s*\.\s*main\b/

/** Strips line and block comments so only executable text is inspected. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * Drops whole-line `#` comments from shell and YAML, so a commented-out
 * invocation does not put a CLI in scope on the strength of dead text
 * (`playgroundHelpers.sh` carries one for `propose-to-safe.ts`). Trailing `#` is
 * left alone: it is indistinguishable from a `#` inside a quoted string here,
 * and a live invocation never sits behind one.
 */
const stripHashComments = (source: string): string =>
  source.replace(/^[ \t]*#.*$/gm, '')

/** Joins `\`-continued lines, so an invocation split across them still matches. */
const joinContinuations = (source: string): string =>
  source.replace(/\\\r?\n[ \t]*/g, ' ')

/**
 * The invoked module, skipping any `tsx` flags. Deliberately captures a bare
 * token rather than a `.ts`-shaped one, so a form this scan cannot resolve
 * surfaces as an unresolved entry instead of silently leaving the guarded set.
 */
const TSX_INVOCATION = /bunx\s+tsx\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(\S+)/g

/** Peels the shell/YAML punctuation a bare-token capture drags in (`...ts);`). */
const trimDelimiters = (target: string): string =>
  target.replace(/^['"`]+/, '').replace(/['"`);\],&|]+$/, '')

/**
 * The repo's tracked files under the given paths.
 *
 * @param paths - path specs to list, as `git ls-files` takes them.
 * @returns repo-relative paths, with the trailing empty line dropped.
 */
const trackedFiles = (...paths: string[]): string[] =>
  execFileSync('git', ['ls-files', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.length > 0)

/** Every source a non-interactive caller's `bunx tsx` invocations can hide in. */
const callerSources = (): string[] => {
  const sources = trackedFiles('script', 'tasks')
    .filter((path) => path.endsWith('.sh'))
    .map((path) =>
      stripHashComments(readFileSync(join(REPO_ROOT, path), 'utf8'))
    )

  for (const path of trackedFiles('.github/workflows'))
    if (path.endsWith('.yml') || path.endsWith('.yaml'))
      sources.push(
        stripHashComments(readFileSync(join(REPO_ROOT, path), 'utf8'))
      )

  const packageJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  ) as { scripts?: Record<string, string> }
  sources.push(...Object.values(packageJson.scripts ?? {}))

  return sources.map(joinContinuations)
}

interface IScannedClis {
  /** Repo-relative paths of the modules in scope. */
  resolved: string[]
  /** Invocation targets that do not name a file in the repo - a rename, or a variable. */
  unresolved: string[]
}

/** Every `bunx tsx <module>` a non-interactive caller runs. */
const scanClis = (): IScannedClis => {
  const resolved = new Set<string>()
  const unresolved = new Set<string>()

  for (const source of callerSources())
    for (const match of source.matchAll(TSX_INVOCATION)) {
      const target = match[1]
      if (target === undefined) continue
      const normalized = trimDelimiters(target).replace(/^\.\//, '')
      if (existsSync(join(REPO_ROOT, normalized))) resolved.add(normalized)
      else unresolved.add(target)
    }

  return { resolved: [...resolved].sort(), unresolved: [...unresolved].sort() }
}

/**
 * CLIs whose presence proves the scan still reaches each kind of caller. Losing
 * one to a renamed path or an unmatched invocation form is the failure a count
 * threshold cannot see.
 */
const EXPECTED_CLIS = [
  // shell
  'script/deploy/safe/propose-to-safe.ts',
  'script/deploy/tron/propose-to-safe-tron.ts',
  // GitHub workflow
  'script/deploy/healthCheckAllNetworks.ts',
  'script/tasks/checkDeploymentAddressConsistency.ts',
  // package.json script
  'script/deploy/healthCheck.ts',
  'script/deploy/deployer-key-power.ts',
]

describe('no non-interactive CLI guards its entry on import.meta.main', () => {
  it('still reaches every kind of caller, so a clean result is not vacuous', () => {
    const { resolved } = scanClis()
    expect(resolved).toEqual(expect.arrayContaining(EXPECTED_CLIS))
  })

  it('resolves every invocation it finds, so none leaves the set unnoticed', () => {
    expect(scanClis().unresolved).toEqual([])
  })

  it('finds no non-interactive CLI reading import.meta.main', () => {
    const offenders = scanClis().resolved.filter((path) =>
      IMPORT_META_MAIN.test(
        stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'))
      )
    )

    expect(offenders).toEqual([])
  })

  it('matches a real read but not a comment that names the API', () => {
    expect(
      IMPORT_META_MAIN.test(stripComments('if (import.meta.main) run()'))
    ).toBe(true)
    expect(
      IMPORT_META_MAIN.test(
        stripComments('// not import.meta.main: tsx drops it')
      )
    ).toBe(false)
    expect(
      IMPORT_META_MAIN.test(stripComments('/* import.meta.main is dropped */'))
    ).toBe(false)
  })

  it('ignores a commented-out invocation but reads a continued one', () => {
    expect(
      stripHashComments('  # bunx tsx script/gone.ts\nbunx tsx script/live.ts')
    ).not.toContain('gone.ts')
    expect(
      [
        ...joinContinuations('bunx tsx \\\n  script/live.ts').matchAll(
          TSX_INVOCATION
        ),
      ][0]?.[1]
    ).toBe('script/live.ts')
    expect(
      [...'bunx tsx --no-cache script/live.ts'.matchAll(TSX_INVOCATION)][0]?.[1]
    ).toBe('script/live.ts')
  })
})
