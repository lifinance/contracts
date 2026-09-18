/**
 * Spawns the real CLI, because the scanner being right is not the same as the
 * gate being wired up: the paths arrive as citty positionals, and citty assigns
 * only the first of them to the declared argument. A command that read that
 * argument alone would scan one path and report success for every other file it
 * was handed.
 *
 * Invoked the way CI invokes it — `bunx tsx` — so a guard that never fires
 * under that loader shows up here as a command that exits 0 having scanned
 * nothing, rather than as a gate that silently passes every PR.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from '../safe/spawn-env'

import { collectJsonFiles } from './verify-json-duplicate-keys'

const CLI = 'script/deploy/resources/verify-json-duplicate-keys.ts'

/** Long enough for tsx to boot and scan a handful of small files. */
const TIMEOUT_MS = 60_000

const CLEAN = JSON.stringify({ a: 1, b: { a: 2 } }, null, 2)
const DUPLICATE = '{\n  "a": 1,\n  "a": 2\n}'

const scratch = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-'))

const write = (name: string, content: string): string => {
  const path = join(scratch, name)
  writeFileSync(path, content)
  return path
}

const cleanFile = write('clean.json', CLEAN)
const duplicateFile = write('duplicate.json', DUPLICATE)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const run = (args: string[]): { exitCode: number; output: string } => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // `bun test` sets NODE_ENV=test; this child is exercised as a CLI.
  delete env.NODE_ENV
  withholdCredentials(env)

  const result = Bun.spawnSync(['bunx', 'tsx', CLI, ...args], {
    env,
    timeout: TIMEOUT_MS,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // A timeout-killed child is not a result: asserting on its output would pass
  // on a run killed before the scanner reached a verdict.
  if (result.signalCode !== null && result.signalCode !== undefined)
    throw new Error(
      `child was killed by ${result.signalCode} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )

  return {
    exitCode: result.exitCode ?? -1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

describe('verify-json-duplicate-keys CLI', () => {
  it('passes a file whose keys are distinct', () => {
    const { exitCode, output } = run([cleanFile])

    expect(exitCode).toBe(0)
    expect(output).toContain('No duplicate keys in 1 JSON file(s)')
  })

  it('fails a file that declares a key twice, naming key and line', () => {
    const { exitCode, output } = run([duplicateFile])

    expect(exitCode).toBe(1)
    expect(output).toContain("declares 'a' again")
    expect(output).toContain('duplicate.json:3')
  })

  it('scans every path it is given, not only the first', () => {
    // The clean file comes first on purpose: a command reading only the
    // declared positional would exit 0 here and the gate would be blind to
    // every path after the first.
    const { exitCode, output } = run([cleanFile, duplicateFile])

    expect(exitCode).toBe(1)
    expect(output).toContain('duplicate.json')
  })

  it('walks a directory it is given', () => {
    const { exitCode, output } = run([scratch])

    expect(exitCode).toBe(1)
    expect(output).toContain('duplicate.json')
  })

  it('errors rather than passing when a path does not exist', () => {
    const { exitCode, output } = run([join(scratch, 'absent.json')])

    expect(exitCode).toBe(2)
    expect(output).toContain('Could not read')
  })

  it('errors rather than passing when the paths hold no JSON file', () => {
    const empty = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-empty-'))
    try {
      const { exitCode, output } = run([empty])

      expect(exitCode).toBe(2)
      expect(output).toContain('Nothing about it was verified')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('errors on a path that yields nothing even when another path yields files', () => {
    // The overall count is non-zero here, so only a per-path check catches it.
    // A mistyped or symlinked entry in the workflow's list would otherwise ride
    // along on its neighbours and read as verified.
    const empty = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-empty2-'))
    try {
      const { exitCode, output } = run([cleanFile, empty])

      expect(exitCode).toBe(2)
      expect(output).toContain(empty)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('errors on a symlinked directory instead of reporting success over nothing', () => {
    const real = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-real-'))
    const parent = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-parent-'))
    try {
      writeFileSync(join(real, 'duplicate.json'), DUPLICATE)
      const link = join(parent, 'linked')
      symlinkSync(real, link)

      // The jsonlint step follows such a link and would scan the duplicate, so
      // passing here would be a silent divergence between the two steps.
      const { exitCode } = run([link])
      expect(exitCode).toBe(2)

      expect(run([real]).exitCode).toBe(1)
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('errors rather than crashing on malformed JSON', () => {
    // Its own directory: dropping a malformed file into `scratch` would change
    // what the directory-walk case above scans, and silently make it pass for
    // the wrong reason.
    const broken = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-broken-'))
    try {
      const malformed = join(broken, 'malformed.json')
      writeFileSync(malformed, '{"a\\q": 1}')

      const { exitCode, output } = run([malformed])

      expect(exitCode).toBe(2)
      expect(output).toContain('could not be scanned')
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})

describe('collectJsonFiles', () => {
  it('finds nested JSON files and ignores other extensions', () => {
    const nested = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-nested-'))
    try {
      writeFileSync(join(nested, 'kept.json'), CLEAN)
      writeFileSync(join(nested, 'ignored.md'), '# no')

      expect(collectJsonFiles([nested])).toEqual([join(nested, 'kept.json')])
    } finally {
      rmSync(nested, { recursive: true, force: true })
    }
  })

  it('skips a symlink, as the JSON checker does', () => {
    const linked = mkdtempSync(join(tmpdir(), 'json-duplicate-keys-link-'))
    try {
      const link = join(linked, 'link.json')
      symlinkSync(duplicateFile, link)

      expect(collectJsonFiles([linked])).toEqual([])
      // The link really does point at a file that would have been flagged, so
      // the empty result above is the skip and not a missing target.
      expect(collectJsonFiles([duplicateFile])).toEqual([duplicateFile])
    } finally {
      rmSync(linked, { recursive: true, force: true })
    }
  })
})
