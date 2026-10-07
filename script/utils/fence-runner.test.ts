/**
 * How `runFence` turns paths into a verdict: which files it judges, that a
 * sweep which judged nothing is an error rather than a pass, and that a file
 * which does not parse is refused rather than judged.
 *
 * The `runFence` cases run inside a throwaway git repo, since paths are judged
 * relative to the repo root and directories are listed through git.
 */

import { execFileSync } from 'child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { consola } from 'consola'
import ts from 'typescript'

import { type IFence, findViolations, runFence } from './fence-runner'

/** Refuses every `debugger` statement, wherever the file lives. */
const DEBUGGER_FENCE: IFence = {
  name: 'debugger fence',
  appliesTo: () => true,
  rules: [{ matches: ts.isDebuggerStatement, message: 'no debugger' }],
}

const PARSE_ERROR = 'cannot be parsed, so the fence refuses it unjudged'

describe('findViolations', () => {
  it('reports the line and column of each offending node', () => {
    expect(
      findViolations(DEBUGGER_FENCE, 'const a = 1\n  debugger\n', 'x.ts')
    ).toEqual(['2:3  no debugger'])
  })

  it('judges nothing in a file the fence does not apply to', () => {
    const fence: IFence = { ...DEBUGGER_FENCE, appliesTo: () => false }
    expect(findViolations(fence, 'debugger\n', 'x.ts')).toEqual([])
  })

  it('parses JSX in a .tsx file', () => {
    expect(
      findViolations(
        DEBUGGER_FENCE,
        'export const C = () => { debugger; return <div /> }\n',
        'x.tsx'
      )
    ).toEqual(['1:26  no debugger'])
  })

  it('parses JSX in a .jsx file', () => {
    expect(
      findViolations(
        DEBUGGER_FENCE,
        'export const C = () => { debugger; return <div /> }\n',
        'x.jsx'
      )
    ).toEqual(['1:26  no debugger'])
  })

  it('refuses a module that does not parse, even with no rule matching', () => {
    const violations = findViolations(
      DEBUGGER_FENCE,
      'export const a = (\n',
      'x.ts'
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join('\n')).toContain(PARSE_ERROR)
  })

  it('refuses TypeScript syntax in a .js file rather than judging it', () => {
    expect(
      findViolations(
        DEBUGGER_FENCE,
        'export const a: number = 1\n',
        'x.js'
      ).join('\n')
    ).toContain(PARSE_ERROR)
  })
})

describe('runFence', () => {
  let repo = ''
  let outside = ''
  let originalCwd = ''
  const reported: string[] = []
  // consola's LogFn type carries a `raw` member a plain function lacks.
  const record = ((...parts: unknown[]): void => {
    reported.push(parts.map(String).join(' '))
  }) as unknown as typeof consola.error
  const errorSpy = spyOn(consola, 'error').mockImplementation(record)
  const successSpy = spyOn(consola, 'success').mockImplementation(record)
  const output = (): string => reported.join('\n')

  /** Refuses `debugger` only in the file at repo path `bad.ts`. */
  const ROOT_BAD_FENCE: IFence = {
    ...DEBUGGER_FENCE,
    appliesTo: (path) => path === 'bad.ts',
  }

  const write = (path: string, text: string): void => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }

  beforeAll(() => {
    originalCwd = process.cwd()
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'fence-runner-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'fence-outside-')))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    write('bad.ts', 'debugger\n')
    write('good.ts', 'export const a = 1\n')
    write('notes.json', '{"debugger": true}\n')
    write('config/settings.json', '{}\n')
    write('archive/old.ts', 'debugger\n')
    write('sub/nested.ts', 'export const b = 2\n')
    write('gone.ts', 'export const c = 3\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    rmSync(join(repo, 'gone.ts'))
    writeFileSync(join(outside, 'stray.ts'), 'debugger\n')
    symlinkSync(repo, join(outside, 'linked-checkout'))
  })

  beforeEach(() => {
    process.chdir(repo)
    reported.length = 0
  })

  afterAll(() => {
    process.chdir(originalCwd)
    errorSpy.mockRestore()
    successSpy.mockRestore()
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('exits 1 and names the file when a module is refused', () => {
    expect(runFence(DEBUGGER_FENCE, ['bad.ts'])).toBe(1)
    expect(output()).toContain('bad.ts:1:1  no debugger')
    expect(output()).toContain('1 file(s) checked, 1 refused')
  })

  it('exits 0 when every module passes', () => {
    expect(runFence(DEBUGGER_FENCE, ['good.ts'])).toBe(0)
    expect(output()).toContain('1 file(s) checked, 0 refused')
  })

  it('skips a file that is not a module', () => {
    expect(runFence(DEBUGGER_FENCE, ['notes.json'])).toBe(0)
    expect(output()).toContain('0 file(s) checked')
  })

  it('sweeps a directory past a file deleted but not yet staged', () => {
    expect(runFence(DEBUGGER_FENCE, ['.'])).toBe(1)
    expect(output()).toContain('3 file(s) checked, 1 refused')
    expect(output()).not.toContain('gone.ts')
  })

  it('judges a file argument by its repo path from a subdirectory', () => {
    process.chdir(join(repo, 'sub'))
    expect(runFence(ROOT_BAD_FENCE, [join(repo, 'bad.ts')])).toBe(1)
    expect(output()).toContain('bad.ts:1:1  no debugger')
  })

  it('judges a file argument reached through a symlinked checkout', () => {
    const linked = join(outside, 'linked-checkout', 'bad.ts')
    expect(runFence(ROOT_BAD_FENCE, [linked])).toBe(1)
    expect(output()).toContain('1 file(s) checked, 1 refused')
  })

  it('lists a directory by repo path from a subdirectory', () => {
    process.chdir(join(repo, 'sub'))
    expect(runFence(ROOT_BAD_FENCE, [repo])).toBe(1)
    expect(output()).toContain('bad.ts:1:1  no debugger')
  })

  it('refuses a file outside the repo rather than skipping it', () => {
    expect(() => runFence(DEBUGGER_FENCE, [join(outside, 'stray.ts')])).toThrow(
      'is outside the repository'
    )
  })

  it('refuses to run with no paths', () => {
    expect(() => runFence(DEBUGGER_FENCE, [])).toThrow('pass at least one')
  })

  it('refuses a path that does not exist', () => {
    expect(() => runFence(DEBUGGER_FENCE, ['no/such/dir'])).toThrow(
      'does not exist'
    )
  })

  it('refuses a directory sweep that finds no module, rather than passing it', () => {
    expect(() => runFence(DEBUGGER_FENCE, ['config'])).toThrow(
      'holds no module files'
    )
  })

  it('leaves archive/ out of a sweep', () => {
    expect(() => runFence(DEBUGGER_FENCE, ['archive'])).toThrow(
      'holds no module files'
    )
  })
})
