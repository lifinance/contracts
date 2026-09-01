/**
 * Reads and strips the solc metadata trailer from runtime bytecode.
 *
 * Two contracts built from identical source differ in these bytes whenever a
 * comment or a file path changed, so the trailer has to come off before any hash
 * comparison. It also carries the compiler version, which the fleet sweep found
 * is the value to trust: a deployment record's `solcVersion` can disagree with
 * what was actually deployed, and the trailer cannot.
 *
 * Every failure path returns "no trailer" rather than a best guess. Stripping the
 * wrong number of bytes silently changes the hash the sign-time gate compares,
 * which is the one outcome worse than refusing to verify.
 *
 * zkEVM's zksolc trailer is a different format and is not handled here.
 */

/** solc opens its CBOR map with a major-type-5 header, 1-15 entries. */
const CBOR_MAP_MIN = 0xa1
const CBOR_MAP_MAX = 0xbf

/** `text(4) "solc"` then `bytes(3)`, which is how solc encodes a release triple. */
const SOLC_KEY = '64736f6c6343'

/** The trailer's own big-endian length word. */
const LENGTH_WORD_BYTES = 2

export interface IMetadataTrailerFound {
  present: true
  /** Bytes of CBOR, excluding the length word. */
  byteLength: number
  /** What a strip removes: the CBOR plus its length word. */
  totalStrippedBytes: number
  /** Undefined when the trailer carries no solc key — never a guess. */
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
 * @param bytes - The trailer's CBOR, as lowercase hex without `0x`.
 * @returns The compiler version, or undefined when the key is absent.
 */
const readSolcVersion = (bytes: string): string | undefined => {
  const at = bytes.indexOf(SOLC_KEY)
  if (at === -1) return undefined

  const triple = bytes.slice(at + SOLC_KEY.length, at + SOLC_KEY.length + 6)
  if (triple.length < 6) return undefined

  const [major, minor, patch] = [0, 2, 4].map((i) =>
    parseInt(triple.slice(i, i + 2), 16)
  )
  return `${major}.${minor}.${patch}`
}

/**
 * Inspects the tail of runtime bytecode for a solc metadata trailer.
 *
 * @param runtimeHex - Runtime bytecode, `0x`-prefixed.
 * @returns What is there, or why nothing can be read.
 */
export const readMetadataTrailer = (runtimeHex: string): MetadataTrailer => {
  const body = runtimeHex.startsWith('0x') ? runtimeHex.slice(2) : runtimeHex
  if (body.length === 0) return absent('bytecode is empty')
  if (body.length % 2 !== 0) return absent('bytecode is not whole bytes')
  if (!/^[0-9a-f]*$/i.test(body)) return absent('bytecode is not hex')

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

  const body = runtimeHex.startsWith('0x') ? runtimeHex.slice(2) : runtimeHex
  return {
    code: `0x${body.slice(0, body.length - trailer.totalStrippedBytes * 2)}`,
    stripped: true,
  }
}
