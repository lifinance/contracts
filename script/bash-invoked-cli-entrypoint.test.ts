/**
 * Guards the CLIs that bash invokes via `bunx tsx` against `import.meta.main`.
 *
 * `tsx` drops `import.meta.main` for a `.ts` entry module, so a guard spelled
 * that way never fires: the process exits 0 having done nothing. A bash caller
 * reads that exit 0 as success — `sendOrPropose` reported a Safe proposal it had
 * never created, on every Tron production rollout, until EXSC-1087.
 *
 * Scope is the closed set of modules a shell script runs this way, rather than
 * the whole tree: those are the ones whose silent `exit 0` is laundered into a
 * success by a caller that cannot tell the difference. The remaining shipped
 * modules still carrying the guard are tracked in EXSC-971, and asserting over
 * them here would only encode a baseline (see `bun-only-api-placement.test.ts`,
 * which makes the same scoping argument for `import.meta.dir`).
 *
 * A source assertion rather than a behavioural one, for the reason that file
 * gives: `bun test` provides the API, so under a test runner the offending line
 * works. Spawning the CLI from a test does not help either — `bunx tsx` launched
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

/** Every `bunx tsx <module>.ts` a tracked shell script runs. */
const bashInvokedClis = (): string[] => {
  const shellScripts = execFileSync('git', ['ls-files', 'script', 'tasks'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.endsWith('.sh'))

  const found = new Set<string>()
  for (const script of shellScripts) {
    const source = readFileSync(join(REPO_ROOT, script), 'utf8')
    for (const match of source.matchAll(/bunx\s+tsx\s+([\w./-]+\.ts)/g)) {
      const cli = match[1]
      if (cli === undefined) continue
      const normalized = cli.replace(/^\.\//, '')
      if (existsSync(join(REPO_ROOT, normalized))) found.add(normalized)
    }
  }
  return [...found].sort()
}

describe('no bash-invoked CLI guards its entry on import.meta.main', () => {
  it('finds the CLIs at all, so a clean result is not vacuous', () => {
    expect(bashInvokedClis().length).toBeGreaterThan(5)
  })

  it('finds no bash-invoked CLI reading import.meta.main', () => {
    const offenders = bashInvokedClis().filter((path) =>
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
})
