/**
 * Chooses which deployment records a verification run is allowed to flag.
 *
 * Kept out of `update-deployment-logs.ts` so it can be tested without that
 * module's load-time side effects (it reads `MONGODB_URI` and calls `runMain`).
 */
import type { IDeploymentRecord } from './mongo-log-utils'

/**
 * Picks the records a verification run may flag, or refuses.
 *
 * Selection is by address, never by recency. One contract can hold several
 * records over its life — an abandoned deploy leaves one behind, and on Tron
 * that has happened — and the abandoned record can be the newer of the two, so
 * taking the newest would flag an address nobody submitted while the live one
 * stayed unflagged for good. Every record naming the verified address is
 * returned: they all describe the contract that was just verified.
 *
 * @param records - Every record for the contract on this network
 * @param contractName - Contract being flagged, named in the message
 * @param network - Network being flagged, named in the message
 * @param address - Address the caller actually verified
 * @returns Every record naming `address`
 * @throws When no record names that address
 */
export function resolveRecordsToFlag(
  records: IDeploymentRecord[],
  contractName: string,
  network: string,
  address: string
): IDeploymentRecord[] {
  const matches = records.filter((record) => record.address === address)
  if (matches.length > 0) return matches

  if (records.length === 0)
    throw new Error(`No deployment record for ${contractName} on ${network}`)

  throw new Error(
    `No ${contractName} record on ${network} names the verified ${address}. ` +
      `Recorded addresses: ${records.map((r) => r.address).join(', ')}.`
  )
}
