/**
 * Decides whether gate G, I, J or L reached a definite red on one proposal — a
 * reading that was actually made and disagreed — and refuses the signature on
 * one. `confirm-safe-tx.ts` reads the one verdict for the action menu, the
 * outcome banner and both the sign and the execute funnel, so they cannot
 * disagree.
 *
 * Everything these gates report short of a definite red — a read that could
 * not be made, a provider that did not answer, a value nobody declared, a check
 * that does not apply — stays advisory and is left to the signer.
 */

import type { ImmutableVerdictStatus } from '../codehash/immutable-verdict'

import type { ICodehashSignGate } from './codehash-sign-gate'
import {
  ExecutabilityFindingEnum,
  RevertCertaintyEnum,
  type IExecutabilityCall,
  type IExecutabilityVerdict,
  type TCallOutcome,
} from './executability-simulation'
import { printableField } from './printable-field'
import {
  MIN_INDEPENDENT_PROVIDERS,
  type IRpcQuorumVerdict,
  type TQuorumStatus,
} from './rpc-quorum'
import type { ISignedAuthorityEntry } from './signed-set-record'

export type TDefiniteRedGate = 'G' | 'I' | 'J' | 'L'

/**
 * The gates whose findings short of a definite red do not block.
 *
 * The outcome banner reads this to word an unestablished G, I, J or L as
 * advisory. Every other gate keeps its own enforcement, so its unchecked rows
 * still read as a refusal.
 */
export const GATES_ADVISORY_SHORT_OF_DEFINITE_RED: ReadonlySet<string> =
  new Set<TDefiniteRedGate>(['G', 'I', 'J', 'L'])

export interface IDefiniteRed {
  gate: TDefiniteRedGate
  reason: string
}

export interface IDefiniteRedVerdict {
  /** Which transaction this verdict is about, as `proposalKeyOf` renders it. */
  gradedKey: string
  reds: readonly IDefiniteRed[]
}

/**
 * How a quorum status is treated.
 *
 * `conflict` blocks only when two or more independent providers answered: two
 * endpoints of one provider disagreeing with each other is that provider being
 * inconsistent, not providers disagreeing. Exhaustive, so a status added to
 * `TQuorumStatus` fails to compile here; one that reaches this module anyway is
 * in neither set and blocks.
 */
const QUORUM_POLICY: Readonly<Record<TQuorumStatus, 'proceeds' | 'conflict'>> =
  {
    agreed: 'proceeds',
    'agreed-absent': 'proceeds',
    'heights-not-aligned': 'proceeds',
    'insufficient-providers': 'proceeds',
    'insufficient-responses': 'proceeds',
    'no-responses': 'proceeds',
    'provider-identity-unverifiable': 'proceeds',
    'quorum-misconfigured': 'proceeds',
    disagreement: 'conflict',
    'fork-divergence': 'conflict',
  }

/**
 * Call outcomes a signature may proceed on. `unknown` is a payload the run
 * could not simulate, which stays advisory.
 */
const CALL_OUTCOMES_THAT_PROCEED: Readonly<
  Record<TCallOutcome, 'proceeds' | 'blocks'>
> = {
  'would-execute': 'proceeds',
  unknown: 'proceeds',
  'would-revert': 'blocks',
}

/**
 * Immutable verdicts a signature may proceed on. Only `disagrees` is a value
 * that was read, compared and found different.
 */
const IMMUTABLE_VERDICTS_THAT_PROCEED: Readonly<
  Record<ImmutableVerdictStatus, 'proceeds' | 'blocks'>
> = {
  none: 'proceeds',
  verified: 'proceeds',
  unpriced: 'proceeds',
  documented: 'proceeds',
  assumed: 'proceeds',
  unreadable: 'proceeds',
  disagrees: 'blocks',
}

// Maps, never `in` or an index on the record: either walks the prototype, so a
// status spelled like an inherited property would read as a member.
const proceeds = <K extends string>(
  policy: Readonly<Record<K, string>>
): ReadonlySet<string> =>
  new Set(
    Object.entries<string>(policy)
      .filter(([, treatment]) => treatment === 'proceeds')
      .map(([status]) => status)
  )

