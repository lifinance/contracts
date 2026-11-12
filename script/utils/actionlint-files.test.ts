/**
 * Covers the workflow-file lint gate: the lint-staged hook script that runs
 * actionlint on staged workflow files, its lint-staged wiring, and the
 * `actionlint` CI workflow that runs the same linter on pull requests.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { freshChildEnv, withholdCredentials } from '../deploy/safe/spawn-env'

interface IStep {
  name?: string
  run?: string
  uses?: string
}

interface IJob {
  permissions?: Record<string, string>
  env?: Record<string, string | number>
  steps?: IStep[]
}

interface IWorkflow {
  on: { pull_request?: { paths?: string[] } }
  permissions: Record<string, string>
  jobs: Record<string, IJob>
}

// The pinned @types/bun predates Bun.YAML, which the runtime (packageManager) ships
const { YAML } = Bun as unknown as {
  YAML: { parse: (text: string) => unknown }
}

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'script/utils/actionlint-files.sh')
const LINT_STAGED_GLOB = '.github/workflows/*.{yml,yaml}'
const REAL_ACTIONLINT = Bun.which('actionlint')
// Resolved from the full PATH: the filtered child PATH can drop bash's own
// directory when actionlint is installed beside it (e.g. /usr/bin)
const BASH = Bun.which('bash') ?? '/bin/bash'

const VALID_WORKFLOW = `name: ok
on: push
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`

// `run:` ends the block scalar early: the unindented line becomes a bad key
const BROKEN_WORKFLOW = `name: broken
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "first line
second line at column 0"
`

/**
 * PATH with every directory that holds an `actionlint` removed, so the
 * missing-binary case is reproducible on a machine that has one installed.
 *
 * @returns The filtered PATH value.
 */
const pathWithoutActionlint = (): string =>
  (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '' && !existsSync(join(dir, 'actionlint')))
    .join(':')

/**
 * Puts an `actionlint` stub on PATH that records its arguments and exits with
 * a chosen code.
 *
 * @param exitCode - Exit code the stub returns.
 * @returns The stub directory and the file the stub writes its arguments to.
 */
const actionlintStub = (
  exitCode: number
): { dir: string; argsFile: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'actionlint-stub-'))
  const argsFile = join(dir, 'args.txt')
  const stub = join(dir, 'actionlint')
  writeFileSync(
    stub,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\nexit ${exitCode}\n`
  )
  chmodSync(stub, 0o755)
  return { dir, argsFile }
}

/**
 * Writes a workflow file into a fresh temporary `.github/workflows` directory.
 *
 * @param content - Workflow YAML.
 * @returns Absolute path of the written file.
 */
const writeWorkflow = (content: string): string => {
  const dir = join(
    mkdtempSync(join(tmpdir(), 'actionlint-repo-')),
    '.github',
    'workflows'
  )
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'test.yml')
  writeFileSync(file, content)
  return file
}

const runScript = (
  files: string[],
  path: string
): { status: number | null; stderr: string } => {
  const env = freshChildEnv({ PATH: path })
  withholdCredentials(env)
  const result = spawnSync(BASH, [SCRIPT, ...files], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr }
}

describe('actionlint-files.sh', () => {
  it('fails and names brew install actionlint when actionlint is not on PATH', () => {
    const file = writeWorkflow(VALID_WORKFLOW)
    const { status, stderr } = runScript([file], pathWithoutActionlint())
    expect(status).toBe(1)
    expect(stderr).toContain('brew install actionlint')
  })

  it('exits 0 without actionlint when no file is passed', () => {
    const { status, stderr } = runScript([], pathWithoutActionlint())
    expect(status).toBe(0)
    expect(stderr).toBe('')
  })

  it('passes every file to actionlint and returns its exit code', () => {
    const { dir, argsFile } = actionlintStub(3)
    const first = writeWorkflow(VALID_WORKFLOW)
    const second = writeWorkflow(VALID_WORKFLOW)
    const { status } = runScript(
      [first, second],
      `${dir}:${pathWithoutActionlint()}`
    )
    expect(status).toBe(3)
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      first,
      second,
    ])
  })

  it.skipIf(!REAL_ACTIONLINT)(
    'fails on a workflow with a YAML syntax error (real actionlint)',
    () => {
      const { status } = runScript(
        [writeWorkflow(BROKEN_WORKFLOW)],
        process.env.PATH ?? ''
      )
      expect(status).not.toBe(0)
    }
  )

  it.skipIf(!REAL_ACTIONLINT)(
    'passes a valid workflow (real actionlint)',
    () => {
      const { status } = runScript(
        [writeWorkflow(VALID_WORKFLOW)],
        process.env.PATH ?? ''
      )
      expect(status).toBe(0)
    }
  )
})

describe('lint-staged wiring', () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
  ) as { 'lint-staged': Record<string, string[]> }

  it('runs the script on staged workflow .yml and .yaml files', () => {
    expect(pkg['lint-staged'][LINT_STAGED_GLOB]).toEqual([
      'bash script/utils/actionlint-files.sh',
    ])
  })
})

describe('actionlint.yml workflow', () => {
  const workflow = YAML.parse(
    readFileSync(join(REPO_ROOT, '.github/workflows/actionlint.yml'), 'utf8')
  ) as IWorkflow
  const job = workflow.jobs.actionlint
  if (!job) throw new Error('actionlint.yml has no actionlint job')
  const steps = job.steps ?? []
  const install = steps.find((step) => step.name === 'Install actionlint')
  if (!install?.run) throw new Error('actionlint.yml has no install step')

  it('runs on pull requests that change a workflow file', () => {
    expect(workflow.on.pull_request?.paths).toEqual(['.github/workflows/**'])
  })

  it('denies all permissions at the top and grants contents: read to the job', () => {
    expect(workflow.permissions).toEqual({})
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  it('pins every action to a full commit SHA', () => {
    const uses = steps.flatMap((step) => (step.uses ? [step.uses] : []))
    expect(uses.length).toBeGreaterThan(0)
    for (const ref of uses)
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  it('downloads a pinned release tarball and checks its sha256 before use', () => {
    expect(String(job.env?.ACTIONLINT_VERSION)).toMatch(/^\d+\.\d+\.\d+$/)
    expect(String(job.env?.ACTIONLINT_SHA256)).toMatch(/^[0-9a-f]{64}$/)
    const script = install.run ?? ''
    expect(script).toMatch(/releases\/download\/v\$\{ACTIONLINT_VERSION\}\//)
    const check = script.indexOf('sha256sum --check')
    const extract = script.indexOf('tar -xzf')
    expect(check).toBeGreaterThan(-1)
    expect(extract).toBeGreaterThan(check)
  })

  it('does not run a remote install script', () => {
    for (const step of steps) {
      expect(step.run ?? '').not.toMatch(/\|\s*(ba)?sh\b|bash\s+<\(/)
    }
  })

  it('runs actionlint over the whole tree', () => {
    expect(
      steps.some((step) => /^actionlint\b(?! -version)/m.test(step.run ?? ''))
    ).toBe(true)
  })
})
