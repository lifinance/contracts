/**
 * How Tron's deployment records spell an address a cut carries, in both
 * directions.
 *
 * A Tron record stores base58 while a diamond cut carries 20-byte EVM hex, so
 * every lookup that joins the two has to translate. Built once per network and
 * shared, because a TronWeb codec is not free and because two constructions are
 * how the report-only check and the codehash gate come to disagree about which
 * address a record describes — which they did: the gate read UNVERIFIABLE on
 * Tron facets whose record names them.
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
      try {
        return tronBase58ToEvm20Hex(codec, recordAddress).toLowerCase()
      } catch {
        return undefined
      }
    },
    // The calldata spelling stays first and is always offered: a record written
    // in hex is found by it, and dropping it would trade one miss for another.
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
