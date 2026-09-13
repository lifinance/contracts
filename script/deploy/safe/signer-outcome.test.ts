// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ICheckResult } from './check-ledger'
import type { ICodehashSignGate } from './codehash-sign-gate'
import {
  ALL_GATE_DEFINITIONS,
  CODEHASH_CHECK_ID,
  CONFIRM_CHECK_DEFINITIONS,
  codehashCheckResult,
} from './confirm-check-registry'
import { bucketOf, renderProposalOutcome } from './signer-view'
import { signerChecks, viewDefinitions } from './signer-zones'

const NETWORK = 'arbitrum'

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const gate = (overrides: Partial<ICodehashSignGate> = {}): ICodehashSignGate =>
  ({
    blocksSigning: false,
    evaluated: true,
    refusals: [],
    targets: [
      {
        address: '0x00000000000000000000000000000000000000f1',
        verdict: 'MATCH',
        reason: 'bytecode reproduced from an attested build',
        matchedLineages: ['lineage-1'],
        excludedByteCount: 0,
      },
    ],
    summary: 'every target matched',
    ...overrides,
  } as ICodehashSignGate)

/**
 * Every registered gate but the codehash one, each passing.
 *
 * Built off `CONFIRM_CHECK_DEFINITIONS` rather than listed, so a gate added to
 * the roster joins these cases instead of leaving them grading a shorter run
 * than the CLI does.
 */
const otherGatesPassing = (): ICheckResult[] =>
  CONFIRM_CHECK_DEFINITIONS.filter(
    (definition) => definition.checkId !== CODEHASH_CHECK_ID
  ).map(
    (definition) =>
      ({
        checkId: definition.checkId,
        network: NETWORK,
        status: 'pass',
        expected: 'the assertion held',
        actual: 'the assertion held',
        anchor: 'A-LOCAL',
      } as ICheckResult)
  )

const outcomeFor = (codehash: ICodehashSignGate): string =>
  stripAnsi(
    renderProposalOutcome(
      signerChecks({
        results: [
          ...otherGatesPassing(),
          codehashCheckResult(codehash, NETWORK),
        ],
        definitions: viewDefinitions(ALL_GATE_DEFINITIONS),
      })
    ).join('\n')
  )

const codehashBucket = (codehash: ICodehashSignGate): string | undefined => {
  const rows = signerChecks({
    results: [codehashCheckResult(codehash, NETWORK)],
    definitions: viewDefinitions(ALL_GATE_DEFINITIONS),
  })
  const row = rows.find((entry) => entry.result.checkId === CODEHASH_CHECK_ID)
  return row ? bucketOf(row) : undefined
}

/**
 * The closing verdict against the gate that refuses after the signer chooses.
 *
 * The refusal itself lives in `assertCodehashSignGateAllowsSigning` and stays
 * there — Sign remains on offer so the signer learns *which* proposal is
 * unsignable and why. What these pin is that the sentence printed before that
 * choice reports the same verdict: a signer told every gate passed and then
 * refused learns to read past the summary.
 */
describe('the closing verdict counts the codehash gate', () => {
  it('does not call a run green when the codehash gate disagreed', () => {
    const outcome = outcomeFor(
      gate({
        blocksSigning: true,
        targets: [
          {
            address: '0x00000000000000000000000000000000000000f1',
            verdict: 'MISMATCH',
            reason: 'bytecode is not from any attested build',
            matchedLineages: [],
            excludedByteCount: 0,
          },
        ],
      })
    )

    expect(outcome).not.toContain('Every mandatory gate passed')
    expect(outcome).not.toContain('Every gate passed')
    expect(outcome).toContain('cannot be signed')
    // Named, not merely counted: the signer has to know which gate to go read.
    expect(outcome).toContain('Gate K')
  })

  // Without this, a change that blanket-blocks on the codehash gate passes the
  // case above while making every clean run unsignable.
  it('still reaches green when the codehash gate passed with the rest', () => {
    expect(outcomeFor(gate())).toContain('Every gate passed')
  })

  // "The gate could not run" and "the gate passed" are the two things this gate
  // exists to keep apart, and so are "could not run" and "disagreed": the first
  // is the signer's environment, the second is the proposal.
  it('files a gate that never reached a verdict as unchecked, not as wrong', () => {
    expect(
      codehashBucket(gate({ evaluated: false, targets: [], summary: '' }))
    ).toBe('unchecked')

    const outcome = outcomeFor(
      gate({ evaluated: false, targets: [], summary: '' })
    )
    expect(outcome).not.toContain('Every gate passed')
    expect(outcome).toContain('could not be checked')
  })

  it('files a compared-and-different target as wrong, not as unchecked', () => {
    expect(
      codehashBucket(
        gate({
          blocksSigning: true,
          targets: [
            {
              address: '0x00000000000000000000000000000000000000f1',
              verdict: 'MISMATCH',
              reason: 'bytecode is not from any attested build',
              matchedLineages: [],
              excludedByteCount: 0,
            },
          ],
        })
      )
    ).toBe('wrong')
  })
})
