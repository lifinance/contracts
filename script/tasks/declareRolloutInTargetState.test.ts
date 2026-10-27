/**
 * Tests for declaring an executed rollout in `_targetState.json`.
 */
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

import {
  TARGET_STATE_REPO_PATH,
  type PinnedTargetState,
} from '../deploy/safe/pinned-target-state'

import {
  declareRollout,
  hasBlockingResult,
  type IDeclareRolloutOptions,
} from './declareRolloutInTargetState'

const SCRIPT = join(import.meta.dir, 'declareRolloutInTargetState.ts')

const stateWith = (
  entries: Record<string, Record<string, string>>
): PinnedTargetState =>
  Object.fromEntries(
    Object.entries(entries).map(([network, contracts]) => [
      network,
      { production: { LiFiDiamond: { ...contracts } } },
    ])
  )

const options = (
  overrides: Partial<IDeclareRolloutOptions> = {}
): IDeclareRolloutOptions => ({
  contract: 'AcrossFacetV4',
  version: '1.2.0',
  networks: ['optimism'],
  unpin: false,
  ...overrides,
})

const declaredOn = (state: PinnedTargetState, network: string): unknown =>
  state[network]?.production?.LiFiDiamond?.AcrossFacetV4

describe('declareRollout', () => {
  it('adds a missing contract as latest', () => {
    const state = stateWith({ optimism: { Executor: 'latest' } })
    const [result] = declareRollout(state, options())
    expect(result?.outcome).toBe('added')
    expect(declaredOn(state, 'optimism')).toBe('latest')
    expect(state.optimism?.production?.LiFiDiamond?.Executor).toBe('latest')
  })

  it('leaves a latest entry unchanged on a version bump', () => {
    const state = stateWith({ optimism: { AcrossFacetV4: 'latest' } })
    const [result] = declareRollout(state, options({ version: '2.0.0' }))
    expect(result?.outcome).toBe('already-latest')
    expect(declaredOn(state, 'optimism')).toBe('latest')
  })

  it('leaves a pin that matches the executed base version', () => {
    const state = stateWith({ tron: { AcrossFacetV4: '1.2.0' } })
    const [result] = declareRollout(
      state,
      options({ version: '1.2.0-tron', networks: ['tron'] })
    )
    expect(result?.outcome).toBe('pin-matches')
    expect(declaredOn(state, 'tron')).toBe('1.2.0')
  })

  it('refuses a pin that differs from the executed version', () => {
    const state = stateWith({ optimism: { AcrossFacetV4: '1.1.0' } })
    const results = declareRollout(state, options())
    expect(results[0]?.outcome).toBe('pin-conflict')
    expect(declaredOn(state, 'optimism')).toBe('1.1.0')
    expect(hasBlockingResult(results)).toBe(true)
  })

  it('replaces a differing pin with latest when unpinning', () => {
    const state = stateWith({ optimism: { AcrossFacetV4: '1.1.0' } })
    const [result] = declareRollout(state, options({ unpin: true }))
    expect(result?.outcome).toBe('unpinned')
    expect(declaredOn(state, 'optimism')).toBe('latest')
  })

  it('refuses a network with no production diamond block', () => {
    const state = stateWith({ optimism: {} })
    const results = declareRollout(state, options({ networks: ['zerog'] }))
    expect(results[0]?.outcome).toBe('network-not-declared')
    expect(state.zerog).toBeUndefined()
    expect(hasBlockingResult(results)).toBe(true)
  })

  it('reports every network and is non-blocking when all resolve', () => {
    const state = stateWith({
      optimism: {},
      base: { AcrossFacetV4: 'latest' },
    })
    const results = declareRollout(
      state,
      options({ networks: ['optimism', 'base'] })
    )
    expect(results.map((result) => result.outcome)).toEqual([
      'added',
      'already-latest',
    ])
    expect(hasBlockingResult(results)).toBe(false)
  })
})

describe('declareRolloutInTargetState CLI', () => {
  let workDir: string
  let targetStatePath: string

  const run = (...args: string[]) =>
    spawnSync('bunx', ['tsx', SCRIPT, ...args], {
      cwd: workDir,
      encoding: 'utf8',
    })

  const writeState = (state: PinnedTargetState): string => {
    const text = `${JSON.stringify(state, null, 2)}\n`
    writeFileSync(targetStatePath, text)
    return text
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'declare-rollout-'))
    mkdirSync(join(workDir, 'script', 'deploy'), { recursive: true })
    targetStatePath = join(workDir, TARGET_STATE_REPO_PATH)
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('writes the added entries', () => {
    writeState(stateWith({ optimism: {}, base: {} }))
    const result = run(
      '--contract',
      'AcrossFacetV4',
      '--version',
      '1.2.0',
      '--networks',
      'Optimism, base,'
    )
    expect(result.status).toBe(0)
    const written = JSON.parse(readFileSync(targetStatePath, 'utf8'))
    expect(declaredOn(written, 'optimism')).toBe('latest')
    expect(declaredOn(written, 'base')).toBe('latest')
  })

  it('leaves the file untouched when the rollout is already declared', () => {
    const before = `{"optimism":{"production":{"LiFiDiamond":{"AcrossFacetV4":"latest"}}}}`
    writeFileSync(targetStatePath, before)
    const result = run(
      '--contract',
      'AcrossFacetV4',
      '--version',
      '1.2.0',
      '--networks',
      'optimism'
    )
    expect(result.status).toBe(0)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('writes nothing when one network blocks', () => {
    const before = writeState(
      stateWith({ optimism: {}, base: { AcrossFacetV4: '1.0.0' } })
    )
    const result = run(
      '--contract',
      'AcrossFacetV4',
      '--version',
      '1.2.0',
      '--networks',
      'optimism,base'
    )
    expect(result.status).toBe(1)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('rejects a version that is not MAJOR.MINOR.PATCH', () => {
    const before = writeState(stateWith({ optimism: {} }))
    const result = run(
      '--contract',
      'AcrossFacetV4',
      '--version',
      'latest',
      '--networks',
      'optimism'
    )
    expect(result.status).toBe(1)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('rejects an empty network list', () => {
    const before = writeState(stateWith({ optimism: {} }))
    const result = run(
      '--contract',
      'AcrossFacetV4',
      '--version',
      '1.2.0',
      '--networks',
      ' , '
    )
    expect(result.status).toBe(1)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })
})
