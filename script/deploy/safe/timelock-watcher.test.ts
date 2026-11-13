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
import { InvalidParamsRpcError, RpcRequestError, type PublicClient } from 'viem'

import {
  LogEndpointsFailedError,
  createDeployLogHistoryReader,
  createLogRangeReader,
  findingsOf,
  jobFails,
  loadWatcherState,
  logScanFailureReason,
  openWatcherStore,
  parseDeployLogHistory,
  readTimelockLogs,
  unreadableReport,
  vouchedFloorOf,
  watchNetworkWithin,
  type ILogEndpoint,
  type INetworkFindings,
} from './timelock-watcher'
import {
  UNVERIFIED_PAGE_AFTER_RUNS,
  decideAlerts,
  planDelivery,
  type IAlertRecord,
  type IDeliveryState,
} from './timelock-watcher-alerts'
import { WatcherTimeoutError } from './timelock-watcher-rebuild'
import type {
  INetworkReport,
  IOperationReport,
} from './timelock-watcher-report'
import { LogRangeBehindError, advanceScan } from './timelock-watcher-scan'

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

describe('jobFails', () => {
  const report = (overrides: Partial<INetworkReport>): INetworkReport => ({
    network: 'base',
    status: 'watched',
    verdict: 'ok',
    operations: [],
    notes: [],
    ...overrides,
  })
  const unreadable = report({
    network: 'linea',
    status: 'unreadable',
    verdict: 'unverified',
    reason: 'the log scan failed',
  })
  const mismatchedOperation = report({
    operations: [
      {
        id: '0xabc',
        calls: 1,
        scheduledInBlock: '1',
        verdict: 'mismatch',
        checks: [],
        reasons: ['targets: unknown'],
        cancelRecommendation: '',
        notes: [],
      },
    ],
  })
  const mismatchedNetwork = report({ verdict: 'mismatch' })

  it('passes when some networks are unreadable, nothing mismatches and every alert was delivered', () => {
    expect(jobFails([report({}), unreadable], false)).toBe(false)
  })

  it('fails when the watcher crashed on a network', () => {
    expect(
      jobFails([report({}), { ...unreadable, crashed: true }], false)
    ).toBe(true)
  })

  it('fails when no network could be read, ignoring skipped and uncovered ones', () => {
    const skipped = report({ network: 'zksync', status: 'skipped' })
    const uncovered = report({
      network: 'tron',
      status: 'uncovered',
      verdict: 'unverified',
    })
    expect(jobFails([unreadable, skipped, uncovered], false)).toBe(true)
    expect(jobFails([skipped, uncovered], false)).toBe(false)
    expect(jobFails([], false)).toBe(false)
  })

  it('still pages on an unreadable network, through its unverified finding, after three runs', () => {
    expect(findingsOf([unreadable])).toEqual([
      {
        key: 'linea:network',
        network: 'linea',
        verdict: 'unverified',
        reasons: ['the log scan failed'],
      },
    ])
    let alerts: Record<string, IAlertRecord> = {}
    let delivery: IDeliveryState = { streaks: {}, held: [] }
    const paged: number[] = []
    for (let run = 1; run <= UNVERIFIED_PAGE_AFTER_RUNS; run++) {
      const now = new Date(Date.UTC(2026, 9, 28, 0, run * 10))
      const settled = new Set<string>()
      const decision = decideAlerts(
        alerts,
        findingsOf([unreadable]),
        settled,
        now
      )
      const plan = planDelivery(alerts, decision, delivery, settled, now)
      if (plan.actionable.some((a) => a.finding.key === 'linea:network'))
        paged.push(run)
      alerts = plan.next
      delivery = plan.delivered
    }
    expect(paged).toEqual([UNVERIFIED_PAGE_AFTER_RUNS])
  })

  for (const [name, reports, deliveryFailed] of [
    ['an operation mismatch', [mismatchedOperation], false],
    ['a network mismatch', [mismatchedNetwork], false],
    ['an undelivered alert', [report({})], true],
  ] as const)
    it(`fails on ${name}, with or without unreadable networks`, () => {
      expect(jobFails(reports, deliveryFailed)).toBe(true)
      expect(jobFails([...reports, unreadable], deliveryFailed)).toBe(true)
    })
})

