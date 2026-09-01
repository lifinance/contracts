/**
 * Decodes the flat CBOR map solc appends to runtime bytecode.
 *
 * Import this from the trailer reader rather than pattern-matching the bytes: a
 * blob is only a trailer if it decodes completely, and a key's value is only
 * that key's value if the map's structure says so. Deliberately narrow — it
 * covers what solc emits (text keys; byte-string, text or boolean values) and
 * refuses everything else instead of implementing CBOR.
 */

/** Major type 5, entry count in the low 5 bits. Solc emits two or three keys. */
const MAP_HEADER_MIN = 0xa0
const MAP_HEADER_MAX = 0xb7

const MAJOR_BYTE_STRING = 2
const MAJOR_TEXT_STRING = 3
const MAJOR_SIMPLE = 7

/** Low-5-bit values above this encode the length in following bytes. */
const MAX_INLINE_LENGTH = 23
const LENGTH_IN_ONE_BYTE = 24
const LENGTH_IN_TWO_BYTES = 25

const SIMPLE_FALSE = 20
const SIMPLE_TRUE = 21

export interface ICborMapDecoded {
  ok: true
  /** Values as hex without `0x`; booleans as `true`/`false`. */
  entries: Record<string, string>
}

export interface ICborMapRefused {
  ok: false
  reason: string
}

class Reader {
  private at = 0

  public constructor(private readonly bytes: Uint8Array) {}

  public done(): boolean {
    return this.at >= this.bytes.length
  }

  public consumed(): number {
    return this.at
  }

  public byte(): number | undefined {
    return this.bytes[this.at++]
  }

  public slice(length: number): Uint8Array | undefined {
    if (this.at + length > this.bytes.length) return undefined
    const out = this.bytes.slice(this.at, this.at + length)
    this.at += length
    return out
  }
}

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** Reads a byte- or text-string length, following the CBOR length encoding. */
const readLength = (info: number, reader: Reader): number | undefined => {
  if (info <= MAX_INLINE_LENGTH) return info
  if (info === LENGTH_IN_ONE_BYTE) return reader.byte()
  if (info === LENGTH_IN_TWO_BYTES) {
    const high = reader.byte()
    const low = reader.byte()
    if (high === undefined || low === undefined) return undefined
    return (high << 8) | low
  }
  return undefined
}

/**
 * Decodes a complete flat CBOR map.
 *
 * @param hex - The blob, as hex without `0x`.
 * @returns The map's entries, or why the bytes are not one.
 */
export const decodeCborMap = (
  hex: string
): ICborMapDecoded | ICborMapRefused => {
  const bytes = new Uint8Array(
    (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))
  )
  const reader = new Reader(bytes)

  const header = reader.byte()
  if (header === undefined) return { ok: false, reason: 'the blob is empty' }
  if (header < MAP_HEADER_MIN || header > MAP_HEADER_MAX)
    return {
      ok: false,
      reason: `the blob opens 0x${header
        .toString(16)
        .padStart(2, '0')}, which is not a CBOR map header`,
    }

  const count = header - MAP_HEADER_MIN
  const entries: Record<string, string> = {}

  for (let i = 0; i < count; i++) {
    const keyHeader = reader.byte()
    if (keyHeader === undefined)
      return { ok: false, reason: 'the CBOR map ends before its keys do' }
    if (keyHeader >> 5 !== MAJOR_TEXT_STRING)
      return { ok: false, reason: 'a CBOR map key is not a text string' }
    const keyLength = readLength(keyHeader & 0x1f, reader)
    if (keyLength === undefined)
      return { ok: false, reason: 'a CBOR map key has no readable length' }
    const keyBytes = reader.slice(keyLength)
    if (!keyBytes)
      return { ok: false, reason: 'a CBOR map key runs past the blob' }
    const key = new TextDecoder().decode(keyBytes)

    // A duplicate key leaves no way to say which entry the map means.
    if (key in entries)
      return { ok: false, reason: `the CBOR map repeats the key '${key}'` }

    const valueHeader = reader.byte()
    if (valueHeader === undefined)
      return { ok: false, reason: `the value for '${key}' is missing` }
    const major = valueHeader >> 5
    const info = valueHeader & 0x1f

    if (major === MAJOR_SIMPLE) {
      if (info !== SIMPLE_TRUE && info !== SIMPLE_FALSE)
        return {
          ok: false,
          reason: `the value for '${key}' is not a value solc emits`,
        }
      entries[key] = info === SIMPLE_TRUE ? 'true' : 'false'
      continue
    }

    if (major !== MAJOR_BYTE_STRING && major !== MAJOR_TEXT_STRING)
      return {
        ok: false,
        reason: `the value for '${key}' is not a value solc emits`,
      }

    const valueLength = readLength(info, reader)
    if (valueLength === undefined)
      return {
        ok: false,
        reason: `the value for '${key}' has no readable length`,
      }
    const valueBytes = reader.slice(valueLength)
    if (!valueBytes)
      return { ok: false, reason: `the value for '${key}' runs past the blob` }
    entries[key] = toHex(valueBytes)
  }

  // The declared length and the structure have to agree, or the blob is not a
  // trailer and the byte count taken off the code would be a guess.
  if (!reader.done())
    return {
      ok: false,
      reason: `the CBOR map decodes in ${reader.consumed()} of ${
        bytes.length
      } bytes`,
    }

  return { ok: true, entries }
}
