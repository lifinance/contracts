/**
 * Pre-broadcast re-derive: may this queued timelock operation be executed?
 *
 * Import this from the executor before it broadcasts. The input carries only
 * live on-chain observations and anchors derived from `main` — there is
 * deliberately no field for a stored verdict, hash or authority value, so no
 * caller can hand this decision something a proposer could have written.
 */

import type { IPreBroadcastAuthority } from './prebroadcast-authorities'

/**
 * What the gate permits. `PROCEED` is the only member that allows a broadcast;
 * membership is checked against that set, so a disposition added later without
 * a decision about it refuses rather than executes.
 */
export type PreBroadcastDisposition = 'PROCEED' | 'BLOCK' | 'HOLD'

const DISPOSITIONS_THAT_MAY_BROADCAST: ReadonlySet<PreBroadcastDisposition> =
  new Set<PreBroadcastDisposition>(['PROCEED'])

export interface IPreBroadcastGateInput {
  /** The id the executor is about to execute this operation under, as stored. */
  operationId: string
  /**
   * The timestamp the controller has stored against that id — what it actually
   * holds, rather than a re-hash of parameters we were handed. Zero is the
   * controller's own answer for "no schedule entry under this id". Undefined
   * when the call could not be made.
   */
  scheduledAt: bigint | undefined
  /**
   * How many addresses the operation's parameters name, and how many of those
   * `main` binds to a contract. The gap is what the gate could not look at. It
   * is reported rather than decided on: an address the deployments file does
   * not hold is routine on a rollout that installs new code.
   */
  addressesNamed: number
  addressesResolved: number
  authorities: IPreBroadcastAuthority[]
  /**
   * Whether a sign-time verdict record exists. It only ever raises an alert:
   * the verdict below is re-derived either way, so blocking on a missing record
   * would turn a failed record write into a liveness outage.
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

/**
 * Describes how much of the operation the gate actually looked at.
 *
 * Spelled out on every disposition, PROCEED included, because the coverage is
 * partial by construction: a payload address the deployments file does not name
 * produces no row, and a contract with no entry in
 * `DECLARED_STORAGE_AUTHORITIES` produces none either. A PROCEED that says how
 * much it read cannot be misread as a statement about the rest.
 *
 * @param input - The gate input the counts are taken from.
 * @returns A clause naming what was covered.
 */
const describeCoverage = (input: IPreBroadcastGateInput): string =>
  `${input.addressesResolved} of ${input.addressesNamed} calldata address(es) resolve to a contract main names, and ${input.authorities.length} declared storage authority value(s) were read`

/**
 * Decides whether a queued timelock operation may be broadcast.
 *
 * `BLOCK` is a statement about the operation: a storage authority has moved, or
 * the timelock holds no schedule entry under the id being executed. `HOLD` is a
 * statement about our knowledge — a read failed, or `main` declares no value to
 * judge a live one against. Both refuse the broadcast; they differ only in what
 * the cancel decision may do with them, so a `HOLD` is never escalated on our
 * behalf.
 *
 * Storage authorities are the whole of the integrity half on purpose. Of the
 * things this gate could re-derive, they are the only ones whose subject can
 * change during the delay window: the operation's parameters are chain-enforced
 * by `executeBatch`'s own `hashOperationBatch` and `isOperationReady`, and
 * deployed code is immutable. Re-deriving code against a local build would
 * compare the executor against its own checkout — the same oracle the three
 * signers already used, so three observations of it are still one (EXSC-952
 * mints the independent one).
 *
 * @param input - Live observations and `main`-derived expectations. No stored
 * value.
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

  if (input.scheduledAt === undefined)
    holdFindings.push(
      'the timelock could not be asked what it has scheduled under this id, so the operation being executed is unconfirmed'
    )
  else if (input.scheduledAt === 0n)
    blockFindings.push(
      `the timelock holds no schedule entry under id ${input.operationId}, so this operation was never scheduled under it or has already been consumed`
    )

  // An operation naming no address has nothing to read authorities from, and
  // "nothing was checked" must not read as "everything checked out".
  if (input.addressesNamed === 0)
    holdFindings.push(
      'the operation parameters read off chain name no address, so nothing could be checked'
    )

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

  const coverage = describeCoverage(input)
  const reason =
    disposition === 'PROCEED'
      ? `re-derived from main: every storage authority read matches config — ${coverage}${
          alerts.length > 0 ? ', with alerts' : ''
        }`
      : disposition === 'BLOCK'
      ? `${blockFindings.length} proven integrity failure(s): ${blockFindings[0]} — ${coverage}`
      : `${holdFindings.length} thing(s) could not be verified: ${holdFindings[0]} — ${coverage}`

  return {
    disposition,
    reason,
    findings,
    alerts,
    blocksBroadcast: !DISPOSITIONS_THAT_MAY_BROADCAST.has(disposition),
  }
}

export interface IDeriveGateInput {
  operationId: string
  scheduledAt: bigint | undefined
  addressesNamed: number
  addressesResolved: number
  authorities: IPreBroadcastAuthority[]
  /** The stored sign-time record, or null. Only its existence is carried on. */
  signTimeRecord: unknown
}

/**
 * Assembles the gate's input from live observations and the stored record.
 *
 * The record is a G6 reconstruction trail written by the proposer's own run, so
 * every value in it is proposer-controlled. Reducing it to a boolean here is
 * what makes tampering with its contents structurally unable to move the
 * verdict: no other field survives into the gate's input.
 *
 * @param input - Observations, counts, and the stored record.
 * @returns The gate input, carrying the record's presence and none of its
 * values.
 */
export const deriveGateInput = (
  input: IDeriveGateInput
): IPreBroadcastGateInput => ({
  operationId: input.operationId,
  scheduledAt: input.scheduledAt,
  addressesNamed: input.addressesNamed,
  addressesResolved: input.addressesResolved,
  authorities: input.authorities,
  signTimeRecordPresent:
    input.signTimeRecord !== null && input.signTimeRecord !== undefined,
})
