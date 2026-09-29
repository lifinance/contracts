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
  type IExecutionSummaryEntry,
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
    proposalKey: 'proposal-1',
  }
}

function entryFor(
  s: IRunSubmissionRecord,
  error: string
): IExecutionSummaryEntry {
  return {
    chain: 'mainnet',
    safeTxHash: HASH,
    rowId: s.rowId.toHexString(),
    error,
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

function stateWithTimeout(s: IRunSubmissionRecord): IRunSummaryState {
  return {
    failed: [],
    timedOut: [entryFor(s, 'timeout')],
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
    const state = stateWithTimeout(s)

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
      failed: [entryFor(s, 'write failed')],
      timedOut: [],
      outcomes: [outcome()],
    }

    applyRunSubmissionStatuses([s], statusOf(s, 'executed'), state)

    expect(state.failed).toEqual([])
    expect(rollUpQueue(state.outcomes).rollups[0]?.executed).toBe(1)
  })

  it('lists a reverted execution as failed', () => {
    const s = submission()
    const state = stateWithTimeout(s)

    applyRunSubmissionStatuses([s], statusOf(s, 'reverted'), state)

    expect(state.timedOut).toEqual([])
    expect(state.failed).toEqual([entryFor(s, 'on-chain revert')])
    expect(rollUpQueue(state.outcomes).rollups[0]?.executed).toBe(0)
  })

  it('lists a timed-out execution whose row is back to pending as failed', () => {
    const s = submission()
    const state = stateWithTimeout(s)

    applyRunSubmissionStatuses([s], statusOf(s, 'pending'), state)

    expect(state.timedOut).toEqual([])
    expect(state.failed).toEqual([
      entryFor(s, 'row is pending — execution not confirmed on-chain'),
    ])
  })

  it('keeps the original error on a failed entry whose row is pending', () => {
    const s = submission()
    const state: IRunSummaryState = {
      failed: [entryFor(s, 'write failed')],
      timedOut: [],
      outcomes: [],
    }

    applyRunSubmissionStatuses([s], statusOf(s, 'pending'), state)

    expect(state.failed).toEqual([entryFor(s, 'write failed')])
  })

  it('leaves a still-submitted or unknown execution timed out', () => {
    const submitted = submission()
    const unknown = submission()
    const state: IRunSummaryState = {
      failed: [],
      timedOut: [entryFor(submitted, 'timeout'), entryFor(unknown, 'timeout')],
      outcomes: [outcome()],
    }

    const stillSubmitted = applyRunSubmissionStatuses(
      [submitted, unknown],
      statusOf(submitted, 'submitted'),
      state
    )

    expect(stillSubmitted).toBe(1)
    expect(state.timedOut).toHaveLength(2)
    expect(state.outcomes).toHaveLength(1)
  })

  it("resolves only its own row's entry when two rows share a safeTxHash", () => {
    // A failed write left one row's entry under Failed, while another row with
    // the same safeTxHash timed out; the executed one must clear only its own.
    const executed = submission()
    const other = submission()
    const state: IRunSummaryState = {
      failed: [entryFor(other, 'write failed')],
      timedOut: [entryFor(executed, 'timeout')],
      outcomes: [],
    }

    applyRunSubmissionStatuses(
      [executed, other],
      new Map([
        [executed.rowId.toHexString(), 'executed'],
        [other.rowId.toHexString(), 'pending'],
      ]),
      state
    )

    expect(state.timedOut).toEqual([])
    expect(state.failed).toEqual([entryFor(other, 'write failed')])
  })
})
