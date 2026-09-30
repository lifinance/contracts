/**
 * On-chain discovery of scheduled `LiFiTimelockController` operations, from
 * `CallScheduled` and `CallSalt` logs, for the report-only timelock watcher.
 *
 * Import it from `timelock-watcher.ts`. It keeps one contiguous scanned block
 * interval per network and grows it both ways across runs: forward to the head
 * first, so a new schedule is seen on the next run, then backward towards the
 * timelock's creation block within a per-run call budget.
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem'

import { computeOperationIdBatch } from './timelock-queue'

export const CALL_SCHEDULED_EVENT = parseAbiItem(
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)'
)

export const CALL_SALT_EVENT = parseAbiItem(
  'event CallSalt(bytes32 indexed id, bytes32 salt)'
)

export const CANCELLED_EVENT = parseAbiItem(
  'event Cancelled(bytes32 indexed id)'
)

const ZERO_SALT: Hex = `0x${'0'.repeat(64)}`

/**
 * Blocks re-read below the scanned head on every run. A reorg that replaces
 * blocks the previous run already read would otherwise hide a schedule landing
 * in them; 256 blocks is deeper than any reorg the fleet has shown.
 */
export const REORG_MARGIN_BLOCKS = 256n

/** Widest single `eth_getLogs` range tried; shrunk on every rejection. */
export const MAX_LOG_SPAN = 100_000_000n

/** Narrowest range tried before a network counts as unreadable. */
export const MIN_LOG_SPAN = 100n

/** Factor a refused range shrinks by: few steps from the widest span to the narrowest. */
const SPAN_SHRINK = 10n

/** One decoded `CallScheduled` log. */
export interface IScheduledCallLog {
  id: Hex
  index: bigint
  target: Address
  value: bigint
  data: Hex
  predecessor: Hex
  delay: bigint
  blockNumber: bigint
}

/** One decoded `CallSalt` log. */
export interface ICallSaltLog {
  id: Hex
  salt: Hex
}

/** One decoded `Cancelled` log. */
export interface ICancelledLog {
  id: Hex
  blockNumber: bigint
}

/** Logs one `eth_getLogs` range returned, by event. */
export interface IRangeLogs {
  scheduled: IScheduledCallLog[]
  salts: ICallSaltLog[]
  cancels: ICancelledLog[]
}

/** One call of a scheduled operation, JSON-safe. */
export interface IScannedCall {
  index: number
  target: Address
  value: string
  data: Hex
}

/** A scheduled operation as its logs describe it, JSON-safe. */
export interface IScannedOperation {
  id: Hex
  calls: IScannedCall[]
  predecessor: Hex
  delay: string
  salt: Hex
  /** Block of the latest `CallScheduled` log seen for this id. */
  blockNumber: string
  /** Block of the latest `Cancelled` log seen for this id, if any. */
  cancelledInBlock?: string
  /** Runs in which `getTimestamp` read 0 with no `Cancelled` log to explain it; a failed read neither counts nor resets. */
  unsetReads?: number
}

/** What a network's scan has covered so far, JSON-safe. */
export interface INetworkScanState {
  timelock: Address
  /** First block the timelock can have emitted a log in. */
  floor?: string
  /** Lowest block scanned; with `high`, the interval `[low, high]` is complete. */
  low?: string
  high?: string
  /** Widest `eth_getLogs` range this network's endpoints last accepted. */
  span?: string
  operations: Record<string, IScannedOperation>
  /**
   * Latest `Cancelled` block per lowercased id, including ids whose schedule
   * the history leg has not reached yet: walking down, it reads a cancel before
   * the schedule it undoes.
   */
  cancels?: Record<string, string>
}

/**
 * No endpoint has reached the end of the range yet. Not a refusal: a narrower
 * range would not help, so the leg reads up to `head`, the furthest an
 * endpoint has reached, and stops there.
 */
export class LogRangeBehindError extends Error {
  public constructor(message: string, public readonly head: bigint) {
    super(message)
  }
}

export interface IScanDependencies {
  head: () => Promise<bigint>
  /** Resolves the creation block of the timelock; undefined when it could not. */
  floor: () => Promise<bigint | undefined>
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<IRangeLogs>
}

/** Calls a scan leg may still make, and the clock time it must stop by. */
interface IBudget {
  left: number
  until?: number
  now?: () => number
}

const hasBudget = (budget: IBudget): boolean =>
  budget.left > 0 &&
  (budget.until === undefined || (budget.now ?? Date.now)() < budget.until)

