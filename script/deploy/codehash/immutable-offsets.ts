/**
 * Masks and reads a contract's immutables in its runtime bytecode.
 *
 * Import this to normalise code before hashing it, or to read immutable values
 * for checking against a declared expectation. Offsets are an EVM and Tron
 * concept: zkEVM keeps immutables in `ImmutableSimulator`, read by ordinal.
 */

import { frameFault, strip0x } from './hex'

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
  /** One value per AST id in `refs`, `0x`-prefixed, once every copy agreed. */
  values: Record<string, string>
}

export interface IRefused {
  ok: false
  reason: string
}

const refused = (reason: string): IRefused => ({ ok: false, reason })

/**
 * Foundry omits `immutableReferences` entirely for a contract that has none, so
 * the majority of real artifacts hand this module `undefined`.
 */
const present = (refs: ImmutableReferences | undefined): ImmutableReferences =>
  refs ?? {}

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

  for (const [astId, occurrences] of Object.entries(refs)) {
    // An immutable with no occurrences would be dropped from the read result
    // rather than compared, so layer 2 would pass it by default.
    if (occurrences.length === 0)
      return `astId ${astId} lists no occurrences, so it has no value to check`

    for (const { start, length } of occurrences) {
      if (!Number.isInteger(start) || start < 0)
        return `astId ${astId} has start ${start}, which is not a byte offset`
      if (!Number.isInteger(length) || length <= 0)
        return `astId ${astId} has length ${length}, which is not a byte count`
      if (start + length > totalBytes)
        return `astId ${astId} at ${start}+${length} runs past the end of ${totalBytes} bytes`
      ranges.push({ start, end: start + length, astId })
    }
  }

  ranges.sort((a, b) => a.start - b.start)
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1]
    const current = ranges[i]
    if (previous && current && current.start < previous.end)
      return previous.astId === current.astId
        ? `astId ${current.astId} lists an occurrence at byte ${current.start} more than once`
        : `astId ${previous.astId} and astId ${current.astId} overlap at byte ${current.start}`
  }

  return undefined
}

/**
 * Zeroes every immutable occurrence, leaving the code the same length.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @param refs - Foundry's `immutableReferences`, or undefined when it has none.
 * @returns The masked code, or why it was refused.
 */
export const maskImmutables = (
  runtimeHex: string,
  refs: ImmutableReferences | undefined
): IMaskResult | IRefused => {
  const frame = frameFault(runtimeHex, 'bytecode')
  if (frame) return refused(frame)

  const hex = strip0x(runtimeHex)
  const known = present(refs)
  const fault = findFault(known, hex.length / 2)
  if (fault) return refused(fault)

  let masked = hex
  for (const occurrences of Object.values(known))
    for (const { start, length } of occurrences)
      masked =
        masked.slice(0, start * 2) +
        '0'.repeat(length * 2) +
        masked.slice((start + length) * 2)

  return { ok: true, code: `0x${masked}` }
}

/**
 * Reads each immutable's value, requiring every copy to agree.
 *
 * A disagreement means the deployed code does not uniformly hold the value, so
 * there is no single value to check against an expectation. Picking one would
 * report something the contract does not hold.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @param refs - Foundry's `immutableReferences`, or undefined when it has none.
 * @returns One value per AST id, or why it was refused.
 */
export const readImmutableCopies = (
  runtimeHex: string,
  refs: ImmutableReferences | undefined
): IReadResult | IRefused => {
  const frame = frameFault(runtimeHex, 'bytecode')
  if (frame) return refused(frame)

  const hex = strip0x(runtimeHex)
  const known = present(refs)
  const fault = findFault(known, hex.length / 2)
  if (fault) return refused(fault)

  const values: Record<string, string> = {}

  for (const [astId, occurrences] of Object.entries(known)) {
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
    if (only === undefined)
      return refused(`astId ${astId} yielded no value to read`)
    values[astId] = `0x${only}`
  }

  return { ok: true, values }
}
