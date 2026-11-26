/**
 * Gate G's sign-time observation: reads the code and declared storage
 * authorities of everything a timelock `scheduleBatch` names, on every network
 * the signing flow runs on, Tron included. Imported by `confirm-safe-tx.ts`,
 * which caches the result per proposal and grades it before the action prompt.
 */

import type { Hex } from 'viem'

import { redactUrls } from '../../utils/redactUrls'

import type { TStorageAuthorityAbsence } from './confirm-check-registry'
import type { PinnedJsonRead } from './pinned-target-state'
import {
  observeCalldata,
  type IObservationDependencies,
  type IObservedCalldata,
} from './prebroadcast-gate'
import {
  computeOperationIdBatch,
  decodeScheduleBatch,
  isScheduleBatchCalldata,
} from './timelock-queue'
import { gateAddressInputsForNetwork } from './tron-gate-addresses'

/** What one proposal's calldata declares, read once and kept. */
export interface IObservedSet {
  operationId: Hex
  observed: IObservedCalldata
}

/**
 * What one attempt to read the sign-time set produced: the observation, or why
 * there is none. The absences reach the ledger as different rows, so they are
 * named here rather than collapsed into `undefined`.
 */
export type TSetObservation =
  | { kind: 'observed'; observation: IObservedSet }
  | { kind: 'absent'; absence: TStorageAuthorityAbsence }

/** Everything the observation reaches the outside world through. */
export interface ISignTimeSetDependencies {
  /** Builds the on-chain readers; a throw is recorded as a failed read. */
  readers: () => Pick<IObservationDependencies, 'readCode' | 'readAuthority'>
  /** The network's deployment record as this checkout has it. */
  loadDeployments: () => Promise<Record<string, unknown>>
  /** The same file as `origin/main` has it. */
  readPinnedDeployments: () => Promise<PinnedJsonRead>
  /** Parsed `config/global.json`. */
  globalConfig: Record<string, unknown>
}

/**
 * Observes the contracts a `scheduleBatch` proposal names.
 *
 * Every failure to make the observation — undecodable calldata, no client, an
 * unreadable deployment record, a Tron address that will not convert to hex —
 * is `read-failed`, never an empty set: gate G grades an empty set as nothing
 * to check. A read that fails on one address inside an observation that was
 * made is not an absence; it reaches the row as that address's own unread
 * entry.
 *
 * @param network - Network name as it appears in `config/networks.json`.
 * @param callData - The Safe transaction's calldata.
 * @param dependencies - Injected readers and loaders.
 * @returns The observation, or why there is none.
 */
export const observeSignTimeSet = async (
  network: string,
  callData: Hex | undefined,
  dependencies: ISignTimeSetDependencies
): Promise<TSetObservation> => {
  if (!callData || !isScheduleBatchCalldata(callData))
    return { kind: 'absent', absence: { kind: 'not-scheduled' } }

  try {
    const params = decodeScheduleBatch(callData)
    const operationId = computeOperationIdBatch(
      params.targets,
      params.values,
      params.payloads,
      params.predecessor,
      params.salt
    )
    const readers = dependencies.readers()
    const pinned = await dependencies.readPinnedDeployments()
    const addressInputs = gateAddressInputsForNetwork(network, {
      deployments: await dependencies.loadDeployments(),
      ...(pinned.ok ? { pinnedDeployments: pinned.value } : {}),
      globalConfig: dependencies.globalConfig,
    })
    const observed = await observeCalldata(
      { operationId, targets: params.targets, payloads: params.payloads },
      { ...readers, ...addressInputs }
    )
    return { kind: 'observed', observation: { operationId, observed } }
  } catch (error) {
    return {
      kind: 'absent',
      absence: {
        kind: 'read-failed',
        reason: redactUrls(
          error instanceof Error ? error.message : String(error)
        ),
      },
    }
  }
}
