/**
 * Acknowledgement bookkeeping for a multi-network Safe confirmation run.
 *
 * Import this from `confirm-safe-tx.ts`. It replaces the calldata-keyed action
 * cache: an operator's *action* is never remembered, while their *acknowledgement*
 * of a reviewed change rolls up across the networks it is genuinely the same on.
 */

import { encodeAbiParameters, keccak256, type Hex } from 'viem'

/**
 * Identifies a payload by the exact bytes the Safe will pass on.
 *
 * A semantic label (facet + version + selectors) collapses per-network init
 * payloads into one change, which is what let one answer replay across a fleet.
 *
 * @param calldata - The proposed transaction payload; absent is treated as empty.
 * @returns The keccak256 of the payload.
 */
export const computeChangeFingerprint = (calldata: Hex | undefined): Hex =>
  keccak256(calldata ?? '0x')

export interface IProposalIdentity {
  to: string
  chainId: number
  nonce: number | string | bigint
}

/**
 * Per-network identity of a single proposal.
 *
 * Deliberately not derived from the payload: the fingerprint groups
 * byte-identical changes, this key must never collapse two networks or two
 * nonces into one entry.
 *
 * @param identity - Target address, chain id and Safe nonce.
 * @returns A stable key unique to that proposal.
 */
export const buildProposalKey = (identity: IProposalIdentity): string =>
  `${identity.to.toLowerCase()}:${
    identity.chainId
  }:${identity.nonce.toString()}`

export interface IProposalEffect {
  to: string
  value: number | string | bigint
  operation: number
  fingerprint: Hex
}

/**
 * The unit an acknowledgement rolls up over.
 *
 * Covers every field of the signed Safe struct that determines what the
 * transaction does — target, value, call-vs-delegatecall, payload — not the
 * payload alone. `operation` matters most: a DelegateCall carrying bytes the
 * operator already approved as a Call is a different transaction, and the
 * production diamond does not share one address across the fleet (31 distinct
 * `LiFiDiamond` addresses across the 71 active networks), so the target
 * genuinely varies. Networks that do share a target still collapse to a single
 * acknowledgement, which is the fleet-rollout case this exists for.
 *
 * Pass the fields from the *normalised* Safe transaction, not the raw stored
 * document — the key should describe what the operator is about to sign.
 *
 * @param effect - Target, value, operation and payload fingerprint.
 * @returns A stable key for the acknowledgement ledger.
 * @throws If `value` is not a whole non-negative number, or the target is not an address.
 */
export const buildAcknowledgementKey = (effect: IProposalEffect): Hex => {
  const rawValue =
    typeof effect.value === 'string' ? effect.value.trim() : effect.value
  // BigInt('') and BigInt('  ') are both 0n, which would make a blank value
  // indistinguishable from a genuine zero-value transaction.
  if (rawValue === '')
    throw new Error(
      'buildAcknowledgementKey: value is empty, expected a number'
    )

  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'bytes32' },
      ],
      [
        // Kept explicit rather than relying on viem lowercasing internally, so
        // the case-insensitivity invariant lives in this module's own tests.
        effect.to.toLowerCase() as Hex,
        BigInt(rawValue),
        effect.operation,
        effect.fingerprint,
      ]
    )
  )
}

export type ProposalIntegrityFailure = 'stale-nonce'

export interface IProposalIntegrityInput {
  nonceStatus: 'current' | 'stale' | 'future'
}

export interface IProposalIntegrity {
  ok: boolean
  failures: ProposalIntegrityFailure[]
}

/**
 * Nonce verdict for one proposal — the only machine-checkable signal this
 * script has today, deliberately narrow rather than named as if it were more.
 *
 * A future nonce is legitimate: a lower-nonce proposal executing earlier in the
 * same run makes it current. Only a consumed nonce is a failure.
 *
 * Reachability worth knowing: a failing verdict only reaches the acknowledgement
 * gate via a bare `Sign`, because every execute-shaped action on a stale nonce is
 * already terminated earlier in `processTxs`.
 *
 * @param input - The nonce status resolved against the Safe's on-chain nonce.
 * @returns Whether the proposal may be acknowledged, and why not if it may not.
 */
export const evaluateProposalIntegrity = (
  input: IProposalIntegrityInput
): IProposalIntegrity =>
  input.nonceStatus === 'stale'
    ? { ok: false, failures: ['stale-nonce'] }
    : { ok: true, failures: [] }

export interface IAcknowledgementLedger {
  readonly acknowledgedProposalKeys: Map<Hex, Set<string>>
}

/**
 * Creates an empty ledger. One per run — acknowledgements never outlive a run.
 *
 * @returns A ledger holding no acknowledgements.
 */
export const createAcknowledgementLedger = (): IAcknowledgementLedger => ({
  acknowledgedProposalKeys: new Map(),
})

/**
 * @param ledger - The run's ledger.
 * @param acknowledgementKey - The effect key to look up.
 * @returns Whether this effect was acknowledged earlier in the run.
 */
