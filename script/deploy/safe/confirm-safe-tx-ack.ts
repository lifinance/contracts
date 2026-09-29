/**
 * Acknowledgement bookkeeping for a multi-network Safe confirmation run.
 *
 * Import this from `confirm-safe-tx.ts`. It replaces the calldata-keyed action
 * cache: an operator's *action* is never remembered, while their *acknowledgement*
 * of a reviewed change rolls up across the networks it is genuinely the same on.
 *
 * The acknowledgement is implicit: selecting an action on a proposal
 * acknowledges it. So this module records and rolls up, and never gates.
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
 * Reachability worth knowing: a failing verdict is only ever seen on a bare
 * `Sign`, because every execute-shaped action on a stale nonce is already
 * terminated earlier in `processTxs`. It is warned about and recorded, and
 * blocks nothing on its own.
 *
 * @param input - The nonce status resolved against the Safe's on-chain nonce.
 * @returns Whether the proposal's nonce is usable, and why not if it is not.
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

export interface IAcknowledgementRecord {
  acknowledgementKey: Hex
  proposalKey: string
  integrityOk: boolean
}

/**
 * Records an acknowledgement of one proposal against its effect.
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
  /** Signatures held *after* whatever this run did, so the table reads as the queue's current state. */
  signatures: number
  threshold: number
  nonceCurrent: boolean
  /** Independent flags rather than one status: a Sign & Execute is both, and a reducer that picks one loses the other. */
  signedThisRun: boolean
  executedThisRun: boolean
  /** The run refused to act — a gate, the expected-state check, or a nonce that cannot reach the chain. */
  blocked: boolean
  /** This signer's signature was already on it when the run fetched it. */
  alreadySigned: boolean
}

export interface IQueueRollup {
  acknowledgementKey: Hex
  fingerprint: Hex
  proposals: number
  /** Still-queued proposals below their own threshold, keyed by signatures held. */
  bySignatureCount: Map<number, number>
  ready: number
  executed: number
  signed: number
  already: number
  blocked: number
  stale: number
}

export interface IQueueSummary {
  rollups: IQueueRollup[]
  proposals: number
  networks: number
  ready: number
  signed: number
  executed: number
  blocked: number
  stale: number
}

/**
 * Groups per-proposal outcomes by effect, so a fleet rollout is one row.
 *
 * Every proposal lands in exactly one of the signature buckets, `ready` or
 * `executed` — `blocked`, `already` and `stale` annotate those same proposals
 * and are counted separately, so no column is a partition of another.
 *
 * Callers may push a provisional entry for a proposal and a final one later:
 * within one effect group the last entry for a proposal key wins, so a run can
 * record every proposal it displayed and still report the outcome it ended on.
 * Superseding is scoped to the group, so both entries for a proposal must carry
 * the same `acknowledgementKey` — otherwise they land in two groups and the
 * proposal is counted twice. `processTxs` satisfies this by computing the key
 * once per proposal and reusing it for both pushes.
 *
 * @param outcomes - One or more entries per proposal seen, in the order they were seen.
 * @returns One rollup per distinct effect in first-seen order, plus run totals.
 */
export const rollUpQueue = (outcomes: INetworkOutcome[]): IQueueSummary => {
  const byEffect = new Map<Hex, Map<string, INetworkOutcome>>()

  for (const outcome of outcomes) {
    const perProposal =
      byEffect.get(outcome.acknowledgementKey) ??
      new Map<string, INetworkOutcome>()
    perProposal.set(outcome.proposalKey, outcome)
    byEffect.set(outcome.acknowledgementKey, perProposal)
  }

  const rollups = [...byEffect.entries()].map(
    ([acknowledgementKey, perProposal]): IQueueRollup => {
      // A group only exists because an outcome created it, so it is never empty.
      const [first, ...rest] = [...perProposal.values()] as [
        INetworkOutcome,
        ...INetworkOutcome[]
      ]
      const entries = [first, ...rest]
      const bySignatureCount = new Map<number, number>()
      let ready = 0

      for (const entry of entries) {
        // An executed proposal has left the queue, so it is in neither the
        // buckets nor `ready` — the columns describe what is still waiting.
        if (entry.executedThisRun) continue
        if (entry.signatures >= entry.threshold) {
          ready += 1
          continue
        }
        bySignatureCount.set(
          entry.signatures,
          (bySignatureCount.get(entry.signatures) ?? 0) + 1
        )
      }

      return {
        acknowledgementKey,
        fingerprint: first.fingerprint,
        proposals: entries.length,
        bySignatureCount,
        ready,
        executed: entries.filter((e) => e.executedThisRun).length,
        signed: entries.filter((e) => e.signedThisRun).length,
        already: entries.filter((e) => e.alreadySigned && !e.signedThisRun)
          .length,
        blocked: entries.filter((e) => e.blocked).length,
        stale: entries.filter((e) => !e.nonceCurrent).length,
      }
    }
  )

  const networks = new Set<string>()
  for (const perProposal of byEffect.values())
    for (const entry of perProposal.values()) networks.add(entry.network)

  const total = (pick: (rollup: IQueueRollup) => number): number =>
    rollups.reduce((sum, rollup) => sum + pick(rollup), 0)

  return {
    rollups,
    proposals: total((rollup) => rollup.proposals),
    networks: networks.size,
    ready: total((rollup) => rollup.ready),
    signed: total((rollup) => rollup.signed),
    executed: total((rollup) => rollup.executed),
    blocked: total((rollup) => rollup.blocked),
    stale: total((rollup) => rollup.stale),
  }
}

