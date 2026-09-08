/**
 * The operation gate: refuse a `DelegateCall` proposal on the operation field
 * alone.
 *
 * Two properties matter more than the happy path. **A plain call is
 * unaffected** — a guard that refused everything would satisfy every refusal
 * case here while making the tool unusable, which is the failure a sibling PR's
 * executor shipped: it had no test that it ever broadcasts. And **absent is not
 * `Call`** — the field arrives from MongoDB through a cast, so it can be
 * missing at runtime however it is typed, and defaulting it is a fail-open on
 * exactly the question being asked.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  assertDelegateCallGateAllowsSigning,
  evaluateDelegateCallGate,
  renderDelegateCallGate,
  SafeOperationEnum,
} from './delegatecall-gate'

describe('evaluateDelegateCallGate', () => {
  it('allows a plain call, so the gate is not "refuse everything"', () => {
    // The paired positive, first because every case below is a refusal: if this
    // ever fails, the others pass while the tool signs nothing at all.
    const verdict = evaluateDelegateCallGate({
      operation: SafeOperationEnum.Call,
    })

    expect(verdict.refuses).toBe(false)
    expect(verdict.reason).toBe('')
  })

  it('refuses a delegatecall', () => {
    const verdict = evaluateDelegateCallGate({
      operation: SafeOperationEnum.DelegateCall,
    })

    expect(verdict.refuses).toBe(true)
    expect(verdict.reason).toMatch(/delegatecall/i)
  })

  it('names why the decoded calldata is not the answer', () => {
    // Criterion 4: the render has to override the intuition it exists to
    // correct. "The calldata looked harmless" is precisely what a delegatecall
    // makes irrelevant, so the reason must say so rather than just state the
    // field value.
    const verdict = evaluateDelegateCallGate({
      operation: SafeOperationEnum.DelegateCall,
    })

    expect(verdict.reason).toMatch(/own storage/)
    expect(verdict.reason).toMatch(/calldata/)
  })

  it('refuses an absent operation rather than reading it as a call', () => {
    // `?? 0` here would be a fail-open on the very check being made. The field
    // is filled from a Mongo row through a cast in `initializeSafeTransaction`,
    // so it is absent whenever a row never carried it.
    const verdict = evaluateDelegateCallGate({})

    expect(verdict.refuses).toBe(true)
    expect(verdict.reason).toMatch(/no operation field/)
    // Distinct from the delegatecall reason: "we cannot tell" and "this is a
    // delegatecall" are different facts and a signer should not be told the
    // second when the first is true.
    expect(verdict.reason).not.toMatch(/operation = 1/)
  })

  it('refuses a value Safe does not define, rather than guessing', () => {
    const verdict = evaluateDelegateCallGate({ operation: 2 })

    expect(verdict.refuses).toBe(true)
    expect(verdict.reason).toMatch(/neither Call \(0\) nor DelegateCall \(1\)/)
  })

  it('refuses a stringly-typed zero, because the type is not the value', () => {
    // The field is cast, not validated, so `'0'` can reach this. `== 0` would
    // accept it; `=== 0` does not. A row whose operation is a string is a row
    // nothing in this repo wrote.
    const verdict = evaluateDelegateCallGate({
      operation: '0' as unknown as number,
    })

    expect(verdict.refuses).toBe(true)
  })
})

describe('renderDelegateCallGate', () => {
  it('says nothing for a plain call, so the line is never noise', () => {
    expect(
      renderDelegateCallGate(
        evaluateDelegateCallGate({ operation: SafeOperationEnum.Call })
      )
    ).toEqual([])
  })

  it('renders the refusal in red with its reason', () => {
    const lines = renderDelegateCallGate(
      evaluateDelegateCallGate({
        operation: SafeOperationEnum.DelegateCall,
      })
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('REFUSED')
    expect(lines[0]).toMatch(/own storage/)
    // The colour is part of the signal: a refusal that rendered in the same
    // colour as a pass is what teaches an operator to click through.
    expect(lines[0]).toContain(`${String.fromCharCode(27)}[31m`)
  })
})

describe('assertDelegateCallGateAllowsSigning', () => {
  it('returns quietly for a plain call', () => {
    expect(() =>
      assertDelegateCallGateAllowsSigning(
        evaluateDelegateCallGate({ operation: SafeOperationEnum.Call })
      )
    ).not.toThrow()
  })

  it('throws for a delegatecall, and says nothing was signed', () => {
    expect(() =>
      assertDelegateCallGateAllowsSigning(
        evaluateDelegateCallGate({
          operation: SafeOperationEnum.DelegateCall,
        })
      )
    ).toThrow(/will not be signed[\s\S]*Nothing has been signed/)
  })

  it('throws for an absent operation too', () => {
    expect(() =>
      assertDelegateCallGateAllowsSigning(evaluateDelegateCallGate({}))
    ).toThrow(/no operation field/)
  })
})
