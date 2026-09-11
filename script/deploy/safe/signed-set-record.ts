/**
 * The sign-time verdict record: what the signer's machine saw, kept so the
 * decision can be reconstructed afterwards.
 *
 * Import this from `confirm-safe-tx.ts` to write a record, and from the
 * pre-broadcast gate to ask whether one exists. It is a G6 audit trail and
 * explicitly **not** the execute-time oracle: every value in it was produced by
 * the proposer's own run, so comparing live code against a stored hash would be
 * comparing it against something the proposer wrote. The gate re-derives from
 * `main` instead and reads nothing here but presence.
 *
 * What the record IS good for is comparison between signers. Each signer of a
 * 3-of-N Safe writes their own document, keyed by signer, holding the raw hash
 * their machine read at each address. Three machines agreeing is evidence no
 * one of them can manufacture; that is why nothing in a document is derived
 * from the machine that wrote it.
 *
 * It lives on the un-gated `MONGODB_URI` cluster rather than beside the Safe
 * proposals, because the CI job that raises the missing-record alert cannot
 * open the tunnel the Safe collection sits behind.
 */

import { consola } from 'consola'
import { MongoClient, type Collection, type ObjectId } from 'mongodb'
import type { Hex } from 'viem'

import { getEnvVar } from '../../utils/utils'

import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
import type { IObservedTarget } from './prebroadcast-gate'

const SIGNED_SET_DB_NAME = 'timelock-operations'
const SIGNED_SET_COLLECTION_NAME = 'signed-sets'

/** One address the signed calldata touches, and the code seen at it. */
export interface ISignedCodehashEntry {
  /** Lowercased address, taken from the calldata's own bytes. */
  address: string
  /** Contract name the deployments file at `main` bound to that address. */
  contractName: string | undefined
  /**
   * keccak of the exact bytes at the address, or undefined when unread.
   *
   * Raw, never masked. The record's value is that three signers' copies are
   * comparable to each other, which holds only if every machine hashed the
   * bytes it read with nothing derived from its own build folded in. Comparing
   * these against an attested set is EXSC-952's job.
   */
  rawHash: string | undefined
  /** Byte length as deployed. */
  rawByteLength: number | undefined
  /** Why nothing was read, when nothing was. */
  observationError: string | undefined
}

/** One R2.6 storage-authority value as it stood at sign time (adversarial F9). */
export interface ISignedAuthorityEntry {
  label: string
  liveValue: string | undefined
  expectedValue: string | undefined
  readError: string | undefined
}

export interface ISignedSetRecord {
  _id?: ObjectId
  /** Timelock operation id the signed calldata schedules. */
  operationId: Hex
  network: string
  chainId: number
  /** Safe-side hash of the proposal that was signed. */
  safeTxHash: string
  /** Address that signed, lowercased. */
  signer: string
  /** Commit the signer's checkout was on, when it could be read. */
  derivedFromCommit: string | undefined
  codehashes: ISignedCodehashEntry[]
  authorities: ISignedAuthorityEntry[]
  createdAt: Date
  /**
   * Restates the T5 ruling on the document itself, so a reader who finds this
   * collection without the surrounding code cannot mistake it for the oracle.
   */
  advisory: string
}

/**
 * The one sentence stored on every record. Kept as a constant so a test can pin
 * the text rather than the symbol.
 */
export const SIGNED_SET_ADVISORY =
  'Reconstruction record only. The pre-broadcast gate re-derives its verdict from main and never reads these values.'

export interface ISignedSetRecordInput {
  operationId: Hex
  network: string
  chainId: number
  safeTxHash: string
  signer: string
  derivedFromCommit: string | undefined
  codehashes: ISignedCodehashEntry[]
  authorities: ISignedAuthorityEntry[]
}

/**
 * Builds the record document.
 *
 * @param input - What the sign-time run observed.
 * @param now - Timestamp to stamp; injected so tests are deterministic.
 * @returns The document to upsert.
 */
export const buildSignedSetRecord = (
  input: ISignedSetRecordInput,
  now: Date
): ISignedSetRecord => ({
  operationId: input.operationId,
  network: input.network.toLowerCase(),
  chainId: input.chainId,
  safeTxHash: input.safeTxHash,
  signer: input.signer.toLowerCase(),
  derivedFromCommit: input.derivedFromCommit,
  codehashes: input.codehashes,
  authorities: input.authorities,
  createdAt: now,
  advisory: SIGNED_SET_ADVISORY,
})

