/**
 * Runs the weekly coverage workflow's shell steps against a stub `forge`, so the
 * retry loop's compile-error / other-failure split and the Slack message wording
 * are checked without a real coverage build.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { freshChildEnv } from '../deploy/safe/spawn-env'

interface IStep {
  id?: string
  run?: string
  env?: Record<string, string>
}

interface IJob {
  env?: Record<string, string>
  steps?: IStep[]
}

// The pinned @types/bun predates Bun.YAML, which the runtime (packageManager) ships
const { YAML } = Bun as unknown as {
  YAML: { parse: (text: string) => unknown }
}

const REPO_ROOT = join(import.meta.dir, '..', '..')
const WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github/workflows/weeklyCoverageReport.yml'
)
const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, 'utf8')
const WORKFLOW = YAML.parse(WORKFLOW_TEXT) as { jobs: Record<string, IJob> }

const JOB = WORKFLOW.jobs['coverage-report']
if (!JOB) throw new Error('weeklyCoverageReport.yml has no coverage-report job')

const findStep = (id: string): IStep => {
  const step = JOB.steps?.find((s) => s.id === id)
  if (!step?.run)
    throw new Error(`weeklyCoverageReport.yml has no run script for step ${id}`)
  return step
}
const stepRun = (id: string): string => findStep(id).run ?? ''

const RETRY_BUDGET_SECONDS = String(
  findStep('coverage').env?.['RETRY_BUDGET_SECONDS'] ?? ''
)

const COVERAGE_SKIP = JOB.env?.['COVERAGE_SKIP'] ?? ''
const COMPILE_ERROR_LINE =
  'Error: Cannot swap Variable headStart with Variable tail: too deep in the stack by 1 slots'
const STACK_WARNING = 'Warning: dynamic test linking failed (stack too deep)'

// The retry loop only: everything after it processes an lcov file the stub never writes.
const RETRY_LOOP =
  stepRun('coverage').split('echo "Filtering coverage report')[0] ?? ''

// One [arg] per argument, so a list passed as a single quoted argument shows as one bracket
const FORGE_ARGS_STUB = `printf '[%s]' "$@"; echo`

let workDir = ''

const writeExecutable = (name: string, body: string): void => {
  const path = join(workDir, 'bin', name)
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

interface IRunResult {
  exitCode: number
  log: string
  outputs: string
}

const runScript = (
  script: string,
  env: Record<string, string> = {}
): IRunResult => {
  const outputFile = join(workDir, 'github_output')
  writeFileSync(outputFile, '')
  // /bin/bash: on macOS that is bash 3.2, so a local run also covers the oldest bash
  const result = Bun.spawnSync(['/bin/bash', '-c', script], {
    cwd: workDir,
    env: freshChildEnv({
      PATH: `${join(workDir, 'bin')}:${process.env['PATH'] ?? ''}`,
      HOME: workDir,
      GITHUB_OUTPUT: outputFile,
      COVERAGE_SKIP,
      RETRY_BUDGET_SECONDS,
      ...env,
    }),
  })
  return {
    exitCode: result.exitCode,
    log: `${result.stdout.toString()}${result.stderr.toString()}`,
    outputs: readFileSync(outputFile, 'utf8'),
  }
}

const MESSAGE_ENV = {
  SERVER_URL: 'https://github.com',
  REPOSITORY: 'lifinance/contracts',
  RUN_ID: '1',
  JOB_NAME: 'coverage-report',
  LINE_COVERAGE: '',
  FUNCTION_COVERAGE: '',
  BRANCH_COVERAGE: '',
  LINES_HIT: '',
  LINES_FOUND: '',
  TARGET: '80',
}

const composeMessage = (env: Record<string, string>): string => {
  const { outputs } = runScript(stepRun('status_msg'), {
    ...MESSAGE_ENV,
    ...env,
  })
  const match = outputs.match(/text<<SLACK_EOF\n([\s\S]*)\nSLACK_EOF/)
  if (!match?.[1])
    throw new Error(`status_msg wrote no text output: ${outputs}`)
  return match[1]
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'weekly-coverage-'))
  mkdirSync(join(workDir, 'bin'))
  writeExecutable('sleep', 'exit 0')
  writeExecutable('gh', 'exit 1')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('weekly coverage skip list', () => {
  it('skips EcoFacet in the workflow and in the package.json coverage script', () => {
    expect(COVERAGE_SKIP).toBe('EcoFacet')
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['coverage']).toContain('--skip EcoFacet')
  })
})

describe('weekly coverage retry loop', () => {
  it('stops after attempt 1 on a compile error and records the compiler error', () => {
    writeExecutable(
      'forge',
      [
        `echo "${STACK_WARNING}" >&2`,
        'echo "Error: Compiler run failed:" >&2',
        `echo "${COMPILE_ERROR_LINE}" >&2`,
        'exit 1',
      ].join('\n')
    )
    const { exitCode, log, outputs } = runScript(RETRY_LOOP)

    expect(exitCode).toBe(1)
    expect(log).toContain('attempt 1/10')
    expect(log).not.toContain('attempt 2/10')
    expect(outputs).toBe(`compile_error=${COMPILE_ERROR_LINE}\n`)
  })

  it('retries any other failure up to 10 times without compile-error wording', () => {
    writeExecutable(
      'forge',
      [
        `echo "${STACK_WARNING}" >&2`,
        'echo "[FAIL: assertion failed]"',
        'echo "Error: assertion failed" >&2',
        'exit 1',
      ].join('\n')
    )
    const { exitCode, log, outputs } = runScript(RETRY_LOOP)

    expect(exitCode).toBe(1)
    expect(log).toContain('attempt 2/10')
    expect(log).toContain('attempt 10/10')
    expect(log).toContain(
      'forge coverage failed after 10 attempt(s) (failing test or RPC)'
    )
    expect(log).not.toContain('compile')
    expect(outputs).toBe('')
  })

  it('stops retrying once another attempt would overrun the time budget', () => {
    writeExecutable(
      'forge',
      ['echo "[FAIL: assertion failed]"', 'exit 1'].join('\n')
    )
    const { exitCode, log } = runScript(RETRY_LOOP, {
      RETRY_BUDGET_SECONDS: '-1',
    })

    expect(exitCode).toBe(1)
    expect(log).not.toContain('attempt 2/10')
    expect(log).toContain('forge coverage failed after 1 attempt(s)')
  })

  it('passes every contract in a multi-contract skip list to one --skip', () => {
    writeExecutable('forge', FORGE_ARGS_STUB)
    const { exitCode, log } = runScript(RETRY_LOOP, {
      COVERAGE_SKIP: 'EcoFacet FooFacet',
    })

    expect(exitCode).toBe(0)
    expect(log).toContain('[--ir-minimum][--skip][EcoFacet][FooFacet]\n')
  })

  it('passes no --skip when the skip list is empty', () => {
    writeExecutable('forge', FORGE_ARGS_STUB)
    const { exitCode, log } = runScript(RETRY_LOOP, { COVERAGE_SKIP: '' })

    expect(exitCode).toBe(0)
    expect(log).toContain('[--ir-minimum]\n')
    expect(log).not.toContain('--skip')
  })

  it('passes the skip list to forge and stops after a successful attempt', () => {
    writeExecutable('forge', FORGE_ARGS_STUB)
    const { exitCode, log } = runScript(RETRY_LOOP)

    expect(exitCode).toBe(0)
    expect(log).toContain(
      '[coverage][--report][lcov][--force][--ir-minimum][--skip][EcoFacet]\n'
    )
    expect(log).not.toContain('attempt 2/10')
  })
})

describe('weekly coverage Slack message', () => {
  it('reports a compile error with the escaped, capped error in a code span', () => {
    const text = composeMessage({
      OUTCOME: 'failure',
      COMPILE_ERROR: `Error: a <b> & c %s %n ${'x'.repeat(400)}`,
    })

    expect(text).toContain('failed to compile')
    expect(text).toContain('`Error: a &lt;b&gt; &amp; c %s %n x')
    const quoted = text.split('`')[1] ?? ''
    expect(quoted.replace(/&(amp|lt|gt);/g, '_').length).toBe(300)
    expect(text).not.toContain('RPC')
  })

  it('reports other failures without blaming RPC alone or mentioning compilation', () => {
    const text = composeMessage({ OUTCOME: 'failure', COMPILE_ERROR: '' })

    expect(text).toContain('run failed')
    expect(text).toContain('failing test or RPC failure')
    expect(text).not.toContain('compile')
    expect(text).not.toContain('likely a transient RPC failure')
  })

  it('names the skipped contracts on a successful report', () => {
    const text = composeMessage({
      OUTCOME: 'success',
      COMPILE_ERROR: '',
      LINE_COVERAGE: '85.00',
      FUNCTION_COVERAGE: '80.00',
      BRANCH_COVERAGE: '70.00',
      LINES_HIT: '850',
      LINES_FOUND: '1000',
    })

    expect(text).toContain('Line coverage: *85.00%*')
    expect(text).toContain('Excluded from the measurement: EcoFacet\n<')
  })

  it('omits the exclusion line when nothing is skipped', () => {
    const text = composeMessage({
      OUTCOME: 'success',
      COMPILE_ERROR: '',
      COVERAGE_SKIP: '',
      LINE_COVERAGE: '85.00',
      FUNCTION_COVERAGE: '80.00',
      BRANCH_COVERAGE: '70.00',
      LINES_HIT: '850',
      LINES_FOUND: '1000',
    })

    expect(text).not.toContain('Excluded')
    expect(text).toContain('(850 / 1000 lines)\n<')
  })
})
