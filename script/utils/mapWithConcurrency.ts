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
      const item = items[current]
      if (item === undefined) continue
      results[current] = await mapper(item, current)
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}
