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
 * Adds, beside every record on `network`, a copy spelt the way the calldata
 * spells it, so a lookup by the calldata's address finds the record.
 *
 * A copy rather than a rewrite: the record's own spelling is what every other
 * reader of the index expects to print, and a translator that cannot read an
 * address leaves that record as it was rather than dropping it.
 *
 * @param records - the deployment entries as read, or undefined when unread
 * @param network - the network the proposal is on
 * @param translator - how that network's record spelling maps to the calldata's
 * @returns The same entries plus the translated copies, in the same order
 */
export const withCalldataSpellings = (
  records: readonly IDeploymentIndexEntry[] | undefined,
  network: string,
  translator: IRecordSpellingTranslator | undefined
): readonly IDeploymentIndexEntry[] | undefined => {
  if (!records || !translator) return records
  const wanted = network.trim().toLowerCase()
  const out: IDeploymentIndexEntry[] = []
  for (const entry of records) {
    out.push(entry)
    if (entry.network.trim().toLowerCase() !== wanted) continue
    const spelt = translator.toCalldataSpelling(entry.address)
    if (spelt && spelt.toLowerCase() !== entry.address.toLowerCase())
      out.push({ ...entry, address: spelt })
  }
  return out
}
