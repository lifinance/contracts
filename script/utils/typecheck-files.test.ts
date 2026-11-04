/**
 * Covers `script/utils/typecheck-files.sh`: which files it hands to tsc-files under which tsconfig,
 * and that while a build output (typechain/, diamond.json) is absent, the errors of files that
 * cannot find it are ignored while every other error still fails. Each case runs in a throwaway
 * directory with `bunx` stubbed on PATH to replay a given tsc output, so no case compiles anything.
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
const HELPERS = 'script/demoScripts/utils/demoScriptHelpers.ts'
const DEMO = 'script/demoScripts/demoX.ts'
const MISSING_TYPECHAIN = `${HELPERS}(37,28): error TS2307: Cannot find module '../../../typechain' or its corresponding type declarations.`
const MISSING_FACTORY = `${DEMO}(18,41): error TS2307: Cannot find module '../../typechain/factories/ERC20__factory' or its corresponding type declarations.`
const FOLLOW_ON = `${DEMO}(95,33): error TS2722: Cannot invoke an object which is possibly 'undefined'.`
const MISSING_DIAMOND = `${DEMO}(16,24): error TS2307: Cannot find module '../../diamond.json' or its corresponding type declarations.`
const REAL_ERROR =
  "script/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."

interface IRunResult {
  status: number | null
  output: string
  stderr: string
  tscCalls: string[]
}

interface ITsc {
  output: string
  status: number
}

const dirs: string[] = []

const write = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/**
 * Creates a checkout whose `bunx` logs its arguments and replays the given tsc result.
 *
 * @param tsc - Output and exit status every tsc-files call returns.
 * @returns The checkout's path.
 */
const makeRoot = (tsc: ITsc = { output: '', status: 0 }): string => {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-files-'))
  dirs.push(root)
  write(root, 'tsc-output', tsc.output === '' ? '' : `${tsc.output}\n`)
  write(
    root,
    'bin/bunx',
    `#!/bin/bash\necho "$*" >> "${join(root, 'tsc-calls.log')}"\n` +
      `cat "${join(root, 'tsc-output')}"\nexit ${tsc.status}\n`
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
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    stderr: result.stderr,
    tscCalls,
  }
}

const failing = (...lines: string[]): ITsc => ({
  output: lines.join('\n'),
  status: 2,
})

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('typecheck-files.sh', () => {
  it('checks shipped modules against tsconfig.node.json and tests against tsconfig.json', () => {
    const root = makeRoot()

    const result = run(root, 'script/a.ts', 'script/a.test.ts', 'README.md')

    expect(result.status).toBe(0)
    expect(result.tscCalls).toEqual([
      'tsc-files --noEmit -p tsconfig.node.json script/a.ts',
      'tsc-files --noEmit script/a.test.ts',
    ])
  })

  it('ignores every error in files that cannot find an absent typechain/', () => {
    const root = makeRoot(
      failing(MISSING_TYPECHAIN, MISSING_FACTORY, FOLLOW_ON)
    )

    const result = run(root, 'script/deploy/safe/deploy-safe.ts', DEMO)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Ignored the type errors in these files')
    expect(result.stderr).toContain(`  ${HELPERS}\n`)
    expect(result.stderr).toContain(`  ${DEMO}\n`)
  })

  it('ignores the errors of a file that cannot find an absent diamond.json', () => {
    const root = makeRoot(failing(MISSING_DIAMOND))
    write(root, 'typechain/index.ts', '')

    expect(run(root, DEMO).status).toBe(0)
  })

  it('fails on a missing typechain/ module when typechain/ exists', () => {
    const root = makeRoot(failing(MISSING_TYPECHAIN))
    write(root, 'typechain/index.ts', '')
    write(root, 'diamond.json', '[]')

    const result = run(root, 'script/deploy/safe/deploy-safe.ts')

    expect(result.status).toBe(1)
    expect(result.output).toContain(MISSING_TYPECHAIN)
  })

  it('fails on an error in a file that can be judged, next to ignored ones', () => {
    const root = makeRoot(failing(MISSING_TYPECHAIN, FOLLOW_ON, REAL_ERROR))

    const result = run(root, 'script/a.ts', DEMO)

    expect(result.status).toBe(1)
    expect(result.output).toContain(REAL_ERROR)
  })

  it('fails when a module that is not a build output cannot be found', () => {
    const missingPackage =
      "script/a.ts(1,20): error TS2307: Cannot find module 'left-pad' or its corresponding type declarations."
    const root = makeRoot(failing(missingPackage))

    expect(run(root, 'script/a.ts').status).toBe(1)
  })

  it('fails when tsc-files fails without reporting an error', () => {
    const root = makeRoot(failing('tsc-files: crashed'))

    const result = run(root, 'script/a.ts')

    expect(result.status).toBe(1)
    expect(result.output).toContain('tsc-files: crashed')
  })
})
