import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { assertLedgerProposesOnce } from './ledger-guards'

describe('assertLedgerProposesOnce', () => {
  it('refuses a Ledger run that would propose more than once', () => {
    expect(() =>
      assertLedgerProposesOnce(2, true, '--periphery with several names')
    ).toThrow(/cannot be combined with --periphery with several names/)
  })

  it('names the count, so the operator knows how far to split the run', () => {
    expect(() => assertLedgerProposesOnce(71, true, '--all-networks')).toThrow(
      /\(71 proposals\)/
    )
  })

  it('allows a Ledger run that proposes exactly once', () => {
    // The refusal must key on the count, not on the flag being present:
    // refusing every --ledger run would remove the option D11 exists to add.
    expect(() => assertLedgerProposesOnce(1, true, '--periphery')).not.toThrow()
  })

  it('allows many proposals when no Ledger is involved', () => {
    expect(() =>
      assertLedgerProposesOnce(71, false, '--all-networks')
    ).not.toThrow()
  })

  it('allows a zero-proposal run', () => {
    expect(() => assertLedgerProposesOnce(0, true, '--facets')).not.toThrow()
  })
})

describe('assertLedgerProposesOnce — a dry run proposes nothing', () => {
  it('is not called at all for a count of zero, and refuses nothing', () => {
    // A fleet sweep without --yes never reaches sendOrPropose, so no transport
    // opens and there is nothing to refuse. Callers express that by not calling
    // this, or by passing the count the run will actually propose.
    expect(() =>
      assertLedgerProposesOnce(0, true, '--all-networks')
    ).not.toThrow()
  })
})