describe('unreadableReport', () => {
  const OWNER_NOTE =
    'LiFiDiamond is owned by 0x01, not by the timelock main names; operations on that owner are not watched'

  it('is unverified when nothing was found before the read failed', () => {
    expect(unreadableReport('linea', 'the log scan failed')).toEqual({
      network: 'linea',
      status: 'unreadable',
      reason: 'the log scan failed',
      verdict: 'unverified',
      operations: [],
      notes: [],
    })
  })

  it('keeps an owner mismatch found before the scan failed, so it fails the job and pages at once', () => {
    const report = unreadableReport('linea', 'the log scan failed', {
      timelock: '0x02',
      mismatch: true,
      notes: [OWNER_NOTE],
    })
    expect(report.verdict).toBe('mismatch')
    expect(report.status).toBe('unreadable')
    expect(jobFails([report], false)).toBe(true)

    const now = new Date(Date.UTC(2026, 9, 29))
    const settled = new Set<string>()
    const decision = decideAlerts({}, findingsOf([report]), settled, now)
    const plan = planDelivery(
      {},
      decision,
      { streaks: {}, held: [] },
      settled,
      now
    )
    expect(plan.actionable.map((a) => a.finding)).toEqual([
      {
        key: 'linea:network',
        network: 'linea',
        verdict: 'mismatch',
        reasons: ['the log scan failed', OWNER_NOTE],
      },
    ])
  })
})

