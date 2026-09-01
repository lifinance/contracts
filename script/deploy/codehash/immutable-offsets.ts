/**
 * Masks and reads a contract's immutables in its runtime bytecode.
 *
 * Immutables are written into the code at construction, so two deployments of
 * identical source differ at exactly these offsets. Layer 1 of the codehash
 * check compares code with them masked; layer 2 reads their values and checks
 * each against a declared expectation.
 *
 * Every failure path refuses. A hash over partly-masked code is compared as
 * though it were normalised, and a value read from an out-of-range offset is
 * compared against an expectation as though it came from the chain.
 *
 * zkEVM does not use offsets — its immutables live in `ImmutableSimulator` and
 * are read by ordinal — so this applies to the EVM and Tron lineages only.
 */

/** Foundry's shape: byte offsets into the runtime code, keyed by AST id. */
export interface IImmutableOccurrence {
  start: number
  length: number
}

export type ImmutableReferences = Record<string, IImmutableOccurrence[]>

export interface IMaskResult {
  ok: true
  /** Same length as the input; only the occurrences are zeroed. */
  code: string
}

export interface IReadResult {
  ok: true
  /** One value per AST id, `0x`-prefixed, once every copy has agreed. */
  values: Record<string, string>
}

export interface IRefused {
  ok: false
  reason: string
}

const refused = (reason: string): IRefused => ({ ok: false, reason })

const body = (hex: string): string =>
  hex.startsWith('0x') ? hex.slice(2) : hex

/**
 * Checks the occurrences describe real, non-overlapping ranges.
 *
 * @param refs - Foundry's `immutableReferences`.
 * @param totalBytes - Length of the runtime code.
 * @returns Why the set is unusable, or undefined when it is fine.
 */
const findFault = (
  refs: ImmutableReferences,
  totalBytes: number
): string | undefined => {
  const ranges: { start: number; end: number; astId: string }[] = []

  for (const [astId, occurrences] of Object.entries(refs))
    for (const { start, length } of occurrences) {
      if (!Number.isInteger(start) || start < 0)
        return `astId ${astId} has start ${start}, which is not a byte offset`
      if (!Number.isInteger(length) || length <= 0)
        return `astId ${astId} has length ${length}, which is not a byte count`
      if (start + length > totalBytes)
        return `astId ${astId} at ${start}+${length} runs past the end of ${totalBytes} bytes`
      ranges.push({ start, end: start + length, astId })
    }

  ranges.sort((a, b) => a.start - b.start)
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1]
    const current = ranges[i]
    if (previous && current && current.start < previous.end)
      return `astId ${previous.astId} and astId ${current.astId} overlap at byte ${current.start}`
  }

  return undefined
}

/**
 * Zeroes every immutable occurrence, leaving the code the same length.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @param refs - Foundry's `immutableReferences`.
 * @returns The masked code, or why it was refused.
 */
export const maskImmutables = (
  runtimeHex: string,
  refs: ImmutableReferences
): IMaskResult | IRefused => {
  const hex = body(runtimeHex)
  const fault = findFault(refs, hex.length / 2)
  if (fault) return refused(fault)

  const chars = hex.split('')
  for (const occurrences of Object.values(refs))
    for (const { start, length } of occurrences)
      chars.splice(start * 2, length * 2, ...'0'.repeat(length * 2).split(''))

  return { ok: true, code: `0x${chars.join('')}` }
}

/**
 * Reads each immutable's value, requiring every copy to agree.
 *
 * A disagreement means the deployed code does not uniformly hold the value, so
 * there is no single value to check against an expectation. Picking one would
 * report something the contract does not hold.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @param refs - Foundry's `immutableReferences`.
 * @returns One value per AST id, or why it was refused.
 */
export const readImmutableCopies = (
  runtimeHex: string,
  refs: ImmutableReferences
): IReadResult | IRefused => {
  const hex = body(runtimeHex)
  const fault = findFault(refs, hex.length / 2)
  if (fault) return refused(fault)

  const values: Record<string, string> = {}

  for (const [astId, occurrences] of Object.entries(refs)) {
    const seen = new Set(
      occurrences.map(({ start, length }) =>
        hex.slice(start * 2, (start + length) * 2).toLowerCase()
      )
    )
    if (seen.size > 1)
      return refused(
        `astId ${astId} has ${seen.size} differing values across ${occurrences.length} copies, so they disagree`
      )
    const [only] = [...seen]
    if (only !== undefined) values[astId] = `0x${only}`
  }

  return { ok: true, values }
}
