/**
 * Pre-broadcast re-derive: may this queued timelock operation be executed?
 *
 * Import this from the executor before it broadcasts. The input carries only
 * live on-chain observations and anchors derived from `main` — there is
 * deliberately no field for a stored verdict, hash or authority value, so no
 * caller can hand this decision something a proposer could have written.
 */

import { compareToAttestedSet } from '../codehash/attested-set'
import type {
  IAttestedBuild,
  ILineageScope,
  IObservedCode,
} from '../codehash/attested-set'

/**
 * What the gate permits. `PROCEED` is the only member that allows a broadcast;
 * membership is checked against that set, so a disposition added later without
 * a decision about it refuses rather than executes.
 */
export type PreBroadcastDisposition = 'PROCEED' | 'BLOCK' | 'HOLD'

const DISPOSITIONS_THAT_MAY_BROADCAST: ReadonlySet<PreBroadcastDisposition> =
  new Set<PreBroadcastDisposition>(['PROCEED'])

/** One address from the on-chain operation parameters, and what was read at it. */
export interface IPreBroadcastTarget {
  /**
   * The address as it appears in the operation parameters read from the
   * timelock, lowercased. Never a display name and never a name-resolved
   * address: the calldata's own bytes are what executes.
   */
  address: string
  /**
   * Contract name resolved from the deployments file at `main` by exact address
   * match, or undefined when no entry holds this address.
   */
  resolvedContractName: string | undefined
  /** Live `eth_getCode` at `address`, normalised; undefined when unread. */
  observed: IObservedCode | undefined
  /** Why the live read yielded nothing. */
  observationError: string | undefined
  /** Every attested build of `main` for `resolvedContractName`. */
  attested: IAttestedBuild[]
  scope: ILineageScope
}

/** One R2.6 storage-authority value: what is live versus what `main` declares. */
export interface IPreBroadcastAuthority {
  /** Identifies the value for the operator, e.g. `LiFiDiamond.owner`. */
  label: string
  /** Live on-chain value, lowercased; undefined when the read failed. */
  liveValue: string | undefined
  /** Value `main` declares, lowercased; undefined when it declares none. */
  expectedValue: string | undefined
  /** Why the live read yielded nothing. */
  readError: string | undefined
}

export interface IPreBroadcastGateInput {
  /** The id the executor is about to execute this operation under. */
  operationId: string
  /**
   * The id recomputed by the timelock itself from the operation parameters read
   * back off chain. Undefined when that call could not be made.
   */
  onChainOperationId: string | undefined
  targets: IPreBroadcastTarget[]
  authorities: IPreBroadcastAuthority[]
  /**
   * Whether a sign-time verdict record exists. It only ever raises an alert:
   * the verdict below is re-derived from anchors either way, so blocking on a
   * missing record would turn a failed record write into a liveness outage.
   */
  signTimeRecordPresent: boolean
}

export interface IPreBroadcastGateResult {
  disposition: PreBroadcastDisposition
  /** One line an operator can act on. */
  reason: string
  /** Every finding, so one never hides another. */
  findings: string[]
  /** Raised, never decided on. */
  alerts: string[]
  /** True for every disposition outside the may-broadcast set. */
  blocksBroadcast: boolean
}

const normalizeId = (id: string): string => id.trim().toLowerCase()

/**
 * Decides whether a queued timelock operation may be broadcast.
 *
 * `BLOCK` is a statement about the operation: the code that would run is not a
 * build of `main`, an authority has moved, or the id does not match the one the
 * timelock scheduled. `HOLD` is a statement about our knowledge — a read
 * failed, an address resolves to no contract we can name, or the lineage cannot
 * be established. Both refuse the broadcast; they differ only in what the
 * cancel decision may do with them, so a `HOLD` is never escalated on our
 * behalf.
 *
 * @param input - Live observations and `main`-derived anchors. No stored value.
 * @returns The disposition, every finding behind it, and any alerts.
 */