/**
 * Turns the observations the gate's own resolution produced into record
 * entries.
 *
 * Taking the gate's shape rather than re-reading anything is what keeps the
 * record describing the same addresses the gate will later look at.
 *
 * @param targets - Target observations from `observeCalldata`.
 * @returns One entry per address, unreadable ones included.
 */
export const toSignedCodehashEntries = (
  targets: readonly IObservedTarget[]
): ISignedCodehashEntry[] =>
  targets.map((target) => ({
    address: target.address,
    contractName: target.resolvedContractName,
    rawHash: target.rawHash,
    rawByteLength: target.rawByteLength,
    observationError: target.observationError,
  }))

/**
 * Turns the authority observations into record entries.
 *
 * @param authorities - Authority observations from `observeCalldata`.
 * @returns One entry per declared authority.
 */
export const toSignedAuthorityEntries = (
  authorities: readonly IPreBroadcastAuthority[]
): ISignedAuthorityEntry[] =>
  authorities.map((authority) => ({
    label: authority.label,
    liveValue: authority.liveValue,
    expectedValue: authority.expectedValue,
    readError: authority.readError,
  }))

/**
 * Renders the record for the signing prompt.
 *
 * Prints every entry including the ones that could not be read: a set that
 * silently drops an unreadable address reads to a signer as a set where
 * everything was checked.
 *
 * @param record - The record about to be, or already, stored.
 * @returns Lines to log, one per entry plus a header.
 */
export const formatSignedSetForDisplay = (
  record: ISignedSetRecord
): string[] => {
  const lines = [
    `Sign-time set for operation ${record.operationId} on ${record.network} (audit trail, not the execute-time check):`,
  ]
  if (record.codehashes.length === 0)
    lines.push('    codehashes: none — no address in the calldata was resolved')
  for (const entry of record.codehashes)
    lines.push(
      entry.observationError !== undefined
        ? `    ${entry.address} (${
            entry.contractName ?? 'unnamed'
          }): NOT READ — ${entry.observationError}`
        : `    ${entry.address} (${entry.contractName ?? 'unnamed'}): ${
            entry.rawHash
          } · ${entry.rawByteLength} bytes`
    )
  if (record.authorities.length === 0)
    lines.push('    authorities: none declared for these contracts')
  for (const entry of record.authorities)
    lines.push(
      entry.readError !== undefined
        ? `    ${entry.label}: NOT READ — ${entry.readError}`
        : `    ${entry.label}: ${entry.liveValue ?? 'unread'} (main declares ${
            entry.expectedValue ?? 'nothing'
          })`
    )
  return lines
}

/** Name pinned so a test can assert the index rather than its shape. */
export const SIGNED_SET_KEY_INDEX_NAME = 'network_operationId_signer'

/**
 * True when `error` is a MongoDB authorization failure — the connected role
 * lacks `createIndex` (server code 13). Matched the way `parked-tasks.ts`
 * matches it, and for the same reason: every consumer of this collection runs
 * on the un-gated `MONGODB_URI` cluster from a readWrite-only credential.
 */
const isUnauthorizedError = (error: unknown): boolean =>
  error instanceof Error &&
  (('code' in error && (error as { code: number }).code === 13) ||
    /not authorized/i.test(error.message))

/**
 * Ensures the index the key lookup depends on.
 *
 * Without it `findOne` is a collection scan that grows with every operation
 * ever signed, on a collection read once per operation per network per tick of
 * the executor's cron.
 *
 * Not unique. A signer legitimately re-signs after a rebase, and the write is
 * an upsert on the full key, so uniqueness would buy nothing and turn a
 * duplicate into a lost record.
 *
 * Degrades rather than throws on an authorization failure, matching
 * `ensureParkedTasksIndexes`: this collection is the audit trail, and a role
 * that cannot create indexes must still be able to write to it.
 *
 * @param signedSets - The collection to index.
 */
export const ensureSignedSetIndexes = async (
  signedSets: Collection<ISignedSetRecord>
): Promise<void> => {
  try {
    await signedSets.createIndex(
      { network: 1, operationId: 1, signer: 1 },
      { name: SIGNED_SET_KEY_INDEX_NAME }
    )
  } catch (error: unknown) {
    if (!isUnauthorizedError(error)) throw error
    consola.warn(
      `Could not create the "${SIGNED_SET_KEY_INDEX_NAME}" index on ` +
        `${signedSets.collectionName}: the MONGODB_URI role lacks createIndex. ` +
        `Reads and writes still work; lookups scan the collection until an ` +
        `admin creates it once.`
    )
  }
}

