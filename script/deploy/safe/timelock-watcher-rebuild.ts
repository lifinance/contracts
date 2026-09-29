/**
 * The timelock watcher's gate K rebuild slot: a per-run budget and one rebuild
 * at a time, bounded by the calling network's deadline.
 *
 * Import it from `timelock-watcher.ts`. One rebuild at a time, a timed-out one
 * included, because every rebuild shares one checkout root keyed by commit and
 * a timeout does not stop the build.
 */

import { sleep } from '../../utils/delay'

/** Raised by {@link withTimeout}, so a caller can tell an overrun from a failure. */
export class WatcherTimeoutError extends Error {}

/**
 * Rejects with {@link WatcherTimeoutError} when `promise` has not settled
 * within `ms`. The underlying work is not aborted; the caller moves on
 * without it.
 *
 * @param promise - The work to wait for.
 * @param ms - How long to wait.
 * @param what - Named in the error.
 * @returns What `promise` resolves to.
 * @throws WatcherTimeoutError on overrun, or whatever `promise` rejects with.
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new WatcherTimeoutError(`${what} timed out after ${ms / 1000}s`)
            ),
          Math.max(ms, 0)
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export type TRebuildOutcome<T> =
  | { kind: 'done'; value: T }
  | { kind: 'deferred'; reason: string }
  | { kind: 'timed-out'; reason: string }
  | { kind: 'failed'; reason: string }

export interface IRebuildGate {
  /**
   * Runs `work` once the slot is free and the budget allows it.
   *
   * @param work - The rebuild.
   * @param deadline - Clock time the caller must have its answer by.
   * @returns Its value, or why it did not run or finish.
   */
  run: <T>(
    work: () => Promise<T>,
    deadline: number
  ) => Promise<TRebuildOutcome<T>>
  /** Rebuilds this gate may still start. */
  left: () => number
}

/**
 * Creates a rebuild gate.
 *
 * @param options.budget - Rebuilds per run.
 * @param options.timeoutMs - Longest a rebuild may run before its caller moves on.
 * @param options.describe - Renders an error for a reason line.
 * @param options.now - The clock; injectable for tests.
 * @param options.pollMs - How often a waiter looks at the slot.
 * @returns The gate.
 */
export const createRebuildGate = (options: {
  budget: number
  timeoutMs: number
  describe: (error: unknown) => string
  now?: () => number
  pollMs?: number
}): IRebuildGate => {
  const now = options.now ?? Date.now
  let left = options.budget
  let running: Promise<unknown> | undefined

  return {
    left: () => left,
    run: async <T>(
      work: () => Promise<T>,
      deadline: number
    ): Promise<TRebuildOutcome<T>> => {
      // The rebuild must fit before the deadline, so the wait must end one
      // timeout before it.
      const waitUntil = deadline - options.timeoutMs
      while (running) {
        if (now() >= waitUntil)
          return {
            kind: 'deferred',
            reason:
              'another gate K rebuild is still running; this one runs on a later run',
          }
        await Promise.race([
          running.catch(() => undefined),
          sleep(options.pollMs ?? 1000),
        ])
      }
      // Checked after the wait, not before: every waiter passed the same check
      // while the slot was busy.
      if (left <= 0)
        return {
          kind: 'deferred',
          reason:
            'gate K is queued behind this run’s rebuild budget and will run on a later run',
        }
      if (now() >= waitUntil)
        return {
          kind: 'deferred',
          reason:
            'too little of this network’s time is left for a gate K rebuild; it runs on a later run',
        }
      left--
      const started = work()
      running = started
      void started
        .catch(() => undefined)
        .finally(() => {
          if (running === started) running = undefined
        })
      try {
        return {
          kind: 'done',
          value: await withTimeout(
            started,
            options.timeoutMs,
            'gate K rebuild'
          ),
        }
      } catch (error) {
        const reason = `gate K could not be evaluated: ${options.describe(
          error
        )}`
        return error instanceof WatcherTimeoutError
          ? { kind: 'timed-out', reason }
          : { kind: 'failed', reason }
      }
    },
  }
}