export interface IScanOutcome {
  state: INetworkScanState
  head: bigint
  /** True once `[floor, head]` is covered. */
  historyComplete: boolean
  /** Blocks between the head and the highest block scanned. */
  forwardLag: bigint
  logCalls: number
  /** `CallScheduled` logs read this run. */
  scheduledLogs: number
  /** Why the history leg stopped early, when it failed rather than ran out of budget. */
  historyError?: string
}

/**
 * Starts or reuses a network's scan state.
 *
 * @param previous - The state the last run saved, if any.
 * @param timelock - The timelock address this run watches.
 * @returns The previous state when it describes the same timelock, else a fresh one.
 */
export const initialScanState = (
  previous: INetworkScanState | undefined,
  timelock: Address
): INetworkScanState =>
  previous && previous.timelock.toLowerCase() === timelock.toLowerCase()
    ? previous
    : { timelock, operations: {} }

/**
 * Folds decoded logs into the operations map.
 *
 * The call bytes, predecessor and salt are part of the id, so every log for
 * one id agrees on them. The delay is not: an operation cancelled and then
 * scheduled again under the same id can carry a different delay, and only the
 * newest schedule's is live, whatever order the legs read them in.
 *
 * @param operations - Operations known so far, keyed by lowercased id.
 * @param logs - Logs of one or more ranges.
 * @returns A new map holding every operation the logs name.
 */
export const mergeScheduledLogs = (
  operations: Record<string, IScannedOperation>,
  logs: IRangeLogs
): Record<string, IScannedOperation> => {
  const merged: Record<string, IScannedOperation> = { ...operations }
  for (const log of logs.scheduled) {
    const key = log.id.toLowerCase()
    const existing = merged[key]
    const call: IScannedCall = {
      index: Number(log.index),
      target: log.target,
      value: log.value.toString(),
      data: log.data,
    }
    const calls = (existing?.calls ?? []).filter((c) => c.index !== call.index)
    calls.push(call)
    calls.sort((a, b) => a.index - b.index)
    const existingIsNewer =
      existing !== undefined && BigInt(existing.blockNumber) > log.blockNumber
    merged[key] = {
      ...existing,
      id: key as Hex,
      calls,
      predecessor: log.predecessor,
      delay: existingIsNewer ? existing.delay : log.delay.toString(),
      salt: existing?.salt ?? ZERO_SALT,
      blockNumber: existingIsNewer
        ? existing.blockNumber
        : log.blockNumber.toString(),
    }
  }
  for (const salt of logs.salts) {
    const existing = merged[salt.id.toLowerCase()]
    if (existing) merged[existing.id] = { ...existing, salt: salt.salt }
  }
  for (const cancel of logs.cancels) {
    const existing = merged[cancel.id.toLowerCase()]
    if (
      existing &&
      (existing.cancelledInBlock === undefined ||
        BigInt(existing.cancelledInBlock) < cancel.blockNumber)
    )
      merged[existing.id] = {
        ...existing,
        cancelledInBlock: cancel.blockNumber.toString(),
      }
  }
  return merged
}

const emptyLogs = (): IRangeLogs => ({ scheduled: [], salts: [], cancels: [] })

/** Folds cancel logs into the per-id latest-cancel map. */
const mergeCancels = (
  cancels: Readonly<Record<string, string>>,
  logs: readonly ICancelledLog[]
): Record<string, string> => {
  const merged = { ...cancels }
  for (const log of logs) {
    const key = log.id.toLowerCase()
    const seen = merged[key]
    if (seen === undefined || BigInt(seen) < log.blockNumber)
      merged[key] = log.blockNumber.toString()
  }
  return merged
}

const appendLogs = (into: IRangeLogs, from: IRangeLogs): void => {
  into.scheduled.push(...from.scheduled)
  into.salts.push(...from.salts)
  into.cancels.push(...from.cancels)
}

/**
 * Whether a logged operation was cancelled after it was last scheduled, so
 * that `getTimestamp` reading 0 is explained rather than a lagging node.
 *
 * @param op - The operation.
 * @param cancels - The network's cancels by id, from its scan state.
 * @returns True when a `Cancelled` log follows its latest `CallScheduled`.
 */
export const isProvenCancelled = (
  op: IScannedOperation,
  cancels: Readonly<Record<string, string>> = {}
): boolean => {
  const latest = [op.cancelledInBlock, cancels[op.id.toLowerCase()]]
    .filter((b): b is string => b !== undefined)
    .map(BigInt)
    .reduce((a, b) => (a > b ? a : b), -1n)
  return latest >= BigInt(op.blockNumber)
}

