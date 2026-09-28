/**
 * Tests for how the end-of-run reconcile's statuses land in confirm-safe-tx's
 * execution summary and queue outcomes.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { ObjectId } from 'mongodb'
import { type Hex } from 'viem'

import { rollUpQueue, type INetworkOutcome } from './confirm-safe-tx-ack'
import {
  applyRunSubmissionStatuses,
  type IRunSubmissionRecord,
  type IRunSummaryState,
} from './run-submission-summary'
import { type SafeTxStatus } from './safe-utils'

const HASH = ('0x' + 'e1'.repeat(32)) as Hex
const ACK_KEY = ('0x' + 'a1'.repeat(32)) as Hex

function submission(): IRunSubmissionRecord {
  return {
    network: 'mainnet',
    rowId: new ObjectId(),
    chain: 'mainnet',
    safeTxHash: HASH,
    proposalKey: 'proposal-1',
  }
}

function outcome(): INetworkOutcome {
  return {
    network: 'mainnet',
    proposalKey: 'proposal-1',
    acknowledgementKey: ACK_KEY,
    fingerprint: ACK_KEY,
    signatures: 3,
    threshold: 3,
    nonceCurrent: true,
    signedThisRun: true,
    executedThisRun: false,
    blocked: false,
    alreadySigned: false,
  }
}

function stateWithTimeout(): IRunSummaryState {
  return {
    failed: [],
    timedOut: [{ chain: 'mainnet', safeTxHash: HASH, error: 'timeout' }],
    outcomes: [outcome()],
  }
}

function statusOf(
  s: IRunSubmissionRecord,
  status: SafeTxStatus
): Map<string, SafeTxStatus> {
  return new Map([[s.rowId.toHexString(), status]])
}

describe('applyRunSubmissionStatuses', () => {
  it('counts a late-confirmed execution as executed and clears its timeout', () => {
    const s = submission()
    const state = stateWithTimeout()

    const stillSubmitted = applyRunSubmissionStatuses(
      [s],
      statusOf(s, 'executed'),
      state
    )

    expect(stillSubmitted).toBe(0)
    expect(state.timedOut).toEqual([])
    expect(state.failed).toEqual([])
    expect(rollUpQueue(state.outcomes).rollups[0]?.executed).toBe(1)
  })

  it('clears a failed entry once the execution is found executed', () => {
    // The status write threw after the broadcast, so the execution was listed
    // as failed with the write's error.
    const s = submission()
    const state: IRunSummaryState = {
      failed: [{ chain: 'mainnet', safeTxHash: HASH, error: 'write failed' }],
      timedOut: [],
      outcomes: [outcome()],
    }

    applyRunSubmissionStatuses([s], statusOf(s, 'executed'), state)

    expect(state.failed).toEqual([])
    expect(rollUpQueue(state.outcomes).rollups[0]?.executed).toBe(1)
  })

  it('lists a reverted execution as failed', () => {
    const s = submission()
    const state = stateWithTimeout()

    applyRunSubmissionStatuses([s], statusOf(s, 'reverted'), state)

    expect(state.timedOut).toEqual([])
    expect(state.failed).toEqual([
      { chain: 'mainnet', safeTxHash: HASH, error: 'on-chain revert' },
    ])
    expect(rollUpQueue(state.outcomes).rollups[0]?.executed).toBe(0)
  })

  it('lists a timed-out execution whose row is back to pending as failed', () => {
    const s = submission()
    const state = stateWithTimeout()

    applyRunSubmissionStatuses([s], statusOf(s, 'pending'), state)

    expect(state.timedOut).toEqual([])
    expect(state.failed[0]?.error).toBe(
      'row is pending — execution not confirmed on-chain'
    )
  })

  it('keeps the original error on a failed entry whose row is pending', () => {
    const s = submission()
    const failed = [
      { chain: 'mainnet', safeTxHash: HASH, error: 'write failed' },
    ]
    const state: IRunSummaryState = { failed, timedOut: [], outcomes: [] }

    applyRunSubmissionStatuses([s], statusOf(s, 'pending'), state)

    expect(state.failed).toEqual([
      { chain: 'mainnet', safeTxHash: HASH, error: 'write failed' },
    ])
  })

  it('leaves a still-submitted or unknown execution timed out', () => {
    const submitted = submission()
    const unknown = submission()
    const state = stateWithTimeout()

    const stillSubmitted = applyRunSubmissionStatuses(
      [submitted, unknown],
      statusOf(submitted, 'submitted'),
      state
    )

    expect(stillSubmitted).toBe(1)
    expect(state.timedOut).toHaveLength(1)
    expect(state.outcomes).toHaveLength(1)
  })

  it('matches a summary entry by chain as well as safeTxHash', () => {
    const s = submission()
    const state: IRunSummaryState = {
      failed: [],
      timedOut: [{ chain: 'base', safeTxHash: HASH, error: 'timeout' }],
      outcomes: [],
    }

    applyRunSubmissionStatuses([s], statusOf(s, 'reverted'), state)

    expect(state.timedOut).toHaveLength(1)
    expect(state.failed).toEqual([])
  })
})
