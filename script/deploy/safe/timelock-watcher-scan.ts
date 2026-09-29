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
}

export interface IScanDependencies {
  head: () => Promise<bigint>
  /** Resolves the creation block of the timelock. */
  floor: () => Promise<bigint>
  getLogs: (
    fromBlock: bigint,
    toBlock: bigint
  ) => Promise<{ scheduled: IScheduledCallLog[]; salts: ICallSaltLog[] }>
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
  logCalls: number
  /** `CallScheduled` logs read this run. */
  scheduledLogs: number
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
 * @param operations - Operations known so far, keyed by lowercased id.
 * @param scheduled - `CallScheduled` logs.
 * @param salts - `CallSalt` logs.
 * @returns A new map holding every operation the logs name.
 */
export const mergeScheduledLogs = (
  operations: Record<string, IScannedOperation>,
  scheduled: readonly IScheduledCallLog[],
  salts: readonly ICallSaltLog[]
): Record<string, IScannedOperation> => {
  const merged: Record<string, IScannedOperation> = { ...operations }
  for (const log of scheduled) {
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
    const block =
      existing && BigInt(existing.blockNumber) > log.blockNumber
        ? existing.blockNumber
        : log.blockNumber.toString()
    merged[key] = {
      id: key as Hex,
      calls,
      predecessor: log.predecessor,
      delay: log.delay.toString(),
      salt: existing?.salt ?? ZERO_SALT,
      blockNumber: block,
    }
  }
  for (const salt of salts) {
    const existing = merged[salt.id.toLowerCase()]
    if (existing) existing.salt = salt.salt
  }
  return merged
}

/**
 * Reads logs over `[from, to]`, splitting the range whenever an endpoint
 * refuses it.
 *
 * @param deps - The log reader.
 * @param from - First block, inclusive.
 * @param to - Last block, inclusive.
 * @param span - Range to try first.
 * @param budget - Calls left; decremented per attempt.
 * @returns The logs, the span that worked, and whether the budget ran out first.
 * @throws When even {@link MIN_LOG_SPAN} is refused.
 */
const readRange = async (
  deps: IScanDependencies,
  from: bigint,
  to: bigint,
  span: bigint,
  budget: IBudget
): Promise<{
  scheduled: IScheduledCallLog[]
  salts: ICallSaltLog[]
  span: bigint
  reachedTo: bigint
}> => {
  const scheduled: IScheduledCallLog[] = []
  const salts: ICallSaltLog[] = []
  let cursor = from
  let width = span
  while (cursor <= to && hasBudget(budget)) {
    const end = cursor + width - 1n < to ? cursor + width - 1n : to
    budget.left--
    try {
      const logs = await deps.getLogs(cursor, end)
      scheduled.push(...logs.scheduled)
      salts.push(...logs.salts)
      cursor = end + 1n
    } catch (error) {
      if (width <= MIN_LOG_SPAN) throw error
      width =
        width / SPAN_SHRINK > MIN_LOG_SPAN ? width / SPAN_SHRINK : MIN_LOG_SPAN
    }
  }
  return { scheduled, salts, span: width, reachedTo: cursor - 1n }
}

/**
 * Same as {@link readRange}, walking from `to` down towards `from`, up to
 * `parallel` ranges at a time. Only the unbroken run of answered ranges just
 * below the cursor is kept, so a partial run always leaves the scanned interval
 * contiguous.
 */
const readRangeDownward = async (
  deps: IScanDependencies,
  from: bigint,
  to: bigint,
  span: bigint,
  budget: IBudget,
  parallel: number
): Promise<{
  scheduled: IScheduledCallLog[]
  salts: ICallSaltLog[]
  span: bigint
  reachedFrom: bigint
}> => {
  const scheduled: IScheduledCallLog[] = []
  const salts: ICallSaltLog[] = []
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
        refused = answer.reason
        break
      }
      scheduled.push(...answer.value.scheduled)
      salts.push(...answer.value.salts)
      reachedFrom = (ranges[i] as [bigint, bigint])[0]
    }
    if (refused !== undefined) {
      if (width <= MIN_LOG_SPAN) throw refused
      width =
        width / SPAN_SHRINK > MIN_LOG_SPAN ? width / SPAN_SHRINK : MIN_LOG_SPAN
    }
  }
  return { scheduled, salts, span: width, reachedFrom }
}

/**
 * Advances a network's scan: head first, then history, within `logBudget`
 * `eth_getLogs` calls.
 *
 * The forward leg always runs to completion, budget or not: it is what makes a
 * fresh schedule visible within one run, and it is short after the first run.
 *
 * @param previous - State from the last run, already matched to this timelock.
 * @param deps - Chain readers.
 * @param logBudget - Calls the backward (history) leg may spend.
 * @param history - Clock time the backward leg must stop by, the clock, and
 *   how many ranges it may read at once.
 * @returns The advanced state and whether history is complete.
 * @throws When the head, the floor or a log range cannot be read.
 */
export const advanceScan = async (
  previous: INetworkScanState,
  deps: IScanDependencies,
  logBudget: number,
  history: { until?: number; now?: () => number; parallel?: number } = {}
): Promise<IScanOutcome> => {
  const head = await deps.head()
  const floor =
    previous.floor !== undefined ? BigInt(previous.floor) : await deps.floor()
  // One step wider than last time: a span that shrank on a transient refusal
  // would otherwise stay narrow for good, at up to ten times the calls.
  const widened =
    previous.span !== undefined
      ? BigInt(previous.span) * SPAN_SHRINK
      : MAX_LOG_SPAN
  let span = widened < MAX_LOG_SPAN ? widened : MAX_LOG_SPAN
  let operations = previous.operations
  let logCalls = 0
  let scheduledLogs = 0

  const high = previous.high !== undefined ? BigInt(previous.high) : undefined
  const forwardFrom =
    high === undefined
      ? head
      : high > REORG_MARGIN_BLOCKS
      ? high - REORG_MARGIN_BLOCKS
      : 0n
  const forwardBudget = { left: Number.MAX_SAFE_INTEGER }
  const forward = await readRange(deps, forwardFrom, head, span, forwardBudget)
  logCalls += Number.MAX_SAFE_INTEGER - forwardBudget.left
  operations = mergeScheduledLogs(operations, forward.scheduled, forward.salts)
  scheduledLogs += forward.scheduled.length
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
    operations = mergeScheduledLogs(
      operations,
      backward.scheduled,
      backward.salts
    )
    scheduledLogs += backward.scheduled.length
    span = backward.span
    low = backward.reachedFrom
  }

  return {
    head,
    logCalls,
    scheduledLogs,
    historyComplete: low <= floor,
    state: {
      timelock: previous.timelock,
      floor: floor.toString(),
      low: low.toString(),
      high: head.toString(),
      span: span.toString(),
      operations,
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