describe('watchNetworkWithin', () => {
  const OWNER_NOTE =
    'LiFiDiamond is owned by 0x01, not by the timelock main names; operations on that owner are not watched'
  const mismatchedOperation: IOperationReport = {
    id: '0xabc',
    calls: 1,
    scheduledInBlock: '1',
    verdict: 'mismatch',
    checks: [],
    reasons: ['targets: unknown'],
    cancelRecommendation: '',
    notes: [],
  }
  const readable: INetworkReport = {
    network: 'base',
    status: 'watched',
    verdict: 'ok',
    operations: [],
    notes: [],
  }
  const runContext = () => ({
    historyMs: 0,
    expired: new Set<string>(),
    found: new Map<string, INetworkFindings>(),
  })
  // Records findings the way watchNetwork does, then fails as the outer
  // timeout would.
  const failingWatch =
    (
      ctx: ReturnType<typeof runContext>,
      found: Partial<INetworkFindings>,
      error: Error = new WatcherTimeoutError('watching linea timed out')
    ) =>
    async (): Promise<INetworkReport> => {
      ctx.found.set('linea', {
        timelock: '0x02',
        mismatch: false,
        notes: [],
        operations: [],
        ...found,
      })
      throw error
    }

  it('keeps a network mismatch found before a timeout, so the job fails and it pages at once', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin(
      'linea',
      ctx,
      failingWatch(ctx, { mismatch: true, notes: [OWNER_NOTE] })
    )

    expect(report).toEqual({
      network: 'linea',
      status: 'unreadable',
      reason: 'the watcher failed on this network: watching linea timed out',
      timelock: '0x02',
      verdict: 'mismatch',
      operations: [],
      notes: [OWNER_NOTE],
    })
    expect(ctx.expired.has('linea')).toBe(true)
    expect(jobFails([readable, report], false)).toBe(true)

    const now = new Date(Date.UTC(2026, 10, 3))
    const settled = new Set(['base'])
    const decision = decideAlerts(
      {},
      findingsOf([readable, report]),
      settled,
      now
    )
    const plan = planDelivery(
      {},
      decision,
      { streaks: {}, held: [] },
      settled,
      now
    )
    expect(plan.actionable.map((a) => a.finding.key)).toEqual(['linea:network'])
  })

  it('keeps an operation graded mismatch before a timeout, so the job fails and it pages at once', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin(
      'linea',
      ctx,
      failingWatch(ctx, { operations: [mismatchedOperation] })
    )

    expect(report.verdict).toBe('unverified')
    expect(report.operations).toEqual([mismatchedOperation])
    expect(jobFails([readable, report], false)).toBe(true)

    const now = new Date(Date.UTC(2026, 10, 3))
    const settled = new Set(['base'])
    const decision = decideAlerts(
      {},
      findingsOf([readable, report]),
      settled,
      now
    )
    const plan = planDelivery(
      {},
      decision,
      { streaks: {}, held: [] },
      settled,
      now
    )
    expect(plan.actionable.map((a) => a.finding.key)).toEqual(['linea:0xabc'])
  })

  it('reports a copy, so a watch still running after its timeout cannot change it', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin(
      'linea',
      ctx,
      failingWatch(ctx, { notes: [OWNER_NOTE] })
    )
    const found = ctx.found.get('linea')
    found?.notes.push('a late note')
    found?.operations.push(mismatchedOperation)

    expect(report.notes).toEqual([OWNER_NOTE])
    expect(report.operations).toEqual([])
  })

  it('passes on a timeout that found nothing while another network was read', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin('linea', ctx, failingWatch(ctx, {}))

    expect(report.verdict).toBe('unverified')
    expect(report.crashed).toBeUndefined()
    expect(jobFails([readable, report], false)).toBe(false)
  })

  it('marks a watch that threw as crashed, keeping what it found', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin(
      'linea',
      ctx,
      failingWatch(ctx, { mismatch: true }, new Error('boom'))
    )

    expect(report.crashed).toBe(true)
    expect(report.verdict).toBe('mismatch')
    expect(report.reason).toBe('the watcher failed on this network: boom')
  })

  it('reports an unverified network when the watch failed before recording anything', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin('linea', ctx, async () => {
      throw new WatcherTimeoutError('watching linea timed out')
    })

    expect(report).toEqual(
      unreadableReport(
        'linea',
        'the watcher failed on this network: watching linea timed out'
      )
    )
  })

  it('returns the watch report unchanged when it finishes in time', async () => {
    const ctx = runContext()
    const report = await watchNetworkWithin('base', ctx, async () => readable)

    expect(report).toBe(readable)
    expect(ctx.expired.size).toBe(0)
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

describe('createLogRangeReader', () => {
  const TIMELOCK = '0x5604A94A3438C3074EFFF803fab14B7244fe4E29'
  const SCHEDULED = { address: TIMELOCK, eventName: 'CallScheduled' }

  /** An endpoint at `head` that answers `getLogs` with `answer`, counting its calls. */
  const endpoint = (
    host: string,
    head: bigint,
    answer: () => unknown[]
  ): ILogEndpoint & { calls: number } => {
    const made = {
      host,
      calls: 0,
      reader: {
        getBlockNumber: async () => head,
        getLogs: async () => {
          made.calls++
          return answer()
        },
      } as unknown as PublicClient,
    }
    return made
  }
  const refusing = (host: string, message: string) =>
    endpoint(host, 1_000n, () => {
      throw new Error(message)
    })
  const serving = (host: string) => endpoint(host, 1_000n, () => [SCHEDULED])

  const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise
    } catch (error) {
      return error
    }
    throw new Error('expected a rejection')
  }

  it("names each endpoint's host with its own redacted error when every endpoint fails", async () => {
    const read = createLogRangeReader(
      [
        refusing(
          'lb.drpc.org',
          'HTTP request failed.\n\nURL: https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY'
        ),
        refusing(
          'mainnet.base.org',
          'request limit reached at https://user:pw@mainnet.base.org/v1/PATHKEY'
        ),
        endpoint('base.llamarpc.com', 500n, () => []),
      ],
      TIMELOCK
    )
    const error = await rejectionOf(read(900n, 999n))
    expect(error).toBeInstanceOf(LogEndpointsFailedError)
    const reason = logScanFailureReason(error)
    expect(reason).toContain('lb.drpc.org: HTTP request failed.')
    expect(reason).toContain(
      'mainnet.base.org: request limit reached at [redacted-url]'
    )
    expect(reason).toContain(
      'base.llamarpc.com: the endpoint is at block 500, behind 999'
    )
    for (const leaked of [
      'SECRETKEY',
      'PATHKEY',
      'ogrpc',
      'dkey',
      '/v1',
      'user:pw',
      '://',
    ])
      expect(reason).not.toContain(leaked)
  })

  it('serves a range from the endpoint that answers when only some fail, and keeps using it', async () => {
    const failing = refusing('mainnet.base.org', 'request limit reached')
    const working = serving('lb.drpc.org')
    const read = createLogRangeReader([failing, working], TIMELOCK)
    expect(await read(1n, 100n)).toEqual([SCHEDULED] as never)
    expect(await read(101n, 200n)).toEqual([SCHEDULED] as never)
    expect(failing.calls).toBe(1)
    expect(working.calls).toBe(2)
  })

  it('reports a range every endpoint is behind as behind, not as a refusal', async () => {
    const read = createLogRangeReader(
      [endpoint('lb.drpc.org', 500n, () => [])],
      TIMELOCK
    )
    const error = await rejectionOf(read(900n, 999n))
    expect(error).toBeInstanceOf(LogRangeBehindError)
    expect((error as LogRangeBehindError).head).toBe(500n)
  })

  it('reads up to the furthest head when one endpoint is partway and another refuses', async () => {
    const read = createLogRangeReader(
      [
        endpoint('lb.drpc.org', 950n, () => []),
        refusing('mainnet.base.org', 'request limit reached'),
      ],
      TIMELOCK
    )
    const error = await rejectionOf(read(900n, 999n))
    expect(error).toBeInstanceOf(LogRangeBehindError)
    expect((error as LogRangeBehindError).head).toBe(950n)
    expect((error as LogRangeBehindError).refused).toBe(true)
  })

  it('leaves a scan with every endpoint failing unreadable, naming each endpoint', async () => {
    const read = createLogRangeReader(
      [
        refusing('lb.drpc.org', 'Invalid parameters were provided'),
        refusing('rpc.example.org', 'eth_getLogs does not exist'),
      ],
      TIMELOCK
    )
    const error = await rejectionOf(
      advanceScan(
        {
          timelock: TIMELOCK,
          operations: {},
          floor: '0',
          low: '0',
          high: '900',
        },
        {
          head: async () => 1_000n,
          floor: async () => 0n,
          getLogs: async (from, to) => {
            await read(from, to)
            return { scheduled: [], salts: [], cancels: [] }
          },
        },
        10
      )
    )
    expect(logScanFailureReason(error)).toBe(
      'the log scan failed: every endpoint failed blocks 644-653: lb.drpc.org: Invalid parameters were provided; rpc.example.org: eth_getLogs does not exist'
    )
  })

  it("names the provider's own reason behind viem's generic RPC error, without the URL", async () => {
    const providerError = new InvalidParamsRpcError(
      new RpcRequestError({
        body: { method: 'eth_getLogs' },
        url: 'https://rpc.example.org/v1/SECRETKEY',
        error: {
          code: -32602,
          message:
            'PARAM_VERIFY_ERROR: fromBlock is too far from the latest block',
        },
      })
    )
    const read = createLogRangeReader(
      [
        endpoint('rpc.example.org', 1_000n, () => {
          throw providerError
        }),
      ],
      TIMELOCK
    )
    const reason = logScanFailureReason(await rejectionOf(read(1n, 10n)))
    expect(reason).toContain(
      'rpc.example.org: Invalid parameters were provided to the RPC method. (PARAM_VERIFY_ERROR: fromBlock is too far from the latest block)'
    )
    expect(reason).not.toContain('SECRETKEY')
  })
})

describe('vouchedFloorOf', () => {
  const floors = {
    jovay: { block: '12921411', reason: 'checked by hand' },
    badBlock: { block: '0x10', reason: 'checked by hand' },
    noBlock: { reason: 'checked by hand' },
    noReason: { block: '5' },
    blankReason: { block: '5', reason: '  ' },
  }

  it('reads a configured floor', () => {
    expect(vouchedFloorOf('jovay', floors)).toEqual({
      block: 12_921_411n,
      reason: 'checked by hand',
    })
  })

  it('has none for a network the config omits, or without a config', () => {
    expect(vouchedFloorOf('mainnet', floors)).toBeUndefined()
    expect(vouchedFloorOf('mainnet', undefined)).toBeUndefined()
  })

  it.each([
    ['badBlock', 'block must be a decimal'],
    ['noBlock', 'block must be a decimal'],
    ['noReason', 'reason must say'],
    ['blankReason', 'reason must say'],
  ])('rejects a malformed %s entry', (network, message) => {
    expect(() => vouchedFloorOf(network, floors)).toThrow(message)
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
