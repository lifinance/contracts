import type { IDeploymentIndexEntry } from './calldata-address-check'

/**
 * A network whose deployment records spell addresses differently from the
 * calldata: Tron records store base58, a cut carries 20-byte EVM hex.
 */
export interface IRecordSpellingTranslator {
  /** The record's spelling as the calldata would carry it, or nothing. */
  toCalldataSpelling: (recordAddress: string) => string | undefined
}

/**
 * Respells every record on `network` the way the calldata spells addresses,
 * so a lookup by the calldata's address finds the record.
 *
 * Respelt in place rather than copied: the index groups records by name and
 * deploy time to decide which address a name currently holds, and a copy
 * beside the original would read as two addresses at one time — a tie the
 * check reports as undecidable. A translator that cannot read an address
 * leaves that record as it was rather than dropping it.
 *
 * The record's own spelling is carried along on `recordSpelling`: the lookup
 * needs the calldata's, but base58 is what a Tron signer can put into an
 * explorer, so the render side prints both.
 *
 * @param records - the deployment entries as read, or undefined when unread
 * @param network - the network the proposal is on
 * @param translator - how that network's record spelling maps to the calldata's
 * @returns The same entries, respelt where the translator could, in the same order
 */
export const withCalldataSpellings = (
  records: readonly IDeploymentIndexEntry[] | undefined,
  network: string,
  translator: IRecordSpellingTranslator | undefined
): readonly IDeploymentIndexEntry[] | undefined => {
  if (!records || !translator) return records
  const wanted = network.trim().toLowerCase()
  return records.map((entry) => {
    if (entry.network.trim().toLowerCase() !== wanted) return entry
    const spelt = translator.toCalldataSpelling(entry.address)
    return spelt
      ? { ...entry, address: spelt, recordSpelling: entry.address }
      : entry
  })
}
