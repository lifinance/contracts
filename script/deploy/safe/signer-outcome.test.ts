// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ICheckResult } from './check-ledger'
import {
  ALL_GATE_DEFINITIONS,
  CODEHASH_CHECK_ID,
  CONFIRM_CHECK_DEFINITIONS,
} from './confirm-check-registry'
import { bucketOf, renderProposalOutcome } from './signer-view'
import { signerChecks, viewDefinitions } from './signer-zones'

const NETWORK = 'arbitrum'

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
  stripAnsi(renderProposalOutcome(bucketed(codehash)).join('\n'))

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
