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
  it('collects every address a commit added for each name', () => {
    const patch = [
      'diff --git a/deployments/xlayer.json b/deployments/xlayer.json',
      '--- a/deployments/xlayer.json',
      '+++ b/deployments/xlayer.json',
      '@@ -40 +40 @@',
      '-  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1",',
      '+  "FeeForwarder": "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd",',
      '@@ -0,0 +1,2 @@',
      '+  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1"',
      '+  "LiFiDiamond":"0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",',
      '+  "Note": "not an address",',
      ' "Executor": "0x0000000000000000000000000000000000005555",',
    ].join('\n')
    expect(parseDeployLogHistory(patch)).toEqual(
      new Map([
        [
          'FeeForwarder',
          new Set([
            '0xce40449b773a3e6e5e769adb4e567179d4828cbd',
            '0xc18d9e84b8687a2645447a61e52c455dac1675e1',
          ]),
        ],
        [
          'LiFiDiamond',
          new Set(['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae']),
        ],
      ])
    )
  })
})

describe('createDeployLogHistoryReader', () => {
  const PATCH =
    '+  "FeeForwarder": "0xC18D9E84b8687A2645447A61e52c455Dac1675e1",'
  const anchor = async () => ({ ok: true as const, revision: 'abc123' })
  const gitOf = (answers: {
    shallow?: string
    log?: string
    fail?: boolean
  }) => {
    const asked: string[][] = []
    const git = async (args: string[]): Promise<string> => {
      asked.push(args)
      if (answers.fail) throw new Error('git exploded')
      return args[0] === 'rev-parse'
        ? answers.shallow ?? 'false\n'
        : answers.log ?? PATCH
    }
    return { git, asked }
  }

  it("reads main's history of the network's deploy log at the pinned commit, once", async () => {
    const { git, asked } = gitOf({})
    const read = createDeployLogHistoryReader(anchor, git)
    const first = await read('xlayer')
    await read('xlayer')
    expect(first.ok && first.listed.get('FeeForwarder')).toEqual(
      new Set(['0xc18d9e84b8687a2645447a61e52c455dac1675e1'])
    )
    const logs = asked.filter((args) => args[0] === 'log')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('abc123')
    expect(logs[0]?.slice(-2)).toEqual(['--', 'deployments/xlayer.json'])
  })

  it('is unreadable when the anchor could not be pinned', async () => {
    const read = createDeployLogHistoryReader(
      async () => ({ ok: false as const, reason: 'fetch-failed' as const }),
      gitOf({}).git
    )
    expect(await read('xlayer')).toEqual({
      ok: false,
      reason: 'origin/main could not be pinned (fetch-failed)',
    })
  })

  it('is unreadable in a shallow clone, whose history would hide earlier addresses', async () => {
    const read = await createDeployLogHistoryReader(
      anchor,
      gitOf({ shallow: 'true\n' }).git
    )('xlayer')
    expect(read.ok).toBe(false)
    expect(!read.ok && read.reason).toContain('shallow')
  })

  it('is unreadable when git fails or finds no history', async () => {
    const failed = await createDeployLogHistoryReader(
      anchor,
      gitOf({ fail: true }).git
    )('xlayer')
    expect(!failed.ok && failed.reason).toContain('git exploded')
    const empty = await createDeployLogHistoryReader(
      anchor,
      gitOf({ log: '' }).git
    )('xlayer')
    expect(empty.ok).toBe(false)
  })
})
