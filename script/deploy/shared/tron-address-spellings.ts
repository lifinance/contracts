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
  /** The record's base58 as the calldata carries it, or nothing. */
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
      if (!TRON_BASE58.test(value)) return undefined
      try {
        // A well-formed word that is not an address — a broken checksum —
        // makes the codec throw rather than default, so the shape check and
        // this catch are between them the whole guard.
        return tronBase58ToEvm20Hex(codec, value).toLowerCase()
      } catch {
        return undefined
      }
    },
    // The calldata spelling stays first and is always offered: a record written
    // in hex is found by it, and dropping it would trade one miss for another.
    // A value the codec cannot read degrades to that spelling alone, which is
    // the lookup as it was before base58 was understood — a miss, never a hit.
    forCalldataAddress: (calldataAddress: string): readonly string[] => {
      try {
        return [
          calldataAddress,
          evm20HexStringToTronBase58(codec, calldataAddress),
        ]
      } catch {
        return [calldataAddress]
      }
    },
  }
  byNetwork.set(key, spellings)
  return spellings
}