/**
 * Reads logs over `[from, to]`, splitting the range whenever an endpoint
 * refuses it, and stopping at the furthest block an endpoint has reached.
 *
 * @param deps - The log reader.
 * @param from - First block, inclusive.
 * @param to - Last block, inclusive.
 * @param span - Range to try first.
 * @param budget - Calls left; decremented per attempt.
 * @returns The logs, the span that worked, and the last block read.
 * @throws When even {@link MIN_LOG_SPAN} is refused.
 */
const readRange = async (
  deps: IScanDependencies,
  from: bigint,
  to: bigint,
  span: bigint,
  budget: IBudget
): Promise<{ logs: IRangeLogs; span: bigint; reachedTo: bigint }> => {
  const logs = emptyLogs()
  let cursor = from
  let width = span
  let stopAt = to
  while (cursor <= stopAt && hasBudget(budget)) {
    const end = cursor + width - 1n < stopAt ? cursor + width - 1n : stopAt
    budget.left--
    try {
      appendLogs(logs, await deps.getLogs(cursor, end))
      cursor = end + 1n
    } catch (error) {
      if (error instanceof LogRangeBehindError) {
        if (error.head < cursor || error.head >= end) break
        stopAt = error.head
        continue
      }
      if (width <= MIN_LOG_SPAN) throw error
      width =
        width / SPAN_SHRINK > MIN_LOG_SPAN ? width / SPAN_SHRINK : MIN_LOG_SPAN
    }
  }
  return { logs, span: width, reachedTo: cursor - 1n }
}

/**
 * Same as {@link readRange}, walking from `to` down towards `from`, up to
 * `parallel` ranges at a time. Only the unbroken run of answered ranges just
 * below the cursor is kept, so a partial or failed run always leaves the
 * scanned interval contiguous; a failure is returned with what was reached
 * rather than thrown.
 */
const readRangeDownward = async (
  deps: IScanDependencies,
  from: bigint,
  to: bigint,
  span: bigint,
  budget: IBudget,
  parallel: number
): Promise<{
  logs: IRangeLogs
  span: bigint
  reachedFrom: bigint
  error?: unknown
}> => {
  const logs = emptyLogs()
  let width = span
  let reachedFrom = to + 1n
  while (reachedFrom > from && hasBudget(budget)) {
    const ranges: [bigint, bigint][] = []
    let top = reachedFrom - 1n
    while (
      ranges.length < parallel &&
      ranges.length < budget.left &&
      top >= from
    ) {
      const start = top - width + 1n > from ? top - width + 1n : from
      ranges.push([start, top])
      if (start === from) break
      top = start - 1n
    }
    budget.left -= ranges.length
    const answers = await Promise.allSettled(
      ranges.map(([start, end]) => deps.getLogs(start, end))
    )
    let refused: unknown
    for (const [i, answer] of answers.entries()) {
      if (answer.status === 'rejected') {
        refused = answer.reason ?? new Error('eth_getLogs was refused')
        break
      }
      appendLogs(logs, answer.value)
      reachedFrom = (ranges[i] as [bigint, bigint])[0]
    }
    if (refused !== undefined) {
      if (refused instanceof LogRangeBehindError || width <= MIN_LOG_SPAN)
        return { logs, span: width, reachedFrom, error: refused }
      width =
        width / SPAN_SHRINK > MIN_LOG_SPAN ? width / SPAN_SHRINK : MIN_LOG_SPAN
    }
  }
  return { logs, span: width, reachedFrom }
}

/**
 * Advances a network's scan: head first, then history, within `logBudget`
 * `eth_getLogs` calls.
 *
 * The forward leg runs first and has no call budget: it is what makes a fresh
 * schedule visible within one run. It stops at the history deadline too, and
 * keeps what it read, so a long gap is caught up over several runs rather than
 * overrunning the network's time on every one. A history range no endpoint
 * will serve stops the history leg and is reported in `historyError`; it does
 * not discard what the forward leg found.
 *
 * @param previous - State from the last run, already matched to this timelock.
 * @param deps - Chain readers.
 * @param logBudget - Calls the backward (history) leg may spend.
 * @param history - Clock time the backward leg must stop by, the clock, and
 *   how many ranges it may read at once.
 * @returns The advanced state and whether history is complete.
 * @throws When the head, the floor or a range of the forward leg cannot be read.
 */
