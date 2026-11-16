/**
 * Stored Timestamp
 *
 * Display formatting for a timestamp read off a Mongo row. The schemas type
 * these as `Date`, but Mongo does not enforce it: a row written outside the
 * scripts can hold another type, and one such row must not crash a listing or
 * print as something that hides what was stored.
 */

/**
 * Formats a stored timestamp for display. A stored string is returned
 * unchanged rather than re-parsed, since `new Date()` reads an offset-free
 * string in the host's timezone.
 *
 * @param value - Timestamp as read from Mongo (Date, string, epoch ms, or anything else).
 * @returns ISO string for a valid Date or epoch ms; otherwise a string form that never throws.
 */
export function toIsoDate(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Date || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
  }
  if (typeof value === 'object' && value !== null) {
    // The stored shape is what an operator needs to find and correct the row;
    // `[object Object]` names none of it. JSON also renders a BSON type through
    // its `toJSON` and a cross-realm Date as its ISO string.
    try {
      const json = JSON.stringify(value)
      if (json !== undefined) return json
    } catch {
      // A cyclic or BigInt-holding object cannot serialise; the tag below still renders.
    }
    return Object.prototype.toString.call(value)
  }
  return String(value)
}

/**
 * Names the stored type of a timestamp that is not a `Date`.
 *
 * @param value - Timestamp as read from Mongo.
 * @returns `undefined` for a `Date`; otherwise the stored type, e.g. `string` or `array`.
 */
export function nonDateTimestampType(value: unknown): string | undefined {
  if (value instanceof Date) return undefined
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
