/**
 * How `runFence` turns paths into a verdict: which files it judges, and that a
 * sweep which judged nothing, or a run from below the repo root, is an error
 * rather than a pass.
 *
 * The `runFence` cases run inside a throwaway git repo, since directories are
 * listed through git.
 */

import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
})

describe('runFence', () => {
  let repo = ''
  let originalCwd = ''
  const reported: string[] = []
  // consola's LogFn type carries a `raw` member a plain function lacks.
  const record = ((...parts: unknown[]): void => {
    reported.push(parts.map(String).join(' '))
  }) as unknown as typeof consola.error
  const errorSpy = spyOn(consola, 'error').mockImplementation(record)
  const successSpy = spyOn(consola, 'success').mockImplementation(record)
  const output = (): string => reported.join('\n')

  const write = (path: string, text: string): void => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), text)
  }

  beforeAll(() => {
    originalCwd = process.cwd()
    repo = mkdtempSync(join(tmpdir(), 'fence-runner-'))
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

  it('refuses to run from below the repo root, where paths would not match', () => {
    process.chdir(join(repo, 'sub'))
    expect(() => runFence(DEBUGGER_FENCE, ['nested.ts'])).toThrow(
      'Run the fence from the repo root, not from sub/'
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
