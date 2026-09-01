/**
 * Reads and strips the solc CBOR metadata trailer from runtime bytecode.
 *
 * Import this before hashing deployed code for comparison: two builds of one
 * source differ in these bytes whenever a comment or a file path changed. The
 * zksolc trailer is a different format and is not handled here.
 */

import { frameFault, strip0x } from './hex'

/** solc opens its CBOR map with a major-type-5 header of 1-15 entries. */
const CBOR_MAP_MIN = 0xa1
const CBOR_MAP_MAX = 0xaf

/** `text(4) "solc"` then `bytes(3)`, which is how solc encodes a release triple. */
const SOLC_KEY = '64736f6c6343'

/** The trailer's own big-endian length word. */
const LENGTH_WORD_BYTES = 2

/** solc is still on 0.x, and no released minor or patch is near this. */
const MAX_PLAUSIBLE_VERSION_PART = 99

export interface IMetadataTrailerFound {
  present: true
  /** Bytes of CBOR, excluding the length word. */
  byteLength: number
  /** What a strip removes: the CBOR plus its length word. */
  totalStrippedBytes: number
  /** Undefined when no version can be read, which is never a guess. */
  solcVersion?: string
}

export interface IMetadataTrailerAbsent {
  present: false
  reason: string
}

export type MetadataTrailer = IMetadataTrailerFound | IMetadataTrailerAbsent

const absent = (reason: string): IMetadataTrailerAbsent => ({
  present: false,
  reason,
})

/**
 * Reads the compiler version out of a trailer's CBOR.
 *
 * Returns undefined for anything it cannot read unambiguously. The bytes are
 * part of the deployed code and so are chosen by whoever deployed it: a version
 * this reports is shown to a signer as fact, so a planted or nonsensical one
 * must come back as "no version" rather than as a number.
 *
 * @param cbor - The trailer's CBOR, as hex without `0x`.
 * @returns The version, or undefined when none can be read.
 */
const readSolcVersion = (cbor: string): string | undefined => {
  const at = cbor.indexOf(SOLC_KEY)
  if (at === -1) return undefined
  // The search runs over hex characters, so a match at an odd index spans the
  // second half of one byte and the first half of the next — not a key.
  if (at % 2 !== 0) return undefined
  // A second occurrence leaves no way to tell which one the map's key is.
  if (cbor.indexOf(SOLC_KEY, at + 1) !== -1) return undefined

  const triple = cbor.slice(at + SOLC_KEY.length, at + SOLC_KEY.length + 6)
  if (triple.length < 6) return undefined

  const major = parseInt(triple.slice(0, 2), 16)
  const minor = parseInt(triple.slice(2, 4), 16)
  const patch = parseInt(triple.slice(4, 6), 16)
  if (
    major !== 0 ||
    minor > MAX_PLAUSIBLE_VERSION_PART ||
    patch > MAX_PLAUSIBLE_VERSION_PART
  )
    return undefined

  return `${major}.${minor}.${patch}`
}

/**
 * Inspects the tail of runtime bytecode for a solc metadata trailer.
 *
 * Every path that cannot read a trailer reports absence rather than a best
 * guess: stripping the wrong number of bytes changes the hash the sign-time
 * comparison is made on, without anything looking wrong.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @returns What is there, or why nothing can be read.
 */
export const readMetadataTrailer = (runtimeHex: string): MetadataTrailer => {
  const fault = frameFault(runtimeHex, 'bytecode')
  if (fault) return absent(fault)

  const body = strip0x(runtimeHex)
  const totalBytes = body.length / 2
  if (totalBytes < LENGTH_WORD_BYTES)
    return absent('bytecode is shorter than a length word')

  const declared = parseInt(body.slice(-4), 16)
  if (declared === 0)
    return absent('length word is zero, so there is no trailer')

  const totalStrippedBytes = declared + LENGTH_WORD_BYTES
  if (totalStrippedBytes > totalBytes)
    return absent(
      `length word claims ${declared} bytes, longer than the ${
        totalBytes - LENGTH_WORD_BYTES
      } available`
    )
  if (totalStrippedBytes === totalBytes)
    return absent(
      `length word claims ${declared} bytes, which would leave no code at all`
    )

  const cbor = body.slice(-(totalStrippedBytes * 2), -4)
  const header = parseInt(cbor.slice(0, 2), 16)
  if (header < CBOR_MAP_MIN || header > CBOR_MAP_MAX)
    return absent(
      `blob opens 0x${cbor.slice(0, 2)}, which is not a CBOR map header`
    )

  const solcVersion = readSolcVersion(cbor.toLowerCase())

  return {
    present: true,
    byteLength: declared,
    totalStrippedBytes,
    ...(solcVersion ? { solcVersion } : {}),
  }
}

/**
 * Removes the metadata trailer, or returns the input untouched.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @returns The code to hash, and whether anything was removed.
 */
export const stripMetadataTrailer = (
  runtimeHex: string
): { code: string; stripped: boolean } => {
  const trailer = readMetadataTrailer(runtimeHex)
  if (!trailer.present) return { code: runtimeHex, stripped: false }

  const body = strip0x(runtimeHex)
  return {
    code: `0x${body.slice(0, body.length - trailer.totalStrippedBytes * 2)}`,
    stripped: true,
  }
}
