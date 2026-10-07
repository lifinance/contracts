/**
 * How `runFence` turns paths into a verdict: which files it judges, and that a
 * sweep which judged nothing is an error rather than a pass.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  beforeAll,
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
  let dir = ''
  const reported: string[] = []
  // consola's LogFn type carries a `raw` member a plain function lacks.
  const record = ((...parts: unknown[]): void => {
    reported.push(parts.map(String).join(' '))
  }) as unknown as typeof consola.error
  const errorSpy = spyOn(consola, 'error').mockImplementation(record)
  const successSpy = spyOn(consola, 'success').mockImplementation(record)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fence-runner-'))
    writeFileSync(join(dir, 'bad.ts'), 'debugger\n')
    writeFileSync(join(dir, 'good.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'notes.json'), '{"debugger": true}\n')
  })

  afterAll(() => {
    errorSpy.mockRestore()
    successSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits 1 and names the file when a module is refused', () => {
    reported.length = 0
    expect(runFence(DEBUGGER_FENCE, [join(dir, 'bad.ts')])).toBe(1)
    expect(reported.join('\n')).toContain('bad.ts:1:1  no debugger')
    expect(reported.join('\n')).toContain('1 file(s) checked, 1 refused')
  })

  it('exits 0 when every module passes', () => {
    reported.length = 0
    expect(runFence(DEBUGGER_FENCE, [join(dir, 'good.ts')])).toBe(0)
    expect(reported.join('\n')).toContain('1 file(s) checked, 0 refused')
  })

  it('skips a file that is not a module', () => {
    reported.length = 0
    expect(runFence(DEBUGGER_FENCE, [join(dir, 'notes.json')])).toBe(0)
    expect(reported.join('\n')).toContain('0 file(s) checked')
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
