/**
 * How Tron's deployment records spell an address a cut carries, in both
 * directions.
 *
 * A Tron record stores base58 while a diamond cut carries 20-byte EVM hex, so
 * every lookup that joins the two has to translate. Built once per network and
 * shared, because a TronWeb codec is not free and because two constructions are
 * how the report-only check and the codehash gate come to disagree about which
 * address a record describes.
 *
 * Codec-only: this converts addresses and never reaches the network.
 */

import {
  evm20HexStringToTronBase58,
  getTronWebCodecOnlyForNetwork,
  isTronNetworkKey,
  tronBase58ToEvm20Hex,
} from '@lifi/tron-devkit'

/**
 * Both directions of one Tron network's address spelling.
 *
 * Structurally an `IRecordSpellingTranslator` (`deployment-record-spellings.ts`)
 * without importing it: that module belongs to the signing scripts and this one
 * is also read from `script/deploy/codehash/`, which sits below them.
 */
export interface ITronAddressSpellings {
  /** The record's address as the calldata carries it, or nothing. */
  toCalldataSpelling: (recordAddress: string) => string | undefined
  /** Spellings a record may carry for this calldata address, query order. */
  forCalldataAddress: (calldataAddress: string) => readonly string[]
}

/**
 * A Tron base58 address: `T` and 33 more base58 characters.
 *
 * Checked before the codec sees the value, because the codec answers a word in
 * the base58 alphabet with the ZERO ADDRESS instead of refusing it — `n/a`,
 * `true`, `null` and `TODO` all decode to `0x00…0`. A caller comparing that
 * against a slot would take a declared non-value for an expectation, and an
 * immutable legitimately holding zero would satisfy it.
 */
const TRON_BASE58 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

/**
 * The hex spellings a record may carry instead: `0x` and 20 bytes, Tron's own
 * `41` prefix and 20 bytes, or the 20 bytes bare. A record written in any of
 * them names an address.
 */
const TRON_HEX = /^(0x|41)?[0-9a-fA-F]{40}$/

/**
 * The bare form, which has to be prefixed before the codec sees it.
 *
 * The codec strips a leading `41` unconditionally, so a bare 20-byte address
 * whose FIRST BYTE is `0x41` loses that byte and comes back left-padded — a
 * different address, returned without complaint. `0x` tells it the value is
 * already 20 bytes; the prefixed spellings are unambiguous and pass through.
 */
const BARE_20_BYTE_HEX = /^[0-9a-fA-F]{40}$/

const byNetwork = new Map<string, ITronAddressSpellings>()

/**
 * The address spellings for a network, or nothing when it spells them one way.
 *
 * @param network - key in `config/networks.json`
 * @returns Both translation directions, or undefined for a non-Tron network
 */
export const createTronAddressSpellings = (
  network: string
): ITronAddressSpellings | undefined => {
  if (!isTronNetworkKey(network)) return undefined

  // Keyed and built on the lowercased name: `isTronNetworkKey` folds case, so
  // two spellings of one network would otherwise hold two codecs.
  const key = network.toLowerCase()
  const cached = byNetwork.get(key)
  if (cached) return cached

  const codec = getTronWebCodecOnlyForNetwork(key)
  const spellings: ITronAddressSpellings = {
    toCalldataSpelling: (recordAddress: string): string | undefined => {
      const value = recordAddress.trim()
      if (!TRON_BASE58.test(value) && !TRON_HEX.test(value)) return undefined
      try {
        // A well-formed word that is not an address — a broken checksum —
        // makes the codec throw rather than default, so the shape check and
        // this catch are between them the whole guard.
        const spelled = BARE_20_BYTE_HEX.test(value) ? `0x${value}` : value
        return tronBase58ToEvm20Hex(codec, spelled).toLowerCase()
      } catch {
        return undefined
      }
    },
    // The calldata spelling stays first and is always offered: a record written
    // in hex is found by it, and dropping it would trade one miss for another.
    // A value the codec cannot read degrades to that spelling alone, which is
    // the lookup as it was before base58 was understood — a miss, never a hit.
    //
    // The base58 is offered only if it decodes back to the address asked
    // about. The encoder skips its `41` prefix when the hex already starts
    // with those digits, so an address whose FIRST BYTE is `0x41` encodes 20
    // bytes instead of 21 and yields a word that is not even a `T` address.
    // That is a miss either way; refusing to offer it keeps a value that
    // names a different address out of the query. The encoder's length guard
    // rejects the 21-byte spelling that would fix it, so the repair belongs
    // in `@lifi/tron-devkit`, not here.
    forCalldataAddress: (calldataAddress: string): readonly string[] => {
      try {
        const base58 = evm20HexStringToTronBase58(codec, calldataAddress)
        const decoded = tronBase58ToEvm20Hex(codec, base58).toLowerCase()
        if (decoded !== calldataAddress.toLowerCase()) return [calldataAddress]
        return [calldataAddress, base58]
      } catch {
        return [calldataAddress]
      }
    },
  }
  byNetwork.set(key, spellings)
  return spellings
}
