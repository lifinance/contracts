/**
 * Tests for SlackNotifier's CI-link and payload-safety behavior: the optional
 * run URL must surface as a deep-link on failure/summary messages, and
 * oversized error text must be clamped so Slack never rejects the blocks.
 */
import {
  afterEach,
  describe,
  expect,
  it,
  mock,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { SlackNotifier } from './slack-notifier'
import type { ISlackMessage } from './slack-notifier'

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xxx'
const RUN_URL = 'https://github.com/lifinance/contracts/actions/runs/1/job/2'

interface ICapturedBlock {
  type: string
  text?: { type: string; text: string }
  elements?: { type: string; text: string }[]
}

/**
 * Stub global fetch so notifications are captured instead of sent. Returns the
 * parsed Slack payload from the most recent call.
 */
function mockFetchCapturing(): () => ISlackMessage {
  let lastBody = ''
  global.fetch = mock(async (_url: string, init?: { body?: string }) => {
    lastBody = init?.body ?? ''
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
  return () => JSON.parse(lastBody) as ISlackMessage
}

const baseOp = {
  id: '0xabc123' as `0x${string}`,
  target: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  value: 0n,
  data: '0x' as `0x${string}`,
  functionName: 'batch',
}

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  mock.restore()
})

describe('SlackNotifier run-link', () => {
  it('appends a "View workflow run" context block to failures when runUrl is set', async () => {
    const getPayload = mockFetchCapturing()
    await new SlackNotifier(WEBHOOK, RUN_URL).notifyOperationFailed({
      network: 'tron',
      operation: baseOp,
      status: 'failed',
      error: new Error('boom'),
    })

    const blocks = (getPayload().blocks ?? []) as unknown as ICapturedBlock[]
    const ctx = blocks.find((b) => b.type === 'context')
    expect(ctx).toBeDefined()
    expect(ctx?.elements?.[0]?.text).toBe(`<${RUN_URL}|View workflow run>`)
  })

  it('omits the run-link block when no runUrl is configured', async () => {
    const getPayload = mockFetchCapturing()
    await new SlackNotifier(WEBHOOK).notifyOperationFailed({
      network: 'tron',
      operation: baseOp,
      status: 'failed',
      error: new Error('boom'),
    })

    const blocks = (getPayload().blocks ?? []) as unknown as ICapturedBlock[]
    expect(blocks.some((b) => b.type === 'context')).toBe(false)
  })

  it('adds the run-link to batch summaries as well', async () => {
    const getPayload = mockFetchCapturing()
    await new SlackNotifier(WEBHOOK, RUN_URL).notifyBatchSummary([
      { network: 'tron', success: false, error: new Error('nope') },
    ])

    const blocks = (getPayload().blocks ?? []) as unknown as ICapturedBlock[]
    expect(blocks.some((b) => b.type === 'context')).toBe(true)
  })
})

describe('SlackNotifier payload safety', () => {
  it('clamps an oversized error message below the Slack 3000-char block limit', async () => {
    const getPayload = mockFetchCapturing()
    const huge = 'x'.repeat(8000)
    await new SlackNotifier(WEBHOOK).notifyOperationFailed({
      network: 'tron',
      operation: baseOp,
      status: 'failed',
      error: new Error(huge),
    })

    const blocks = (getPayload().blocks ?? []) as unknown as ICapturedBlock[]
    const errorBlock = blocks.find((b) => b.text?.text?.includes('*Error:*'))
    expect(errorBlock).toBeDefined()
    expect(errorBlock?.text?.text.length ?? 0).toBeLessThanOrEqual(3000)
  })
})
