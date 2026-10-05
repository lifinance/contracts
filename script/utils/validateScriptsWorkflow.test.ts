/**
 * Whether the `validate-scripts` CI job lints the whole TS/JS tree, and whether
 * a change to the lint config alone is enough to make it run.
 *
 * `bun lint:js` only passes once the generated artifacts it imports exist
 * (`typechain/`, `out/`, `diamond.json`), so the lint step has to come after the
 * steps that write them.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

interface IStep {
  id?: string
  name?: string
  run?: string
  if?: string
  uses?: string
  with?: Record<string, unknown>
  'continue-on-error'?: unknown
}

interface IJob {
  needs?: string | string[]
  steps?: IStep[]
}

// The pinned @types/bun predates Bun.YAML, which the runtime (packageManager) ships
const { YAML } = Bun as unknown as {
  YAML: { parse: (text: string) => unknown }
}

const REPO_ROOT = join(import.meta.dir, '..', '..')
const WORKFLOW = YAML.parse(
  readFileSync(join(REPO_ROOT, '.github/workflows/validateScripts.yml'), 'utf8')
) as { jobs: Record<string, IJob> }

const job = (name: string): IJob => {
  const found = WORKFLOW.jobs[name]
  if (!found) throw new Error(`validateScripts.yml has no job ${name}`)
  return found
}

/**
 * Returns the path-filter entries of `filters.scripts` in the detect-changes
 * job. A change-type entry (`deleted|renamed: 'src/**'`) becomes its glob.
 */
const scriptsFilter = (): string[] => {
  const step = job('detect-changes').steps?.find((s) => s.id === 'filter')
  const filters = YAML.parse(String(step?.with?.filters)) as {
    scripts: (string | Record<string, string>)[]
  }
  return filters.scripts.flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry)
  )
}

describe('validate-scripts job', () => {
  const steps = job('validate-scripts').steps ?? []
  const stepIndex = (run: string): number => {
    const index = steps.findIndex((step) => step.run === run)
    if (index === -1) throw new Error(`validate-scripts has no step: ${run}`)
    return index
  }

  it('lints the whole tree after generating every artifact it imports', () => {
    const typechain = stepIndex('bun typechain:incremental')
    const abi = stepIndex('bun abi:generate:incremental')
    const lint = stepIndex('bun lint:js')
    expect(typechain).toBeLessThan(abi)
    expect(abi).toBeLessThan(lint)
  })

  it('runs the lint unconditionally', () => {
    expect(steps[stepIndex('bun lint:js')]?.if).toBeUndefined()
  })

  it('still validates scripts after a lint failure', () => {
    const validate = steps.find((step) => step.name === 'Validate scripts')
    expect(validate?.if).toContain('!cancelled()')
  })

  it('fails the job on a lint error but not on a warning', () => {
    expect(steps.filter((step) => step['continue-on-error'] === true)).toEqual(
      []
    )
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts['lint:js']).toBeDefined()
    expect(scripts['lint:js']).not.toContain('--max-warnings')
  })

  it('runs when only the lint config changes', () => {
    expect(scriptsFilter()).toEqual(
      expect.arrayContaining([
        '.oxlintrc.json',
        // Covers the local oxlint plugin `.oxlintrc.json` loads
        'script/**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
        // Type-aware rules read the project from it
        'tsconfig.json',
      ])
    )
  })

  it('runs when a file the scripts import from may have gone away', () => {
    expect(scriptsFilter()).toEqual(
      expect.arrayContaining(['src/**/*.sol', 'config/**', 'deployments/**'])
    )
  })

  it('reports its result through the required aggregator', () => {
    const aggregator = job('validate-scripts-required')
    expect(aggregator.needs).toContain('validate-scripts')
    expect(JSON.stringify(aggregator.steps)).toContain(
      'needs.validate-scripts.result'
    )
  })
})
