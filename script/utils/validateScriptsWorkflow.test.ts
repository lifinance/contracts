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

const REPO_ROOT = join(import.meta.dir, '..', '..')
const WORKFLOW = readFileSync(
  join(REPO_ROOT, '.github/workflows/validateScripts.yml'),
  'utf8'
)

/**
 * Returns the body of the top-level job `name`: every line from its key up to
 * the next job key at the same indentation.
 */
const jobBlock = (name: string): string => {
  const lines = WORKFLOW.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) throw new Error(`validateScripts.yml has no job ${name}`)
  const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** Returns the `filters.scripts` list of the detect-changes job. */
const scriptsFilter = (): string[] => {
  const lines = jobBlock('detect-changes').split('\n')
  const start = lines.findIndex((line) => line.trim() === 'scripts:')
  const entries: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('#')) continue
    const match = /^\s+- '(.+)'$/.exec(line)
    if (!match?.[1]) break
    entries.push(match[1])
  }
  return entries
}

describe('validate-scripts job', () => {
  const job = jobBlock('validate-scripts')
  const stepIndex = (run: string): number => {
    const index = job.indexOf(`run: ${run}\n`)
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

  it('fails the job on a lint error but not on a warning', () => {
    expect(job).not.toContain('continue-on-error')
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
        '.eslintrc.cjs',
        // Extended by .eslintrc.cjs, so its rules are part of `bun lint:js`
        '.eslintrc.funnel-fence.cjs',
        '.eslintignore',
        'tsconfig.eslint.json',
      ])
    )
  })

  it('reports its result through the required aggregator', () => {
    const aggregator = jobBlock('validate-scripts-required')
    expect(aggregator).toMatch(/needs: \[[^\]]*\bvalidate-scripts\b/)
    expect(aggregator).toContain('needs.validate-scripts.result')
  })
})