export const isChangeAcknowledged = (
  ledger: IAcknowledgementLedger,
  acknowledgementKey: Hex
): boolean =>
  (ledger.acknowledgedProposalKeys.get(acknowledgementKey)?.size ?? 0) > 0

export interface IAcknowledgementPromptInput {
  alreadyAcknowledged: boolean
  integrityOk: boolean
}

/**
 * Whether the operator must acknowledge this proposal before it proceeds.
 *
 * A failing nonce verdict always re-prompts: a rolled-up acknowledgement was
 * earned on a proposal whose nonce was usable and says nothing about one whose
 * nonce is not.
 *
 * @param input - Whether the effect is already acknowledged and whether the nonce verdict passed.
 * @returns Whether to prompt.
 */
export const shouldPromptForAcknowledgement = (
  input: IAcknowledgementPromptInput
): boolean => !input.alreadyAcknowledged || !input.integrityOk

export interface IAcknowledgementRecord {
  acknowledgementKey: Hex
  proposalKey: string
  integrityOk: boolean
}

/**
 * Records an acknowledgement so later networks carrying the same effect skip the
 * review prompt.
 *
 * @param ledger - The run's ledger, mutated in place.
 * @param record - The effect, the proposal it was acknowledged on, and its nonce verdict.
 * @returns Whether the acknowledgement was stored; a failing verdict is never stored.
 */
export const recordAcknowledgement = (
  ledger: IAcknowledgementLedger,
  record: IAcknowledgementRecord
): boolean => {
  if (!record.integrityOk) return false

  const existing = ledger.acknowledgedProposalKeys.get(
    record.acknowledgementKey
  )
  if (existing) existing.add(record.proposalKey)
  else
    ledger.acknowledgedProposalKeys.set(
      record.acknowledgementKey,
      new Set([record.proposalKey])
    )

  return true
}

export interface INetworkOutcome {
  network: string
  proposalKey: string
  acknowledgementKey: Hex
  fingerprint: Hex
  nonceCurrent: boolean
  acknowledged: boolean
}

export interface IChangeRollup {
  acknowledgementKey: Hex
  fingerprint: Hex
  networks: number
  noncesUsable: number
  acknowledged: number
  staleNetworks: string[]
  /** Every proposal for this effect had a usable nonce AND was acknowledged. */
  complete: boolean
}

/**
 * Groups per-network outcomes by effect so the run can report N/N.
 *
 * Nonce verdicts are counted per network and never rolled up into a single
 * verdict; only the acknowledgement count rolls up.
 *
 * Callers may push a provisional entry for a proposal and a final one later:
 * for a given proposal key the last entry wins, so a run can record every
 * proposal it displayed and still report the outcome it ended on.
 *
 * @param outcomes - One or more entries per proposal seen, in the order they were seen.
 * @returns One rollup per distinct effect, in first-seen order.
 */
export const rollUpByChange = (
  outcomes: INetworkOutcome[]
): IChangeRollup[] => {
  const byEffect = new Map<Hex, Map<string, INetworkOutcome>>()

  for (const outcome of outcomes) {
    const perProposal =
      byEffect.get(outcome.acknowledgementKey) ??
      new Map<string, INetworkOutcome>()
    perProposal.set(outcome.proposalKey, outcome)
    byEffect.set(outcome.acknowledgementKey, perProposal)
  }

  return [...byEffect.entries()].map(([acknowledgementKey, perProposal]) => {
    // A group only exists because an outcome created it, so it is never empty.
    const [first, ...rest] = [...perProposal.values()] as [
      INetworkOutcome,
      ...INetworkOutcome[]
    ]
    const entries = [first, ...rest]
    const noncesUsable = entries.filter((e) => e.nonceCurrent).length
    const acknowledged = entries.filter((e) => e.acknowledged).length

    return {
      acknowledgementKey,
      fingerprint: first.fingerprint,
      networks: entries.length,
      noncesUsable,
      acknowledged,
      staleNetworks: entries
        .filter((e) => !e.nonceCurrent)
        .map((e) => e.network),
      complete:
        noncesUsable === entries.length && acknowledged === entries.length,
    }
  })
}

/**
 * Renders the roll-up as printable lines.
 *
 * The counts are named for exactly what they measure — a usable nonce and a
 * recorded review — so the marker is never read as "the run succeeded".
 * Execution outcomes are reported separately by the caller.
 *
 * @param rollups - Rollups from `rollUpByChange`.
 * @returns One line per effect; the tick appears only when both counts are N/N.
 */
export const renderChangeRollup = (rollups: IChangeRollup[]): string[] =>
  rollups.map((rollup) => {
    const stale = rollup.staleNetworks.length
      ? ` · stale nonce on ${rollup.staleNetworks.join(', ')}`
      : ''

    return `${rollup.complete ? '✓' : '✗'} payload ${rollup.fingerprint.slice(
      0,
      10
    )} · nonce usable ${rollup.noncesUsable}/${rollup.networks} · reviewed ${
      rollup.acknowledged
    }/${rollup.networks}${stale}`
  })
