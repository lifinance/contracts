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

/**
 * Canonical form for comparing hashes: no prefix, lower case.
 *
 * Shared so two modules cannot disagree about whether `0xAA…` and `0xaa…` are
 * one hash. Normalises nonsense as readily as a hash, so it decides nothing
 * about validity.
 * @param hex - A hash, with or without a `0x` prefix
 * @returns The same hash, unprefixed and lower case
 */
export const normalizeHash = (hex: string): string => strip0x(hex).toLowerCase()

/** Byte length of a keccak256 digest. */
const DIGEST_BYTES = 32

/**
 * Checks the string is a whole keccak256 digest.
 *
 * {@link frameFault} accepts any even-length hex, because it was written for
 * bytecode, whose length is not known in advance. A digest's is, and the
 * realistic corruption is a value of the wrong length — a sliced hash, an
 * address in a hash slot, an empty string that stringified to `0x00`. Those
 * pass a framing check and hash into whatever consumes them.
 * @param hex - Candidate digest, with or without a `0x` prefix
 * @param noun - How to name the input in the message, e.g. `masked hash`
 * @returns Why the string is not a digest, or undefined when it is one
 */
export const digestFault = (hex: string, noun: string): string | undefined =>
  frameFault(hex, noun) ??
  (strip0x(hex).length === DIGEST_BYTES * 2
    ? undefined
    : `${noun} is not ${DIGEST_BYTES} bytes`)
