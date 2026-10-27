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
import { withholdCredentials } from '../deploy/safe/spawn-env'

import {
  declareRollout,
  describeDiamondLogGap,
  diamondLogPath,
  findMissingMain,
  hasBlockingResult,
  runDeclareRollout,
  type IDeclareRolloutArgs,
  type IDeclareRolloutOptions,
} from './declareRolloutInTargetState'

const REPO_ROOT = join(import.meta.dir, '..', '..')
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

const facetLog = (name: string, version: string) => ({
  LiFiDiamond: {
    Facets: { '0x01': { Name: name, Version: version } },
    Periphery: {},
  },
})

const executedLog = () => facetLog('AcrossFacetV4', '1.2.0')

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

describe('describeDiamondLogGap', () => {
  it('accepts a facet at the executed base version', () => {
    expect(
      describeDiamondLogGap(
        facetLog('AcrossFacetV4', '1.2.0-tron'),
        'AcrossFacetV4',
        '1.2.0'
      )
    ).toBeNull()
  })

  it('accepts a periphery contract by name', () => {
    const log = { LiFiDiamond: { Facets: {}, Periphery: { Executor: '0x1' } } }
    expect(describeDiamondLogGap(log, 'Executor', '2.0.0')).toBeNull()
  })

  it('reports a periphery contract the registry resolves to no address', () => {
    const log = { LiFiDiamond: { Facets: {}, Periphery: { Patcher: '' } } }
    expect(describeDiamondLogGap(log, 'Patcher', '1.0.0')).toBe(
      'does not list Patcher'
    )
  })

  it('reports a facet listed at another version', () => {
    expect(
      describeDiamondLogGap(
        facetLog('AcrossFacetV4', '1.1.0'),
        'AcrossFacetV4',
        '1.2.0'
      )
    ).toBe('lists AcrossFacetV4 at 1.1.0, not 1.2.0')
  })

  it('reports a contract the log does not list', () => {
    expect(describeDiamondLogGap(executedLog(), 'AcrossFacetv4', '1.2.0')).toBe(
      'does not list AcrossFacetv4'
    )
  })

  it('reports an unreadable or malformed log', () => {
    expect(describeDiamondLogGap(undefined, 'AcrossFacetV4', '1.2.0')).toBe(
      'could not be read'
    )
    expect(describeDiamondLogGap([], 'AcrossFacetV4', '1.2.0')).toBe(
      'has no LiFiDiamond block'
    )
    expect(
      describeDiamondLogGap({ LiFiDiamond: {} }, 'AcrossFacetV4', '1.2.0')
    ).toBe('does not list AcrossFacetV4')
  })
})

describe('declareRollout', () => {
  const run = (state: PinnedTargetState, opts: IDeclareRolloutOptions) =>
    declareRollout(state, opts, executedLog)

  it('adds a missing contract as latest', () => {
    const state = stateWith({ optimism: { Executor: 'latest' } })
    const [result] = run(state, options())
    expect(result?.outcome).toBe('added')
    expect(declaredOn(state, 'optimism')).toBe('latest')
    expect(state.optimism?.production?.LiFiDiamond?.Executor).toBe('latest')
  })

  it('leaves a latest entry unchanged', () => {
    const state = stateWith({ optimism: { AcrossFacetV4: 'latest' } })
    const [result] = run(state, options())
    expect(result?.outcome).toBe('already-latest')
    expect(declaredOn(state, 'optimism')).toBe('latest')
  })

  it('leaves a pin that matches the executed base version', () => {
    const state = stateWith({ tron: { AcrossFacetV4: '1.2.0' } })
    const [result] = run(
      state,
      options({ version: '1.2.0-tron', networks: ['tron'] })
    )
    expect(result?.outcome).toBe('pin-matches')
    expect(declaredOn(state, 'tron')).toBe('1.2.0')
  })

  it('refuses a pin that differs from the executed version', () => {
    const state = stateWith({ optimism: { AcrossFacetV4: '1.1.0' } })
    const results = run(state, options())
    expect(results[0]?.outcome).toBe('pin-conflict')
    expect(declaredOn(state, 'optimism')).toBe('1.1.0')
    expect(hasBlockingResult(results)).toBe(true)
  })

  it('replaces a differing pin with latest when unpinning', () => {
    const state = stateWith({ optimism: { AcrossFacetV4: '1.1.0' } })
    const [result] = run(state, options({ unpin: true }))
    expect(result?.outcome).toBe('unpinned')
    expect(declaredOn(state, 'optimism')).toBe('latest')
  })

  it('refuses a network with no production diamond block', () => {
    const state = stateWith({ optimism: {} })
    const results = run(state, options({ networks: ['zerog'] }))
    expect(results[0]?.outcome).toBe('network-not-declared')
    expect(state.zerog).toBeUndefined()
    expect(hasBlockingResult(results)).toBe(true)
  })

  it('refuses a network whose diamond log does not show the contract', () => {
    const state = stateWith({ optimism: {} })
    const results = declareRollout(state, options(), () =>
      facetLog('OtherFacet', '1.0.0')
    )
    expect(results[0]?.outcome).toBe('not-in-diamond-log')
    expect(results[0]?.detail).toContain(diamondLogPath('optimism'))
    expect(declaredOn(state, 'optimism')).toBeUndefined()
    expect(hasBlockingResult(results)).toBe(true)
  })

  it('reports every network and is non-blocking when all resolve', () => {
    const state = stateWith({
      optimism: {},
      base: { AcrossFacetV4: 'latest' },
    })
    const results = run(state, options({ networks: ['optimism', 'base'] }))
    expect(results.map((result) => result.outcome)).toEqual([
      'added',
      'already-latest',
    ])
    expect(hasBlockingResult(results)).toBe(false)
  })
})