/**
 * Opens a short-lived client and returns the signed-set collection.
 *
 * One client per call, closed by the caller. That is what every other Mongo
 * accessor in this directory does — `getTimelockQueueCollection`,
 * `getParkedTasksCollection` — and the executor already opens several per
 * operation through them, so a pooled handle here would be the odd one out
 * rather than the fix.
 *
 * @returns The connected client (caller must `close()`) and the collection.
 * @throws When `MONGODB_URI` is not set.
 */
export const getSignedSetCollection = async (): Promise<{
  client: MongoClient
  signedSets: Collection<ISignedSetRecord>
}> => {
  const client = new MongoClient(getEnvVar('MONGODB_URI'))
  const signedSets = client
    .db(SIGNED_SET_DB_NAME)
    .collection<ISignedSetRecord>(SIGNED_SET_COLLECTION_NAME)
  try {
    await ensureSignedSetIndexes(signedSets)
    return { client, signedSets }
  } catch (error) {
    await client.close()
    throw error
  }
}

/**
 * Filter for one signer's record. `$eq`-wrapped so a value arriving as an
 * object cannot become a query operator.
 *
 * The signer is part of the key, and that is the whole point of the record:
 * on a 3-of-N Safe the evidence is that three machines each observed the same
 * set, and a key without the signer makes the last upsert overwrite the first
 * two — leaving a document that claims one machine's view with nothing
 * indicating the others ever existed. One observation is a log line; three
 * agreeing observations are the artifact.
 *
 * @param network - Lowercased network name.
 * @param operationId - Timelock operation id.
 * @param signer - Address that signed, lowercased.
 * @returns The filter.
 */
export const bySignedSetKey = (
  network: string,
  operationId: string,
  signer: string
): Record<string, unknown> => ({
  network: { $eq: network.toLowerCase() },
  operationId: { $eq: operationId },
  signer: { $eq: signer.toLowerCase() },
})

/**
 * Filter for every signer's record of one operation.
 *
 * What the gate asks, because all it carries onward is whether any record
 * exists.
 *
 * @param network - Lowercased network name.
 * @param operationId - Timelock operation id.
 * @returns The filter.
 */
export const byOperationKey = (
  network: string,
  operationId: string
): Record<string, unknown> => ({
  network: { $eq: network.toLowerCase() },
  operationId: { $eq: operationId },
})

/**
 * The update document for an upsert.
 *
 * `_id` is immutable once a document exists, so a record that ever carried one
 * would make the upsert throw instead of updating.
 *
 * @param record - The document to store.
 * @returns The `$set` update, without `_id`.
 */
export const buildSignedSetUpdate = (
  record: ISignedSetRecord
): { $set: Omit<ISignedSetRecord, '_id'> } => {
  const { _id: _ignored, ...fields } = record
  return { $set: fields }
}

/**
 * Upserts a sign-time record.
 *
 * Failure is logged and swallowed: the record is an audit trail, the gate
 * re-derives without it, and a write error must not cost the operator the
 * signing session. The gate raises the alert for a record that never landed.
 *
 * @param record - The document to store.
 * @returns Whether the write landed.
 */
export const persistSignedSetRecord = async (
  record: ISignedSetRecord
): Promise<boolean> => {
  try {
    const { client, signedSets } = await getSignedSetCollection()
    try {
      await signedSets.updateOne(
        bySignedSetKey(record.network, record.operationId, record.signer),
        buildSignedSetUpdate(record),
        { upsert: true }
      )
      return true
    } finally {
      await client.close()
    }
  } catch (error) {
    consola.warn(
      'Failed to store the sign-time set (the pre-broadcast gate re-derives without it and will alert on the gap):',
      error
    )
    return false
  }
}

/**
 * Fetches a sign-time record.
 *
 * Any one signer's record answers the gate, which carries only presence
 * onward — so this asks the operation-wide filter rather than naming a signer
 * the executor has no way to pick.
 *
 * @param network - Network name.
 * @param operationId - Timelock operation id.
 * @returns One signer's document, or null when no signer recorded one.
 * @throws When the cluster cannot be reached — the caller must tell "no record"
 * apart from "could not look", because only the first is an alert.
 */
export const fetchSignedSetRecord = async (
  network: string,
  operationId: string
): Promise<ISignedSetRecord | null> => {
  const { client, signedSets } = await getSignedSetCollection()
  try {
    return await signedSets.findOne(byOperationKey(network, operationId))
  } finally {
    await client.close()
  }
}
