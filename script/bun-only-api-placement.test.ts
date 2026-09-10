/**
 * Guards every shipped module under `script/` and `tasks/` against
 * `import.meta.dir`, a Bun-only API that is `undefined` under Node.
 *
 * These scripts are invoked with `bunx tsx` (see `200-typescript.md`), which
 * runs on Node, so a module-scope `join(import.meta.dir, ...)` throws
 * ERR_INVALID_ARG_TYPE at import time and takes down every CLI that transitively
 * imports it — how EXSC-964 broke `confirm-safe-tx.ts` for the whole team.
 *
 * `*.test.ts` files are exempt because `bun test` provides the API. That
 * exemption is precisely why a behavioural test cannot catch this class of bug:
 * under `bun test` the offending line works. Hence a source assertion.
 *
 * Scope is deliberately just `import.meta.dir` — the one member of
 * [CONV:NODE-RUNTIME-APIS] that is broken on every Node version and therefore
 * clean at zero. `import.meta.main` (fires on Node 22.23+/24, silently no-ops
 * below) and `Bun.*` (throws at the call site) still have live uses that are not
 * bugs on a current runtime, so asserting them here would only encode a
 * baseline; they are tracked in EXSC-971.
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

/**
 * Matches a read of the API, not a mention of it — a module documenting the
 * hazard in a comment (as `proposePeripheryWithWhitelist.ts` does for
 * `import.meta.main`) must not be reported as a violation. The lookbehind keeps
 * an unrelated `foo.import.meta.dir` from matching.
 */
const IMPORT_META_DIR = /(?<!\.)\bimport\s*\.\s*meta\s*\.\s*dir\b/

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

describe('no shipped script module depends on Bun-only import.meta.dir', () => {
  it('enumerates the tree, so a clean result is not vacuous', () => {
    expect(shippedScriptModules().length).toBeGreaterThan(200)
  })

  it('finds no non-test module reading import.meta.dir', () => {
    const offenders = shippedScriptModules().filter((path) =>
      IMPORT_META_DIR.test(
        stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'))
      )
    )

    expect(offenders).toEqual([])
  })

  it('matches a real read but not a comment that names the API', () => {
    expect(
      IMPORT_META_DIR.test(stripComments('join(import.meta.dir, "..")'))
    ).toBe(true)
    expect(
      IMPORT_META_DIR.test(stripComments('// never use import.meta.dir here'))
    ).toBe(false)
    expect(
      IMPORT_META_DIR.test(stripComments('/* import.meta.dir is Bun-only */'))
    ).toBe(false)
  })
})