describe('runDeclareRollout', () => {
  let repoRoot: string
  let targetStatePath: string

  const args = (
    overrides: Partial<IDeclareRolloutArgs> = {}
  ): IDeclareRolloutArgs => ({
    contract: 'AcrossFacetV4',
    version: '1.2.0',
    networks: 'optimism',
    unpin: false,
    ...overrides,
  })

  const run = (
    overrides: Partial<IDeclareRolloutArgs> = {},
    missingMain: string | null = null
  ) =>
    runDeclareRollout(args(overrides), {
      repoRoot,
      findMissingMain: async () => missingMain,
    })

  const writeState = (state: PinnedTargetState): string => {
    const text = `${JSON.stringify(state, null, 2)}\n`
    writeFileSync(targetStatePath, text)
    return text
  }

  const writeDiamondLog = (network: string, log: unknown) =>
    writeFileSync(join(repoRoot, diamondLogPath(network)), JSON.stringify(log))

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'declare-rollout-'))
    mkdirSync(join(repoRoot, 'script', 'deploy'), { recursive: true })
    mkdirSync(join(repoRoot, 'deployments'), { recursive: true })
    targetStatePath = join(repoRoot, TARGET_STATE_REPO_PATH)
    writeDiamondLog('optimism', executedLog())
    writeDiamondLog('base', executedLog())
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('writes the added entries', async () => {
    writeState(stateWith({ optimism: {}, base: {} }))
    expect(await run({ networks: 'Optimism, base,' })).toBe(true)
    const written = JSON.parse(readFileSync(targetStatePath, 'utf8'))
    expect(declaredOn(written, 'optimism')).toBe('latest')
    expect(declaredOn(written, 'base')).toBe('latest')
  })

  it('leaves the file untouched when the rollout is already declared', async () => {
    const before = `{"optimism":{"production":{"LiFiDiamond":{"AcrossFacetV4":"latest"}}}}`
    writeFileSync(targetStatePath, before)
    expect(await run()).toBe(true)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('writes nothing when one network blocks', async () => {
    const before = writeState(
      stateWith({ optimism: {}, base: { AcrossFacetV4: '1.0.0' } })
    )
    expect(await run({ networks: 'optimism,base' })).toBe(false)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('writes nothing when a network has no diamond log', async () => {
    const before = writeState(stateWith({ optimism: {}, arbitrum: {} }))
    expect(await run({ networks: 'optimism,arbitrum' })).toBe(false)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('writes nothing when the branch does not contain main', async () => {
    const before = writeState(stateWith({ optimism: {} }))
    expect(await run({}, 'merge origin/main first')).toBe(false)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })

  it('refuses an unreadable target state', async () => {
    writeFileSync(targetStatePath, '{ not json')
    expect(await run()).toBe(false)
    expect(readFileSync(targetStatePath, 'utf8')).toBe('{ not json')
  })

  it.each([
    ['a contract name that is not an identifier', { contract: 'Across-V4' }],
    ['a version that is not MAJOR.MINOR.PATCH', { version: 'latest' }],
    ['an empty network list', { networks: ' , ' }],
  ])('rejects %s', async (_case, overrides) => {
    const before = writeState(stateWith({ optimism: {} }))
    expect(await run(overrides)).toBe(false)
    expect(readFileSync(targetStatePath, 'utf8')).toBe(before)
  })
})

describe('findMissingMain', () => {
  let repoRoot: string

  const git = (...gitArgs: string[]): string => {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...gitArgs],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }

  const commit = (message: string): string => {
    git('commit', '--allow-empty', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }

  const anchoredAt = (revision: string) => async () =>
    ({ ok: true, revision } as const)

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'declare-rollout-git-'))
    git('init', '-q', '-b', 'main')
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('passes when HEAD contains main', async () => {
    const mainHead = commit('main')
    commit('rollout')
    expect(await findMissingMain(repoRoot, anchoredAt(mainHead))).toBeNull()
  })

  it('refuses when main moved past the branch point', async () => {
    commit('base')
    git('switch', '-q', '-c', 'rollout')
    commit('rollout')
    git('switch', '-q', 'main')
    const mainHead = commit('main moved on')
    git('switch', '-q', 'rollout')
    expect(await findMissingMain(repoRoot, anchoredAt(mainHead))).toContain(
      'git merge origin/main'
    )
  })

  it('refuses when the anchor is unavailable', async () => {
    const reason = await findMissingMain(repoRoot, async () => ({
      ok: false,
      reason: 'fetch-failed',
    }))
    expect(reason).toContain('could not refresh origin/main')
  })

  it('refuses when git cannot compare the commits', async () => {
    commit('main')
    expect(
      await findMissingMain(repoRoot, anchoredAt('f'.repeat(40)))
    ).toContain('could not compare HEAD')
  })
})

describe('declareRolloutInTargetState CLI', () => {
  it('runs as an entrypoint and refuses bad arguments before reading anything', () => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    }
    withholdCredentials(env)
    // Run from the repo root so `bunx` resolves the pinned local tsx.
    const result = spawnSync(
      'bunx',
      [
        'tsx',
        SCRIPT,
        '--contract',
        'Across-V4',
        '--version',
        '1.2.0',
        '--networks',
        'optimism',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env }
    )
    expect(result.status).toBe(1)
    expect(result.stderr + result.stdout).toContain(
      'is not a Solidity contract name'
    )
  })
})
