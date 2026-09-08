/**
 * Reads and strips the solc CBOR metadata trailer from runtime bytecode.
 *
 * Import this before hashing deployed code for comparison: two builds of one
 * source differ in these bytes whenever a comment or a file path changed. The
 * zksolc trailer is a different format and is not handled here.
 */

import { decodeCborMap } from './cbor-map'
import { frameFault, strip0x } from './hex'

/** The key solc writes its version under, and the width of a release triple. */
const SOLC_KEY = 'solc'
const VERSION_BYTES = 3

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
 * Turns solc's three-byte version value into a release string.
 *
 * Returns undefined for anything it cannot read as a release. The bytes are part
 * of the deployed code and so are chosen by whoever deployed it: a version this
 * reports is shown to a signer as fact, so an implausible one must come back as
 * "no version" rather than as a number.
 *
 * @param value - The decoded value of the map's `solc` key, as hex.
 * @returns The version, or undefined when the value is not a release triple.
 */
const readSolcVersion = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length !== VERSION_BYTES * 2)
    return undefined

  const major = parseInt(value.slice(0, 2), 16)
  const minor = parseInt(value.slice(2, 4), 16)
  const patch = parseInt(value.slice(4, 6), 16)
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
  const decoded = decodeCborMap(cbor.toLowerCase())
  if (!decoded.ok) return absent(decoded.reason)

  const solcVersion = readSolcVersion(decoded.entries[SOLC_KEY])

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