/** Width of the payload column; a 10-character fingerprint plus a gap. */
const PAYLOAD_WIDTH = 13
/** Width of every named count column, so the labels are their own ruler. */
const COUNT_WIDTH = 10
/** Width of a signature bucket, which is only ever a single-digit header. */
const BUCKET_WIDTH = 6
/**
 * Zero prints as a dot. A grid of `0`s is what made the previous summary
 * unreadable: the eye should land only on the cells that carry something.
 */
const EMPTY_CELL = '·'

const cell = (value: number, width: number): string =>
  (value === 0 ? EMPTY_CELL : String(value)).padStart(width)

const centre = (label: string, width: number): string => {
  if (label.length >= width) return label
  const left = Math.floor((width - label.length) / 2)
  return ' '.repeat(left) + label + ' '.repeat(width - label.length - left)
}

const countOf = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

interface IOptionalColumn {
  label: string
  /** `run` columns sit under the "this run" group header; `state` under none. */
  group: 'run' | 'state'
  get: (rollup: IQueueRollup) => number
}

/**
 * Columns that appear only when some row has something to put in them.
 *
 * A clean single-network run then renders three columns rather than eight, and
 * a column that is present is a column worth reading.
 */
const OPTIONAL_COLUMNS: IOptionalColumn[] = [
  { label: 'signed', group: 'run', get: (rollup) => rollup.signed },
  { label: 'executed', group: 'run', get: (rollup) => rollup.executed },
  { label: 'already', group: 'state', get: (rollup) => rollup.already },
  { label: 'blocked', group: 'state', get: (rollup) => rollup.blocked },
  { label: 'stale', group: 'state', get: (rollup) => rollup.stale },
]

/**
 * The contiguous signature-count columns the rows actually need.
 *
 * Contiguous rather than only-the-occupied so the header reads as a scale; it
 * starts at the lowest count seen, because a `0` column of dots on a queue
 * where everything already carries a signature is noise.
 *
 * @param rollups - Every effect's roll-up for this run.
 * @returns Signature counts to render as columns, ascending; empty if nothing is below threshold.
 */
const signatureColumns = (rollups: readonly IQueueRollup[]): number[] => {
  const counts = rollups.flatMap((rollup) => [
    ...rollup.bySignatureCount.keys(),
  ])
  if (counts.length === 0) return []

  const lowest = Math.min(...counts)
  return Array.from(
    { length: Math.max(...counts) - lowest + 1 },
    (_, index) => lowest + index
  )
}

/**
 * Renders the queue as a table: one row per change, one column per fact.
 *
 * The heading says *pending* because that is the whole population the run ever
 * saw — a proposal already executed or cancelled is never fetched, so nothing
 * here can be read as a statement about it.
 *
 * Counts are named for exactly what they measure. `signed` and `executed` are
 * what this run did; nothing here observes that a change was *reviewed*.
 *
 * @param summary - The roll-up from `rollUpQueue`.
 * @returns The lines to print, or none when the run saw no proposal at all.
 */
export const renderQueueSummary = (summary: IQueueSummary): string[] => {
  if (summary.rollups.length === 0) return []

  const buckets = signatureColumns(summary.rollups)
  const optional = OPTIONAL_COLUMNS.filter((column) =>
    summary.rollups.some((rollup) => column.get(rollup) > 0)
  )
  const ordered = [
    ...optional.filter((column) => column.group === 'run'),
    ...optional.filter((column) => column.group === 'state'),
  ]

  const lead =
    '  ' + 'payload'.padEnd(PAYLOAD_WIDTH) + 'proposals'.padStart(COUNT_WIDTH)
  const runSpan =
    optional.filter((column) => column.group === 'run').length * COUNT_WIDTH

  const groupHeader = (
    ' '.repeat(lead.length) +
    centre(
      'signatures collected',
      buckets.length * BUCKET_WIDTH + COUNT_WIDTH
    ) +
    (runSpan > 0 ? centre('this run', runSpan) : '')
  ).trimEnd()

  const columnHeader =
    lead +
    buckets.map((count) => String(count).padStart(BUCKET_WIDTH)).join('') +
    'ready'.padStart(COUNT_WIDTH) +
    ordered.map((column) => column.label.padStart(COUNT_WIDTH)).join('')

  const rows = summary.rollups.map(
    (rollup) =>
      '  ' +
      rollup.fingerprint.slice(0, 10).padEnd(PAYLOAD_WIDTH) +
      String(rollup.proposals).padStart(COUNT_WIDTH) +
      buckets
        .map((count) =>
          cell(rollup.bySignatureCount.get(count) ?? 0, BUCKET_WIDTH)
        )
        .join('') +
      cell(rollup.ready, COUNT_WIDTH) +
      ordered.map((column) => cell(column.get(rollup), COUNT_WIDTH)).join('')
  )

  const footer = [
    `${summary.proposals} pending at run start`,
    `${summary.ready} at threshold`,
    `signed ${summary.signed}`,
    `executed ${summary.executed}`,
  ]
  if (summary.blocked > 0) footer.push(`${summary.blocked} blocked`)
  if (summary.stale > 0) footer.push(`${summary.stale} on a stale nonce`)

  return [
    `=== Pending proposal queue — ${countOf(
      summary.proposals,
      'proposal'
    )} across ${countOf(summary.networks, 'network')} ===`,
    groupHeader,
    columnHeader,
    ...rows,
    '  ' + footer.join(' · '),
  ]
}