export const advanceScan = async (
  previous: INetworkScanState,
  deps: IScanDependencies,
  logBudget: number,
  history: { until?: number; now?: () => number; parallel?: number } = {}
): Promise<IScanOutcome> => {
  const head = await deps.head()
  // A floor that could not be resolved is not saved, so the next run retries it.
  const resolvedFloor =
    previous.floor !== undefined ? BigInt(previous.floor) : await deps.floor()
  const floor = resolvedFloor ?? 0n
  // One step wider than last time: a span that shrank on a transient refusal
  // would otherwise stay narrow for good, at up to ten times the calls.
  const widened =
    previous.span !== undefined
      ? BigInt(previous.span) * SPAN_SHRINK
      : MAX_LOG_SPAN
  let span = widened < MAX_LOG_SPAN ? widened : MAX_LOG_SPAN
  let operations = previous.operations
  let cancels = previous.cancels ?? {}
  let logCalls = 0
  let scheduledLogs = 0
  let historyError: string | undefined

  const high = previous.high !== undefined ? BigInt(previous.high) : undefined
  const forwardFrom =
    high === undefined
      ? head
      : high > REORG_MARGIN_BLOCKS
      ? high - REORG_MARGIN_BLOCKS
      : 0n
  const forwardBudget: IBudget = {
    left: Number.MAX_SAFE_INTEGER,
    ...(history.until !== undefined ? { until: history.until } : {}),
    ...(history.now ? { now: history.now } : {}),
  }
  const forward = await readRange(deps, forwardFrom, head, span, forwardBudget)
  const reached =
    high !== undefined && high > forward.reachedTo ? high : forward.reachedTo
  logCalls += Number.MAX_SAFE_INTEGER - forwardBudget.left
  operations = mergeScheduledLogs(operations, forward.logs)
  cancels = mergeCancels(cancels, forward.logs.cancels)
  scheduledLogs += forward.logs.scheduled.length
  span = forward.span

  let low = previous.low !== undefined ? BigInt(previous.low) : forwardFrom
  if (low > floor) {
    const historyBudget: IBudget = {
      left: logBudget,
      ...(history.until !== undefined ? { until: history.until } : {}),
      ...(history.now ? { now: history.now } : {}),
    }
    const backward = await readRangeDownward(
      deps,
      floor,
      low - 1n,
      span,
      historyBudget,
      history.parallel ?? 1
    )
    logCalls += logBudget - historyBudget.left
    operations = mergeScheduledLogs(operations, backward.logs)
    cancels = mergeCancels(cancels, backward.logs.cancels)
    scheduledLogs += backward.logs.scheduled.length
    span = backward.span
    low = backward.reachedFrom
    if (backward.error !== undefined)
      historyError =
        backward.error instanceof Error
          ? backward.error.message
          : String(backward.error)
  }

  return {
    head,
    logCalls,
    scheduledLogs,
    historyComplete: low <= floor,
    forwardLag: head - reached,
    ...(historyError !== undefined ? { historyError } : {}),
    state: {
      timelock: previous.timelock,
      ...(resolvedFloor !== undefined
        ? { floor: resolvedFloor.toString() }
        : {}),
      low: low.toString(),
      high: reached.toString(),
      span: span.toString(),
      operations,
      cancels,
    },
  }
}

/**
 * Finds the first block at which `hasCode` holds, by bisection.
 *
 * @param head - A block at which the code is known to exist.
 * @param hasCode - Whether the timelock has code at a block.
 * @returns The creation block.
 * @throws When the code is absent at `head`, or a historical read fails.
 */
export const bisectCreationBlock = async (
  head: bigint,
  hasCode: (block: bigint) => Promise<boolean>
): Promise<bigint> => {
  if (!(await hasCode(head)))
    throw new Error(`the timelock has no code at block ${head}`)
  let lo = 0n
  let hi = head
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (await hasCode(mid)) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/** The two ways OZ derives an id from the same parameters. */
export interface IRecomputedIds {
  batch: Hex
  /** Only for a one-call operation, which `schedule` may have produced. */
  single?: Hex
}

/**
 * Recomputes an operation's id from its logged parameters.
 *
 * @param op - The operation as its logs describe it.
 * @returns The `hashOperationBatch` id and, for one call, the `hashOperation` id,
 *   or `undefined` when the logged call indices are not `0..n-1`.
 */
export const recomputeOperationIds = (
  op: IScannedOperation
): IRecomputedIds | undefined => {
  if (op.calls.length === 0) return undefined
  if (op.calls.some((call, i) => call.index !== i)) return undefined
  const batch = computeOperationIdBatch(
    op.calls.map((c) => c.target),
    op.calls.map((c) => BigInt(c.value)),
    op.calls.map((c) => c.data),
    op.predecessor,
    op.salt
  )
  const [only] = op.calls
  if (op.calls.length !== 1 || !only) return { batch }
  const single = keccak256(
    encodeAbiParameters(
      [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'predecessor', type: 'bytes32' },
        { name: 'salt', type: 'bytes32' },
      ],
      [only.target, BigInt(only.value), only.data, op.predecessor, op.salt]
    )
  )
  return { batch, single }
}