const QUORUM_PROCEEDS = proceeds(QUORUM_POLICY)
const QUORUM_CONFLICTS: ReadonlySet<string> = new Set(
  Object.entries<string>(QUORUM_POLICY)
    .filter(([, treatment]) => treatment === 'conflict')
    .map(([status]) => status)
)
const CALL_PROCEEDS = proceeds(CALL_OUTCOMES_THAT_PROCEED)
const IMMUTABLE_PROCEEDS = proceeds(IMMUTABLE_VERDICTS_THAT_PROCEED)

const normalise = (value: string): string => value.trim().toLowerCase()

/**
 * Findings about the Safe's queue rather than a payload. A proposal built ahead
 * of the queue must stay signable so its signatures can accumulate, and a stale
 * one is refused at execution by the nonce gate.
 */
const QUEUE_FINDINGS: ReadonlySet<string> = new Set([
  ExecutabilityFindingEnum.NonceAlreadyUsed,
  ExecutabilityFindingEnum.NonceCollision,
  ExecutabilityFindingEnum.NonceGap,
])

/**
 * The blocking findings a payload's own bytes prove, whatever the chain state.
 *
 * Read beside the outcome because the simulation grades a call `unknown` when
 * its `eth_call` could not be made, and that discards the proof. A composed
 * proof rests on an earlier payload and is not this payload's own.
 */
const provenFindings = (call: IExecutabilityCall): string[] =>
  call.findings
    .filter(
      (finding) =>
        finding.blocking &&
        finding.certainty === RevertCertaintyEnum.Proven &&
        finding.composed !== true &&
        !QUEUE_FINDINGS.has(finding.code)
    )
    .map((finding) => finding.code)

/**
 * Gate G: a declared authority that was read and holds something other than
 * what is declared for it.
 *
 * Every expectation source counts, the deployment record included. A record
 * the proposer wrote can only make their own proposal refuse here; exempting it
 * would let owner drift on a contract whose expectation comes from the record
 * through unopposed.
 *
 * @param entries - The authorities of the contracts this proposal installs, or
 * undefined when nothing was observed.
 * @returns One red per mismatching authority.
 */
export const storageAuthorityDefiniteReds = (
  entries: readonly ISignedAuthorityEntry[] | undefined
): IDefiniteRed[] =>
  (entries ?? []).flatMap((entry): IDefiniteRed[] => {
    const notRead =
      entry.readError !== undefined || entry.liveValue === undefined
    if (notRead || entry.expectedValue === undefined) return []
    if (
      typeof entry.liveValue === 'string' &&
      typeof entry.expectedValue === 'string' &&
      normalise(entry.liveValue) === normalise(entry.expectedValue)
    )
      return []
    return [
      {
        gate: 'G',
        reason: `${printableField(entry.label)} holds ${printableField(
          entry.liveValue
        )}, while ${printableField(entry.expectedValue)} is declared`,
      },
    ]
  })

/**
 * Gate I: a payload the simulation decided would revert, or whose own bytes
 * prove it cannot execute.
 *
 * Read per call rather than from `refuses`, which also carries the Safe-nonce
 * findings: a proposal built ahead of the queue must stay signable so its
 * signatures can accumulate.
 *
 * @param verdict - The simulation, or undefined when none was made.
 * @returns One red per call that cannot execute.
 */
export const executabilityDefiniteReds = (
  verdict: IExecutabilityVerdict | undefined
): IDefiniteRed[] =>
  (verdict?.calls ?? []).flatMap((call): IDefiniteRed[] => {
    if (CALL_PROCEEDS.has(call.outcome)) {
      const proven = provenFindings(call)
      return proven.length === 0
        ? []
        : [
            {
              gate: 'I',
              reason: `${printableField(
                call.path
              )} cannot execute: its calldata proves ${proven
                .map((code) => printableField(code))
                .join(', ')}`,
            },
          ]
    }
    return [
      {
        gate: 'I',
        reason:
          call.outcome === 'would-revert'
            ? `${printableField(call.path)} would revert`
            : `${printableField(
                call.path
              )} has an outcome this gate does not recognise (${printableField(
                call.outcome
              )})`,
      },
    ]
  })

