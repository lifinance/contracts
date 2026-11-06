/**
 * Tests for the timelock watcher CLI's state loading and finding assembly. The
 * chain-facing path is exercised on an anvil fork, not here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { PublicClient } from 'viem'

import {
  createDeployLogHistoryReader,
  findingsOf,
  loadWatcherState,
  openWatcherStore,
  parseDeployLogHistory,
  readTimelockLogs,
} from './timelock-watcher'
import type { INetworkReport } from './timelock-watcher-report'

const dir = mkdtempSync(join(tmpdir(), 'timelock-watcher-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, content: string): string => {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('loadWatcherState', () => {
  it('starts afresh when there is no state file', async () => {
    const state = await loadWatcherState(join(dir, 'absent.json'))
    expect(state).toEqual({
      version: 1,
      networks: {},
      alerts: {},
      delivery: { streaks: {}, held: [] },
      codehash: {},
    })
  })

  it('reads back a state an earlier run saved', async () => {
    const saved = {
      version: 1,
      networks: { base: { timelock: '0x1', operations: {} } },
      alerts: {
        'base:network': {
          verdict: 'unverified',
          alertedAt: '2026-09-29T00:00:00.000Z',
        },
      },
      delivery: {
        streaks: { 'sei:network': 2 },
        held: [],
        lastPostAt: '2026-09-29T00:00:00.000Z',
      },
      codehash: {},
    }
    const state = await loadWatcherState(
      write('valid.json', JSON.stringify(saved))
    )
    expect(state).toEqual(saved as typeof state)
  })

  it('fills sections an older writer left out', async () => {
    const state = await loadWatcherState(
      write('partial.json', JSON.stringify({ version: 1 }))
    )
    expect(state.networks).toEqual({})
    expect(state.alerts).toEqual({})
    expect(state.delivery).toEqual({ streaks: {}, held: [] })
    expect(state.codehash).toEqual({})
  })

  it('drops malformed delivery entries instead of failing every later run', async () => {
    const state = await loadWatcherState(
      write(
        'bad-delivery.json',
        JSON.stringify({
          version: 1,
          delivery: {
            streaks: { 'a:network': 2, 'b:network': 'x', 'c:network': null },
            held: [
              null,
              { kind: 'resolved' },
              { finding: { key: 'a:0x1', reasons: [] } },
            ],
            lastPostAt: 5,
          },
        })
      )
    )
    expect(state.delivery).toEqual({
      streaks: { 'a:network': 2 },
      held: [{ finding: { key: 'a:0x1', reasons: [] } }] as never,
    })
  })

  it('reads a delivery section that is not an object as empty', async () => {
    const state = await loadWatcherState(
      write('scalar-delivery.json', JSON.stringify({ version: 1, delivery: 7 }))
    )
    expect(state.delivery).toEqual({ streaks: {}, held: [] })
  })

  it('starts afresh on another schema version, losing alert records rather than trusting them', async () => {
    const state = await loadWatcherState(
      write(
        'old.json',
        JSON.stringify({ version: 0, alerts: { x: { verdict: 'mismatch' } } })
      )
    )
    expect(state.alerts).toEqual({})
  })

  it('starts afresh on a corrupt file', async () => {
    const state = await loadWatcherState(write('corrupt.json', '{ nope'))
    expect(state.networks).toEqual({})
  })
})

describe('findingsOf', () => {
  const report = (overrides: Partial<INetworkReport>): INetworkReport => ({
    network: 'base',
    status: 'watched',
    verdict: 'ok',
    operations: [],
    notes: [],
    ...overrides,
  })

  it('emits one network finding per report, carrying its reason and notes', () => {
    const findings = findingsOf([
      report({
        network: 'Sei',
        verdict: 'unverified',
        reason: 'history incomplete',
        notes: ['floor unknown'],
      }),
    ])
    expect(findings).toEqual([
      {
        key: 'sei:network',
        network: 'Sei',
        verdict: 'unverified',
        reasons: ['history incomplete', 'floor unknown'],
      },
    ])
  })

  it('emits one finding per pending operation, beside the network', () => {
    const findings = findingsOf([
      report({
        operations: [
          {
            id: '0xABC',
            calls: 1,
            scheduledInBlock: '1',
            verdict: 'mismatch',
            checks: [],
            reasons: ['targets: unknown'],
            cancelRecommendation: '',
            notes: [],
          },
        ],
      }),
    ])
    expect(findings.map((f) => [f.key, f.verdict])).toEqual([
      ['base:network', 'ok'],
      ['base:0xabc', 'mismatch'],
    ])
  })

  it('emits nothing for no reports', () => {
    expect(findingsOf([])).toEqual([])
  })
})

describe('openWatcherStore', () => {
  const READ_METHODS = new Set(['find', 'countDocuments'])

  const recordingClient = (touched: string[]) => {
    const collection = new Proxy(
      {},
      {
        get: (_, name: string) => {
          touched.push(name)
          if (name === 'find')
            return () => ({
              toArray: async () => [{ network: 'base', operationId: '0xABC' }],
            })
          return async () => 1
        },
      }
    )
    return {
      db: () => ({ collection: () => collection }),
      close: async () => undefined,
    } as unknown as ReturnType<
      NonNullable<Parameters<typeof openWatcherStore>[1]>
    >
  }

  it('calls no collection method but a read', async () => {
    const touched: string[] = []
    const store = await openWatcherStore('mongodb://fake', () =>
      recordingClient(touched)
    )
    expect(await store.signedSetExists('base', '0xabc')).toBe(true)
    await store.close()

    expect(store.queue).toEqual(new Map([['base', new Set(['0xabc'])]]))
    expect(touched.length).toBeGreaterThan(0)
    expect(touched.filter((name) => !READ_METHODS.has(name))).toEqual([])
  })
})

describe('readTimelockLogs', () => {
  const TIMELOCK = '0x5604A94A3438C3074EFFF803fab14B7244fe4E29'
  const OTHER = '0x70114d2a0ec788bafee869acf7fd1f8c76491799'

  it('drops logs another contract emitted, which an endpoint ignoring the address filter returns', async () => {
    let asked: unknown
    const reader = {
      getLogs: async (params: unknown) => {
        asked = params
        return [
          { address: OTHER, eventName: 'CallScheduled' },
          { address: TIMELOCK.toLowerCase(), eventName: 'CallSalt' },
        ]
      },
    } as unknown as PublicClient
    const logs = await readTimelockLogs(reader, TIMELOCK, 1n, 2n)
    expect(logs.map((log) => log.eventName)).toEqual(['CallSalt'])
    expect(asked).toMatchObject({
      address: TIMELOCK,
      fromBlock: 1n,
      toBlock: 2n,
    })
  })
})

describe('parseDeployLogHistory', () => {
  it('records the position each address was first added at, per name', () => {
    const patch = [
      'diff --git a/deployments/xlayer.json b/deployments/xlayer.json',
      '--- a/deployments/xlayer.json',
      '+++ b/deployments/xlayer.json',
      '@@ -0,0 +1,2 @@',
      '+  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1",',
      '+  "Note": "not an address",',
      '@@ -40 +40 @@',
      '-  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1",',
      '+  "FeeForwarder": "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd",',
      '@@ -40 +40 @@',
      '+  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1",',
      ' "Executor": "0x0000000000000000000000000000000000005555",',
    ].join('\n')
    expect(parseDeployLogHistory(patch)).toEqual(
      new Map([
        [
          'FeeForwarder',
          new Map([
            ['0xc18d9e84b8687a2645447a61e52c455dac1675e1', 0],
            ['0xce40449b773a3e6e5e769adb4e567179d4828cbd', 1],
          ]),
        ],
      ])
    )
  })

  it('reads every pair on a compact JSON line', () => {
    const patch =
      '+{"Executor":"0x0000000000000000000000000000000000005555",' +
      '"ERC20Proxy":"0x0000000000000000000000000000000000006666"}'
    expect(parseDeployLogHistory(patch)).toEqual(
      new Map([
        [
          'Executor',
          new Map([['0x0000000000000000000000000000000000005555', 0]]),
        ],
        [
          'ERC20Proxy',
          new Map([['0x0000000000000000000000000000000000006666', 1]]),
        ],
      ])
    )
  })
})

describe('createDeployLogHistoryReader', () => {
  const PATCH =
    '+  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1",'
  const LATER = Date.now() + 60_000 // 1 minute
  const anchor = async () => ({ ok: true as const, revision: 'abc123' })
  const gitOf = (answers: {
    shallow?: string
    log?: () => Promise<string>
    fail?: number
  }) => {
    const asked: string[][] = []
    let failures = answers.fail ?? 0
    const git = async (args: string[]): Promise<string> => {
      asked.push(args)
      if (failures > 0) {
        failures--
        throw new Error('git exploded')
      }
      if (args[0] === 'rev-parse') return answers.shallow ?? 'false\n'
      return answers.log ? answers.log() : PATCH
    }
    return { git, asked }
  }

  it("reads main's first-parent history at the pinned commit, once per network", async () => {
    const { git, asked } = gitOf({})
    const read = createDeployLogHistoryReader(anchor, git)
    const first = await read('xlayer', LATER)
    await read('xlayer', LATER)
    await read('mainnet', LATER)
    expect(first.ok && first.firstListed.get('FeeForwarder')).toEqual(
      new Map([['0xc18d9e84b8687a2645447a61e52c455dac1675e1', 0]])
    )
    const logs = asked.filter((args) => args[0] === 'log')
    expect(logs).toHaveLength(2)
    expect(logs[0]).toEqual(
      expect.arrayContaining([
        '--first-parent',
        '--diff-merges=first-parent',
        '--reverse',
        'abc123',
      ])
    )
    expect(logs[0]?.slice(-2)).toEqual(['--', 'deployments/xlayer.json'])
    expect(asked.filter((args) => args[0] === 'rev-parse')).toHaveLength(1)
  })

  it('retries a transient anchor failure but keeps a wrong remote', async () => {
    let calls = 0
    const flaky = async () => {
      calls++
      return { ok: false as const, reason: 'fetch-failed' as const }
    }
    const read = createDeployLogHistoryReader(flaky, gitOf({}).git)
    expect(await read('xlayer', LATER)).toEqual({
      ok: false,
      reason: 'origin/main could not be pinned (fetch-failed)',
    })
    await read('xlayer', LATER)
    expect(calls).toBe(2)

    let wrongCalls = 0
    const wrong = createDeployLogHistoryReader(async () => {
      wrongCalls++
      return { ok: false as const, reason: 'remote-unexpected' as const }
    }, gitOf({}).git)
    await wrong('xlayer', LATER)
    await wrong('xlayer', LATER)
    expect(wrongCalls).toBe(1)
  })

  it('is unreadable in a shallow clone, whose history would hide earlier addresses', async () => {
    const read = await createDeployLogHistoryReader(
      anchor,
      gitOf({ shallow: 'true\n' }).git
    )('xlayer', LATER)
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('shallow')
  })

  it('retries after git fails, rather than keeping the failure', async () => {
    const { git } = gitOf({ fail: 1 })
    const read = createDeployLogHistoryReader(anchor, git)
    const failed = await read('xlayer', LATER)
    expect(!failed.ok && failed.reason).toContain('git exploded')
    expect((await read('xlayer', LATER)).ok).toBe(true)
  })

  it('gives up at the deadline and reads again next time', async () => {
    let hang = true
    const { git } = gitOf({
      log: () =>
        hang ? new Promise<string>(() => undefined) : Promise.resolve(PATCH),
    })
    const read = createDeployLogHistoryReader(anchor, git)
    const late = await read('xlayer', Date.now() - 1)
    expect(!late.ok && late.reason).toContain('timed out')
    hang = false
    expect((await read('xlayer', LATER)).ok).toBe(true)
  })

  it('is unreadable when main has no history of the file', async () => {
    const empty = await createDeployLogHistoryReader(
      anchor,
      gitOf({ log: async () => '' }).git
    )('xlayer', LATER)
    expect(empty).toEqual({
      ok: false,
      reason: 'origin/main has no history of the file',
    })
  })
})
