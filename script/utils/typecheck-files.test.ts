/**
 * Covers `script/utils/typecheck-files.sh`: which files it hands to tsc-files under which tsconfig,
 * and that a file importing an absent build output (typechain/, diamond.json) is skipped with a
 * notice instead of failing. Each case runs in a throwaway directory with `bunx` stubbed on PATH,
 * so no case compiles anything.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from '../deploy/safe/spawn-env'

const SCRIPT = join(import.meta.dir, 'typecheck-files.sh')
const TYPECHAIN_IMPORT = "import type { ILiFi } from '../../typechain'\n"
const DIAMOND_IMPORT = "import diamondAbi from '../../diamond.json'\n"
const PLAIN = 'export const x = 1\n'

interface IRunResult {
  status: number | null
  stderr: string
  tscCalls: string[]
}

const dirs: string[] = []

const write = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-files-'))
  dirs.push(root)
  write(
    root,
    'bin/bunx',
    `#!/bin/bash\necho "$*" >> "${join(root, 'tsc-calls.log')}"\n`
  )
  chmodSync(join(root, 'bin/bunx'), 0o755)
  return root
}

const run = (root: string, ...files: string[]): IRunResult => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  withholdCredentials(env)
  env['PATH'] = `${join(root, 'bin')}:${env['PATH'] ?? ''}`
  const result = spawnSync('bash', [SCRIPT, ...files], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  const log = join(root, 'tsc-calls.log')
  const tscCalls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n')
    : []
  return { status: result.status, stderr: result.stderr, tscCalls }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('typecheck-files.sh', () => {
  it('checks shipped modules against tsconfig.node.json and tests against tsconfig.json', () => {
    const root = makeRoot()
    write(root, 'script/a.ts', PLAIN)
    write(root, 'script/a.test.ts', PLAIN)

    const result = run(root, 'script/a.ts', 'script/a.test.ts', 'README.md')

    expect(result.status).toBe(0)
    expect(result.tscCalls).toEqual([
      'tsc-files --noEmit -p tsconfig.node.json script/a.ts',
      'tsc-files --noEmit script/a.test.ts',
    ])
  })

  it('skips a file importing typechain/ while typechain/ is absent', () => {
    const root = makeRoot()
    write(root, 'script/demoScripts/demoX.ts', TYPECHAIN_IMPORT)
    write(root, 'script/a.ts', PLAIN)

    const result = run(root, 'script/demoScripts/demoX.ts', 'script/a.ts')

    expect(result.status).toBe(0)
    expect(result.stderr).toContain(
      'Not type-checked: script/demoScripts/demoX.ts imports typechain/'
    )
    expect(result.tscCalls).toEqual([
      'tsc-files --noEmit -p tsconfig.node.json script/a.ts',
    ])
  })

  it('skips a file importing diamond.json while diamond.json is absent', () => {
    const root = makeRoot()
    write(root, 'script/demoScripts/demoY.ts', DIAMOND_IMPORT)

    const result = run(root, 'script/demoScripts/demoY.ts')

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('imports diamond.json')
    expect(result.tscCalls).toEqual([])
  })

  it('checks a build-output importer once the output exists', () => {
    const root = makeRoot()
    write(
      root,
      'script/demoScripts/demoX.ts',
      TYPECHAIN_IMPORT + DIAMOND_IMPORT
    )
    write(root, 'typechain/index.ts', PLAIN)
    write(root, 'diamond.json', '[]')

    const result = run(root, 'script/demoScripts/demoX.ts')

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.tscCalls).toEqual([
      'tsc-files --noEmit -p tsconfig.node.json script/demoScripts/demoX.ts',
    ])
  })

  it('exits 1 when tsc-files fails', () => {
    const root = makeRoot()
    write(root, 'bin/bunx', '#!/bin/bash\nexit 2\n')
    write(root, 'script/a.ts', PLAIN)

    expect(run(root, 'script/a.ts').status).toBe(1)
  })
})
