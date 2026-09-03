/**
 * Framing checks for bytecode hex, shared by the codehash modules.
 *
 * Import this rather than re-deriving the checks: a module that masks or hashes
 * unvalidated hex produces a plausible-looking result from nonsense input, and
 * the two modules disagreeing about what counts as valid is the same bug twice.
 */

/** Accepts either case of prefix; no real toolchain emits `0X`, but refusing it is not a safety property. */
export const strip0x = (hex: string): string =>
  /^0x/i.test(hex) ? hex.slice(2) : hex

/**
 * Checks the string is a non-empty, whole-byte, hexadecimal sequence.
 *
 * @param hex - Candidate bytecode, with or without a `0x` prefix.
 * @param noun - How to name the input in the message, e.g. `bytecode`.
 * @returns Why the string is unusable, or undefined when it is fine.
 */
export const frameFault = (hex: string, noun: string): string | undefined => {
  const body = strip0x(hex)
  if (body.length === 0) return `${noun} is empty`
  if (body.length % 2 !== 0) return `${noun} is not whole bytes`
  if (!/^[0-9a-f]*$/i.test(body)) return `${noun} is not hex`
  return undefined
}
