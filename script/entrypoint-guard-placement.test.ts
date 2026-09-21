/**
 * Guards every shipped module under `script/` and `tasks/` against the two ways an entry-point
 * check gets spelled wrong here. Both fail identically: the CLI exits 0 having done nothing, which
 * an operator cannot tell apart from a real empty result.
 *
 * `import.meta.main` is the spelling that fires today. `tsx` drops it for `.ts` entry modules, so
 * it is `undefined` on every Node version we run, and every CLI here is a `.ts` file invoked via
 * `bunx tsx` (see `200-typescript.md`). EXSC-1039 is what that cost: `bun healthcheck` and the
 * daily all-networks sweep both ran zero invariants and reported success.
 *
 * A hand-rolled `process.argv[1]` compare is the spelling that lies in wait. Node realpaths
 * `import.meta.url` as it loads while argv[1] stays as the user typed it, so the compare answers
 * `false` for a direct run through any symlinked path component — and a `.endsWith('cli.ts')`
 * variant answers `true` for an unrelated file of the same basename. `isEntrypoint` realpaths both
 * sides and `is-entrypoint.test.ts` pins those cases, so one spelling means one place to fix them.
 *
 * A behavioural test cannot catch either: under `bun test` the module is not the entrypoint, so
 * the guard is correctly `false` however it is spelled. Hence a source assertion.
 */

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/** The one module allowed to read the entry path: every other module asks it instead. */
const ENTRYPOINT_HELPER = 'script/utils/is-entrypoint.ts'

/**
 * Matches a read of the API, not a mention of it — `utils/is-entrypoint.ts` names
 * `import.meta.main` in prose to explain why it does not use it. The lookbehind keeps an
 * unrelated `foo.import.meta.main` from matching.
 */
const IMPORT_META_MAIN = /(?<!\.)\bimport\s*\.\s*meta\s*\.\s*main\b/

/** Any read of the entry path, whichever way the hand-rolled compare then spells itself. */
const PROCESS_ARGV_ENTRY = /\bprocess\s*\.\s*argv\s*\[\s*1\s*\]/

/** Strips line and block comments so only executable text is inspected. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Tracked, non-test TS modules — the files that actually run under `tsx`. */
const shippedScriptModules = (): string[] =>
  execFileSync('git', ['ls-files', 'script', 'tasks'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))

const modulesMatching = (pattern: RegExp): string[] =>
  shippedScriptModules().filter((path) =>
    pattern.test(stripComments(readFileSync(join(REPO_ROOT, path), 'utf8')))
  )

describe('every entry guard is spelled isEntrypoint(import.meta.url)', () => {
  it('enumerates the tree, so a clean result is not vacuous', () => {
    expect(shippedScriptModules().length).toBeGreaterThan(200)
  })

  it('finds no non-test module reading import.meta.main', () => {
    expect(modulesMatching(IMPORT_META_MAIN)).toEqual([])
  })

  it('finds the entry path read only by the helper itself', () => {
    expect(modulesMatching(PROCESS_ARGV_ENTRY)).toEqual([ENTRYPOINT_HELPER])
  })

  it('matches a real read but not a comment that names the API', () => {
    expect(
      IMPORT_META_MAIN.test(
        stripComments('if (import.meta.main) runMain(main)')
      )
    ).toBe(true)
    expect(
      IMPORT_META_MAIN.test(stripComments('// not `import.meta.main`: tsx'))
    ).toBe(false)
    expect(
      IMPORT_META_MAIN.test(stripComments('/* import.meta.main is dropped */'))
    ).toBe(false)
    expect(
      PROCESS_ARGV_ENTRY.test(stripComments('const entry = process.argv[1]'))
    ).toBe(true)
    expect(
      PROCESS_ARGV_ENTRY.test(stripComments('// never compare process.argv[1]'))
    ).toBe(false)
    expect(
      PROCESS_ARGV_ENTRY.test(stripComments('process.argv.slice(2)'))
    ).toBe(false)
  })
})
