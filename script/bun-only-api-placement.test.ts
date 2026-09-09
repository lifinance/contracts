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
 * `import.meta.main` is the same hazard and is deliberately not asserted here:
 * several CLIs still use it as a run guard, where under Node it degrades to a
 * silent no-op rather than a crash. Removing those is tracked separately.
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
      readFileSync(join(REPO_ROOT, path), 'utf8').includes('import.meta.dir')
    )

    expect(offenders).toEqual([])
  })
})
