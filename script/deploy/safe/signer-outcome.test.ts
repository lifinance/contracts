// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ICheckResult } from './check-ledger'
import {
  ALL_GATE_DEFINITIONS,
  CODEHASH_CHECK_ID,
  CONFIRM_CHECK_DEFINITIONS,
  EXECUTABILITY_CHECK_ID,
  STORAGE_AUTHORITY_CHECK_ID,
  TARGET_STATE_CHECK_ID,
} from './confirm-check-registry'
import { bucketOf, renderProposalOutcome } from './signer-view'
import { signerChecks, viewDefinitions } from './signer-zones'

const NETWORK = 'arbitrum'

const NOTHING_REFUSED = {
  definiteReds: [],
  delegatecallRefused: false,
} as const

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const row = (
  checkId: string,
  status: ICheckResult['status'],
  overrides: Partial<ICheckResult> = {}
): ICheckResult =>
  ({
    checkId,
    network: NETWORK,
    status,
    expected: 'the assertion held',
    actual: 'the assertion held',
    anchor: 'A-LOCAL',
    ...overrides,
  } as ICheckResult)

/**
 * Every gate the run answers for, each passing.
 *
 * Read off `CONFIRM_CHECK_DEFINITIONS` rather than listed, so a gate joining
 * the roster joins these cases instead of leaving them grading a shorter run
 * than the CLI does.
 */
const otherGatesPassing = (): ICheckResult[] =>
  CONFIRM_CHECK_DEFINITIONS.filter(
    (definition) => definition.checkId !== CODEHASH_CHECK_ID
  ).map((definition) => row(definition.checkId, 'pass'))

const bucketed = (codehash: ICheckResult) =>
  signerChecks({
    results: [...otherGatesPassing(), codehash],
    definitions: viewDefinitions(ALL_GATE_DEFINITIONS),
  })

const outcomeFor = (codehash: ICheckResult): string =>
  stripAnsi(
    renderProposalOutcome(bucketed(codehash), NOTHING_REFUSED).join('\n')
  )

const codehashBucket = (codehash: ICheckResult): string | undefined => {
  const entry = bucketed(codehash).find(
    (one) => one.result.checkId === CODEHASH_CHECK_ID
  )
  return entry ? bucketOf(entry) : undefined
}

/**
 * The closing verdict, against the one gate that refuses after the choice.
 *
 * The codehash refusal lives in `assertCodehashSignGateAllowsSigning` and stays
 * there — Sign remains on offer so the signer learns *which* proposal is
 * unsignable and why. What these pin is the sentence printed before that
 * choice: a signer told every gate passed and then refused learns to read past
 * the summary, which costs the summary its only job.
 *
 * The rows are written here rather than produced, so this holds the view to the
 * contract regardless of which caller supplies the verdict: a `fail` is the
 * gate having compared bytecode and found it different, an `error` is the gate
 * not having been able to judge at all, and the two must not collapse.
 */
describe('the closing verdict counts the codehash gate', () => {
  it('does not call a run green when the codehash gate disagreed', () => {
    const outcome = outcomeFor(
      row(CODEHASH_CHECK_ID, 'fail', {
        expected: 'every installed address carrying attested bytecode',
        actual: '0x…f1: MISMATCH',
        anchor: 'A-AUDIT',
      })
    )

    expect(outcome).not.toContain('Every mandatory gate passed')
    expect(outcome).not.toContain('Every gate passed')
    expect(outcome).toContain('cannot be signed')
    // Named, not merely counted: the signer has to know which gate to go read.
    expect(outcome).toContain('Gate K')
  })

  // Without this, a change that blanket-blocks on the codehash gate satisfies
  // the case above while making every clean run unsignable.
  it('still reaches green when the codehash gate passed with the rest', () => {
    expect(outcomeFor(row(CODEHASH_CHECK_ID, 'pass'))).toContain(
      'Every gate passed'
    )
  })

  // An integrity gate has no acknowledgement path, so a disagreement it did
  // observe must not land where a signer can wave it through.
  it('files a compared-and-different target as wrong, not as acknowledgeable', () => {
    expect(codehashBucket(row(CODEHASH_CHECK_ID, 'fail'))).toBe('wrong')
  })

  // "The gate could not run" and "the gate disagreed" are the two things this
  // gate exists to keep apart: the first is the signer's environment, the
  // second is the proposal.
  it('files a gate that reached no verdict as unchecked, not as wrong', () => {
    const unevaluated = row(CODEHASH_CHECK_ID, 'error', {
      actual: 'the codehash gate produced no verdict for this proposal',
      anchor: 'A-UNRESOLVED',
    })

    expect(codehashBucket(unevaluated)).toBe('unchecked')

    const outcome = outcomeFor(unevaluated)
    expect(outcome).not.toContain('Every gate passed')
    expect(outcome).toContain('could not be checked')
  })
})

/**
 * The gates a subtractive proposal leaves nothing for.
 *
 * A removal-only cut installs no version to compare against `origin/main` and
 * no contract whose constructor-written authorities there is anything to read,
 * so both gates record that they had nothing to grade. The sentence printed
 * over the prompt is the last thing a signer reads, and it has to distinguish
 * that from the two gates having failed to run.
 */