/**
 * Gate J: two or more independent providers answered and disagree.
 *
 * Too few providers, providers that did not answer and an unresolved anchor
 * all stay advisory: they are missing redundancy, not evidence of a lie.
 *
 * @param verdict - The quorum verdict, or undefined when no read was made.
 * @returns At most one red.
 */
export const rpcQuorumDefiniteReds = (
  verdict: IRpcQuorumVerdict | undefined
): IDefiniteRed[] => {
  if (!verdict || QUORUM_PROCEEDS.has(verdict.status)) return []
  if (QUORUM_CONFLICTS.has(verdict.status)) {
    if (verdict.respondingProviders < MIN_INDEPENDENT_PROVIDERS) return []
    return [
      {
        gate: 'J',
        reason: `${verdict.respondingProviders} independent providers answered and disagree (${verdict.status})`,
      },
    ]
  }
  return [
    {
      gate: 'J',
      reason: `the quorum read ended in a status this gate does not recognise (${printableField(
        verdict.status
      )})`,
    },
  ]
}

/**
 * Gate L: an immutable that was compared and holds a different value.
 *
 * @param gate - The codehash gate whose targets carry gate L's verdicts.
 * @returns One red per address whose immutables disagree.
 */
export const immutablesDefiniteReds = (
  gate: ICodehashSignGate
): IDefiniteRed[] =>
  gate.targets.flatMap((target): IDefiniteRed[] => {
    const status = target.immutables?.status
    if (status !== undefined && IMMUTABLE_PROCEEDS.has(status)) return []
    return [
      {
        gate: 'L',
        reason:
          status === 'disagrees'
            ? `${printableField(
                target.address
              )} holds an immutable value config does not declare`
            : `${printableField(
                target.address
              )} carries an immutable verdict this gate does not recognise (${printableField(
                status
              )})`,
      },
    ]
  })

/**
 * Collects every definite red one proposal's evidence carries.
 *
 * @param input - The proposal's key and the four gates' own verdicts.
 * @returns The verdict, bound to `gradedKey`.
 */
export const evaluateDefiniteReds = (input: {
  gradedKey: string
  storageAuthority: readonly ISignedAuthorityEntry[] | undefined
  executability: IExecutabilityVerdict | undefined
  rpcQuorum: IRpcQuorumVerdict | undefined
  codehash: ICodehashSignGate
}): IDefiniteRedVerdict => ({
  gradedKey: input.gradedKey,
  reds: [
    ...storageAuthorityDefiniteReds(input.storageAuthority),
    ...executabilityDefiniteReds(input.executability),
    ...rpcQuorumDefiniteReds(input.rpcQuorum),
    ...immutablesDefiniteReds(input.codehash),
  ],
})

/**
 * The gate letters a verdict blocks on, in G, I, J, L order and each once.
 *
 * @param verdict - The verdict to read.
 * @returns The letters, empty when nothing blocks.
 */
export const definiteRedGates = (
  verdict: IDefiniteRedVerdict
): TDefiniteRedGate[] =>
  (['G', 'I', 'J', 'L'] as const).filter((gate) =>
    verdict.reds.some((red) => red.gate === gate)
  )

/**
 * Throws unless this transaction may be signed or executed as far as gates G,
 * I, J and L are concerned.
 *
 * A verdict that is absent, or about another transaction, refuses: "never
 * evaluated" and "evaluated and clean" are the two things this exists to keep
 * apart.
 *
 * @param verdict - The verdict taken for the proposal on screen.
 * @param key - `proposalKeyOf` of the struct about to be signed or broadcast.
 * @throws When a definite red stands, or the verdict does not speak for `key`.
 */
export const assertNoDefiniteRed = (
  verdict: IDefiniteRedVerdict | undefined,
  key: string
): void => {
  if (verdict && verdict.gradedKey === key && verdict.reds.length === 0) return

  const why = !verdict
    ? 'gates G, I, J and L were never evaluated for this transaction.'
    : verdict.gradedKey !== key
    ? `the verdict on gates G, I, J and L is about a different transaction — it graded ${verdict.gradedKey} and this is ${key}.`
    : verdict.reds.map((red) => `Gate ${red.gate}: ${red.reason}.`).join(' ')

  throw new Error(
    `Definite red: this transaction will not be signed or executed. ${why} Nothing has been signed or broadcast.`
  )
}