export const evaluatePreBroadcastGate = (
  input: IPreBroadcastGateInput
): IPreBroadcastGateResult => {
  const blockFindings: string[] = []
  const holdFindings: string[] = []
  const alerts: string[] = []

  if (!input.signTimeRecordPresent)
    alerts.push(
      `no sign-time verdict record exists for operation ${input.operationId}; the verdict below was re-derived without it, but the signing audit trail has a gap`
    )

  if (input.onChainOperationId === undefined)
    holdFindings.push(
      'the timelock could not be asked to recompute the operation id, so the id being executed is unconfirmed'
    )
  else if (
    normalizeId(input.onChainOperationId) !== normalizeId(input.operationId)
  )
    blockFindings.push(
      `the timelock recomputes this operation's parameters to id ${input.onChainOperationId}, not the ${input.operationId} it is being executed under`
    )

  // An operation whose parameters name no target has nothing to verify, and
  // "nothing was checked" must not read as "everything checked out".
  if (input.targets.length === 0)
    holdFindings.push(
      'the operation parameters read off chain name no target, so no code could be compared'
    )

  for (const target of input.targets) {
    if (target.observationError !== undefined) {
      holdFindings.push(
        `${target.address}: its live code could not be read (${target.observationError})`
      )
      continue
    }

    if (target.observed === undefined) {
      holdFindings.push(
        `${target.address}: no live code observation was supplied for it`
      )
      continue
    }

    // Without a single name there is no attested set to compare against. Both
    // an address the deployment record does not hold and one it binds to two
    // names land here, and neither may pass unremarked.
    if (
      target.resolvedContractName === undefined ||
      target.resolvedContractName.length === 0
    ) {
      holdFindings.push(
        `${target.address}: main binds no single contract to this address, so there is nothing to compare its code against`
      )
      continue
    }

    const comparison = compareToAttestedSet(
      target.observed,
      target.attested,
      target.scope
    )
    const detail = `${target.address} (${target.resolvedContractName}): ${comparison.reason}`
    if (comparison.verdict === 'MISMATCH') blockFindings.push(detail)
    else if (comparison.verdict === 'UNVERIFIABLE') holdFindings.push(detail)
  }

  for (const authority of input.authorities) {
    if (authority.readError !== undefined) {
      holdFindings.push(
        `${authority.label}: could not be read on chain (${authority.readError})`
      )
      continue
    }

    if (authority.liveValue === undefined) {
      holdFindings.push(`${authority.label}: no live value was supplied for it`)
      continue
    }

    if (authority.expectedValue === undefined) {
      holdFindings.push(
        `${authority.label}: main declares no expected value, so the live ${authority.liveValue} cannot be judged`
      )
      continue
    }

    if (
      authority.liveValue.trim().toLowerCase() !==
      authority.expectedValue.trim().toLowerCase()
    )
      blockFindings.push(
        `${authority.label}: holds ${authority.liveValue} on chain where main declares ${authority.expectedValue}`
      )
  }

  const findings = [...blockFindings, ...holdFindings]

  // A proven failure is the stronger statement, so it decides even when a read
  // also failed elsewhere in the same operation.
  const disposition: PreBroadcastDisposition =
    blockFindings.length > 0
      ? 'BLOCK'
      : holdFindings.length > 0
      ? 'HOLD'
      : 'PROCEED'

  const reason =
    disposition === 'PROCEED'
      ? `re-derived from main: every target's live code matches an attested build and every storage authority matches config${
          alerts.length > 0 ? ', with alerts' : ''
        }`
      : disposition === 'BLOCK'
      ? `${blockFindings.length} proven integrity failure(s): ${blockFindings[0]}`
      : `${holdFindings.length} thing(s) could not be verified: ${holdFindings[0]}`

  return {
    disposition,
    reason,
    findings,
    alerts,
    blocksBroadcast: !DISPOSITIONS_THAT_MAY_BROADCAST.has(disposition),
  }
}