describe('the closing verdict on a proposal that installs nothing', () => {
  const standingDown = (): ICheckResult[] => [
    ...CONFIRM_CHECK_DEFINITIONS.filter(
      (definition) =>
        definition.checkId !== CODEHASH_CHECK_ID &&
        definition.checkId !== TARGET_STATE_CHECK_ID &&
        definition.checkId !== STORAGE_AUTHORITY_CHECK_ID
    ).map((definition) => row(definition.checkId, 'pass')),
    row(CODEHASH_CHECK_ID, 'pass'),
    row(TARGET_STATE_CHECK_ID, 'not-applicable' as ICheckResult['status']),
    row(STORAGE_AUTHORITY_CHECK_ID, 'not-applicable' as ICheckResult['status']),
  ]

  it('reaches green rather than blaming the signer for an unmade reading', () => {
    const outcome = stripAnsi(
      renderProposalOutcome(
        signerChecks({
          results: standingDown(),
          definitions: viewDefinitions(ALL_GATE_DEFINITIONS),
        }),
        NOTHING_REFUSED
      ).join('\n')
    )

    expect(outcome).toContain('Every gate passed')
    expect(outcome).not.toContain('could not be checked')
    expect(outcome).not.toContain('Gate G')
    expect(outcome).not.toContain('Gate H')
  })
})

/**
 * The closing verdict against the action menu.
 *
 * The menu withholds every signing option on a definite red from G, I, J or L
 * and offers Sign otherwise, so the sentence printed above it must say the
 * same: never "cannot be signed" over a Sign that would produce a signature,
 * and never a signable proposal while Sign is withheld.
 */
describe('the closing verdict agrees with the action menu', () => {
  const withRows = (...overrides: ICheckResult[]) =>
    signerChecks({
      results: [
        ...CONFIRM_CHECK_DEFINITIONS.filter(
          (definition) =>
            !overrides.some((one) => one.checkId === definition.checkId)
        ).map((definition) => row(definition.checkId, 'pass')),
        ...overrides,
      ],
      definitions: viewDefinitions(ALL_GATE_DEFINITIONS),
    })

  const say = (
    rows: ReturnType<typeof withRows>,
    refusal: Parameters<typeof renderProposalOutcome>[1]
  ): string => stripAnsi(renderProposalOutcome(rows, refusal).join('\n'))

  const reverting = row(EXECUTABILITY_CHECK_ID, 'fail', {
    actual: '1 of 2 call(s) would revert',
    anchor: 'A-CHAIN',
  })

  it('refuses in words on a definite red, naming the gate', () => {
    const outcome = say(withRows(reverting), {
      definiteReds: [
        { gate: 'I', reason: 'call[0].diamondCut[0] would revert' },
      ],
      delegatecallRefused: false,
    })
    expect(outcome).toContain('This proposal cannot be signed or executed')
    expect(outcome).toContain('Gate I')
    expect(outcome).toContain('call[0].diamondCut[0] would revert')
    expect(outcome).toContain('Only Do Nothing is offered')
    expect(outcome).not.toContain('Also disagreed')
  })

  it('names the other gates that disagreed beside a definite red', () => {
    const tampered = row(CODEHASH_CHECK_ID, 'fail', {
      actual: '1 address does not match its attested build',
      anchor: 'A-CHAIN',
    })
    const outcome = say(withRows(tampered), {
      definiteReds: [
        {
          gate: 'L',
          reason: '0x5AfE… holds an immutable value config does not declare',
        },
      ],
      delegatecallRefused: false,
    })
    expect(outcome).toContain('Gate L found a definite red')
    expect(outcome.replace(/\s+/g, ' ')).toContain('Also disagreed: Gate K.')
  })

  it('does not refuse in words on the same rows when the menu refused nothing', () => {
    // The present half: what decides the sentence is the refusal the menu was
    // built from, not the row alone.
    const outcome = say(withRows(reverting), NOTHING_REFUSED)
    expect(outcome).not.toContain('cannot be signed')
    expect(outcome).toContain('Every mandatory gate passed')
  })

  it('words a gate G that could not read its authorities as advisory', () => {
    const unread = row(STORAGE_AUTHORITY_CHECK_ID, 'error', {
      actual: 'TokenWrapper.owner: NOT READ — rpc timeout',
      anchor: 'A-UNRESOLVED',
    })
    const outcome = say(withRows(unread), NOTHING_REFUSED)
    expect(outcome).not.toContain('cannot be signed')
    expect(outcome).toContain('Nothing here blocks the signature')
    expect(outcome).toContain('Gate G')
  })

  it('still says cannot be signed yet when a gate that refuses inside the signer is unchecked', () => {
    const unchecked = row(CODEHASH_CHECK_ID, 'error', {
      actual: 'the codehash gate could not be evaluated',
      anchor: 'A-UNRESOLVED',
    })
    const outcome = say(withRows(unchecked), NOTHING_REFUSED)
    expect(outcome).toContain('This proposal cannot be signed yet')
    expect(outcome).toContain('Gate K')
  })

  it('says cannot be signed on a delegatecall refusal', () => {
    const outcome = say(withRows(), {
      definiteReds: [],
      delegatecallRefused: true,
    })
    expect(outcome).toContain('This proposal cannot be signed')
    expect(say(withRows(), NOTHING_REFUSED)).toContain('Every gate passed')
  })
})
