/**
 * Acknowledgement bookkeeping for a multi-network Safe confirmation run.
 *
 * Import this from `confirm-safe-tx.ts`. It replaces the calldata-keyed action
 * cache: an operator's *action* is never remembered, while their *acknowledgement*
 * of a logical change rolls up across networks, so a 71-network rollout is
 * reviewed once and answered 71 times.
 */

import { keccak256, type Hex } from 'viem'

/**
 * Identifies a change by the exact bytes the Safe will execute.
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

export type ProposalIntegrityFailure = 'stale-nonce'

export interface IProposalIntegrityInput {
  nonceStatus: 'current' | 'stale' | 'future'
}

export interface IProposalIntegrity {
  ok: boolean
  failures: ProposalIntegrityFailure[]
}

/**
 * Per-network integrity verdict for one proposal.
 *
 * A future nonce is legitimate — a lower-nonce proposal executing earlier in the
 * same run makes it current — so only a consumed nonce is a failure.
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
 * @param fingerprint - The change fingerprint to look up.
 * @returns Whether this change was acknowledged earlier in the run.
 */
export const isChangeAcknowledged = (
  ledger: IAcknowledgementLedger,
  fingerprint: Hex
): boolean => (ledger.acknowledgedProposalKeys.get(fingerprint)?.size ?? 0) > 0

export interface IAcknowledgementPromptInput {
  alreadyAcknowledged: boolean
  integrityOk: boolean
}

/**
 * Whether the operator must acknowledge this proposal before it proceeds.
 *
 * An integrity failure always re-prompts: a rolled-up acknowledgement was
 * earned on a proposal that passed its checks and says nothing about one that
 * did not.
 *
 * @param input - Whether the change is already acknowledged and whether checks passed.
 * @returns Whether to prompt.
 */
export const shouldPromptForAcknowledgement = (
  input: IAcknowledgementPromptInput
): boolean => !input.alreadyAcknowledged || !input.integrityOk

export interface IAcknowledgementRecord {
  fingerprint: Hex
  proposalKey: string
  integrityOk: boolean
}

/**
 * Records an acknowledgement so later networks carrying the same bytes skip the
 * review prompt.
 *
 * @param ledger - The run's ledger, mutated in place.
 * @param record - The change, the proposal it was acknowledged on, and its integrity verdict.
 * @returns Whether the acknowledgement was stored; a failed proposal is never stored.
 */
export const recordAcknowledgement = (
  ledger: IAcknowledgementLedger,
  record: IAcknowledgementRecord
): boolean => {
  if (!record.integrityOk) return false

  const existing = ledger.acknowledgedProposalKeys.get(record.fingerprint)
  if (existing) existing.add(record.proposalKey)
  else
    ledger.acknowledgedProposalKeys.set(
      record.fingerprint,
      new Set([record.proposalKey])
    )

  return true
}

export interface INetworkOutcome {
  network: string
  proposalKey: string
  fingerprint: Hex
  checksPassed: boolean
  acknowledged: boolean
}

export interface IChangeRollup {
  fingerprint: Hex
  networks: number
  checksPassed: number
  acknowledged: number
  failedNetworks: string[]
  green: boolean
}

/**
 * Groups per-network outcomes by change so the run can report N/N.
 *
 * Checks are counted per network and are never rolled up into a single verdict;
 * only the acknowledgement count rolls up.
 *
 * @param outcomes - One entry per proposal seen, in the order they were seen.
 * @returns One rollup per distinct change, in first-seen order.
 */
export const rollUpByChange = (
  outcomes: INetworkOutcome[]
): IChangeRollup[] => {
  const byFingerprint = new Map<Hex, Map<string, INetworkOutcome>>()

  for (const outcome of outcomes) {
    const perProposal =
      byFingerprint.get(outcome.fingerprint) ??
      new Map<string, INetworkOutcome>()
    perProposal.set(outcome.proposalKey, outcome)
    byFingerprint.set(outcome.fingerprint, perProposal)
  }

  return [...byFingerprint.entries()].map(([fingerprint, perProposal]) => {
    const entries = [...perProposal.values()]
    const checksPassed = entries.filter((e) => e.checksPassed).length

    return {
      fingerprint,
      networks: entries.length,
      checksPassed,
      acknowledged: entries.filter((e) => e.acknowledged).length,
      failedNetworks: entries
        .filter((e) => !e.checksPassed)
        .map((e) => e.network),
      green: entries.length > 0 && checksPassed === entries.length,
    }
  })
}

/**
 * Renders the acknowledgement roll-up as printable lines.
 *
 * @param rollups - Rollups from `rollUpByChange`.
 * @returns One line per change; a partial pass can never render as green.
 */
export const renderChangeRollup = (rollups: IChangeRollup[]): string[] =>
  rollups.map((rollup) => {
    const failures = rollup.failedNetworks.length
      ? ` · failed on ${rollup.failedNetworks.join(', ')}`
      : ''

    return `${rollup.green ? '✓' : '✗'} ${rollup.fingerprint.slice(
      0,
      10
    )} checks ${rollup.checksPassed}/${rollup.networks} · acknowledged on ${
      rollup.acknowledged
    }/${rollup.networks}${failures}`
  })
