/**
 * `runHealthCheckForNetwork` wiring: the report-only behind-main summary runs after the
 * invariants, in production only, and never changes the network's status.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  runHealthCheckForNetwork,
  type IHealthCheckRunStages,
} from './healthCheck'
import type { IHealthCheckContext } from './healthCheckInvariants'

const RPC_VAR = 'ETH_NODE_URI_GNOSIS'
// The stages are stubbed, so nothing dials this; it only has to let the client be built.
const UNUSED_RPC = 'http://127.0.0.1:9'
const SUMMARY = '[gnosis] behind main (report-only): stub-summary-7f3a'

let savedRpc: string | undefined
beforeAll(() => {
  savedRpc = process.env[RPC_VAR]
  process.env[RPC_VAR] = UNUSED_RPC
})
afterAll(() => {
  if (savedRpc === undefined) delete process.env[RPC_VAR]
  else process.env[RPC_VAR] = savedRpc
})

interface IStageCalls {
  invariants: IHealthCheckContext[]
  summaries: IHealthCheckContext[]
}

function stages(overrides: Partial<IHealthCheckRunStages> = {}): {
  stages: IHealthCheckRunStages
  calls: IStageCalls
} {
  const calls: IStageCalls = { invariants: [], summaries: [] }
  return {
    calls,
    stages: {
      runInvariants: async (ctx) => {
        calls.invariants.push(ctx)
        await overrides.runInvariants?.(ctx)
      },
      summarizeBehindMain: async (ctx) => {
        calls.summaries.push(ctx)
        return overrides.summarizeBehindMain
          ? overrides.summarizeBehindMain(ctx)
          : SUMMARY
      },
    },
  }
}

describe('runHealthCheckForNetwork behind-main wiring', () => {
  it('reports the summary on a passing production run', async () => {
    const { stages: s, calls } = stages()
    const result = await runHealthCheckForNetwork(
      'gnosis',
      'production',
      undefined,
      s
    )
    expect(result.status).toBe('passed')
    expect(result.behindMain).toBe(SUMMARY)
    expect(calls.summaries).toHaveLength(1)
    expect(calls.invariants).toHaveLength(1)
    expect(calls.summaries[0] === calls.invariants[0]).toBe(true)
  })

  it('keeps the status when the summary throws, and renders the failure into the line', async () => {
    const { stages: s } = stages({
      summarizeBehindMain: async () => {
        throw new Error('deploy log unreadable-91c2')
      },
    })
    const result = await runHealthCheckForNetwork(
      'gnosis',
      'production',
      undefined,
      s
    )
    expect(result.status).toBe('passed')
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.behindMain).toContain('unavailable')
    expect(result.behindMain).toContain('deploy log unreadable-91c2')
  })

  it('keeps a failed status when the summary throws', async () => {
    const { stages: s } = stages({
      runInvariants: async (ctx) => {
        ctx.logError('invariant-error-4d10')
      },
      summarizeBehindMain: async () => {
        throw new Error('boom')
      },
    })
    const result = await runHealthCheckForNetwork(
      'gnosis',
      'production',
      undefined,
      s
    )
    expect(result.status).toBe('failed')
    expect(result.errors).toEqual(['invariant-error-4d10'])
  })

  it('still reports the summary when the invariants abort', async () => {
    const { stages: s, calls } = stages({
      runInvariants: async () => {
        throw new Error('loupe exploded-5e88')
      },
    })
    const result = await runHealthCheckForNetwork(
      'gnosis',
      'production',
      undefined,
      s
    )
    expect(result.status).toBe('failed')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(
      'health check aborted: loupe exploded-5e88'
    )
    expect(calls.summaries).toHaveLength(1)
    expect(result.behindMain).toBe(SUMMARY)
  })

  it('omits the summary for staging', async () => {
    const { stages: s, calls } = stages()
    const result = await runHealthCheckForNetwork(
      'gnosis',
      'staging',
      undefined,
      s
    )
    // The invariants ran, so the omission is the environment gate, not an early abort.
    expect(calls.invariants).toHaveLength(1)
    expect(result.status).toBe('passed')
    expect(calls.summaries).toEqual([])
    expect('behindMain' in result).toBe(false)
  })
})
