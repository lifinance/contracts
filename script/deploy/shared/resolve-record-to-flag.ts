/**
 * Chooses which deployment record a verification run is allowed to flag.
 *
 * Kept out of `update-deployment-logs.ts` so it can be tested without that
 * module's load-time side effects (it reads `MONGODB_URI` and calls `runMain`).
 */
import type { IDeploymentRecord } from './mongo-log-utils'

/**
 * Picks the record a verification run may flag, or refuses.
 *
 * One contract can hold several records over its life — an abandoned deploy
 * leaves one behind, and on Tron that has happened — so the newest record is
 * not necessarily the address that was just verified. Flagging without
 * comparing would mark a contract verified that nobody submitted.
 *
 * @param latest - Newest record for the contract on this network, if any
 * @param contractName - Contract being flagged, named in the message
 * @param network - Network being flagged, named in the message
 * @param address - Address the caller actually verified
 * @returns The record to flag
 * @throws When no record exists, or the newest one names a different address
 */
export function resolveRecordToFlag(
  latest: IDeploymentRecord | null,
  contractName: string,
  network: string,
  address: string
): IDeploymentRecord {
  if (!latest)
    throw new Error(`No deployment record for ${contractName} on ${network}`)
  if (latest.address !== address)
    throw new Error(
      `Latest ${contractName} record on ${network} is ${latest.address}, ` +
        `not the verified ${address}. Refusing to flag a record for an ` +
        `address this run did not verify.`
    )
  return latest
}
