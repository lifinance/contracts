/**
 * Bounded-concurrency async map.
 * Use whenever the same async operation runs over many independent items
 * (per-network RPC reads, per-chain queries) and unbounded `Promise.all`
 * would open one connection per item — see [CONV:PARALLEL-WORK]. Mirrors
 * `Promise.all`'s result ordering while capping how many run at once.
 */

/**
 * Runs `mapper` over `items` with at most `limit` in flight at once, preserving
 * input order in the returned results.
 * @param items - The items to map over
 * @param limit - Maximum number of `mapper` calls in flight at once (floored at 1)
 * @param mapper - Async transform applied to each item; receives the item and its index
 * @returns Results in the same order as `items`
 * @remarks A rejected `mapper` rejects the whole call (like `Promise.all`). When
 * one failure must not abort the batch, have `mapper` catch and return a tagged
 * value instead (the `Promise.allSettled` equivalent).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const current = next++
      // `current` is provably in-bounds, so the element is a real `T` even when
      // its value is `undefined` — pass it through rather than skip it, or the
      // result would keep a hole and `mapper` would never run for that index.
      results[current] = await mapper(items[current] as T, current)
    }
  }

  // A NaN limit would make `Math.min` NaN and spawn zero workers, leaving the
  // results unfilled; floor it to the documented minimum of one.
  const safeLimit = Number.isNaN(limit) ? 1 : limit
  const workers = Array.from(
    { length: Math.max(1, Math.min(safeLimit, items.length)) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}
