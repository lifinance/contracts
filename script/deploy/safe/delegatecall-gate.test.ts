/**
 * The operation gate: refuse a proposal that is not a plain `Call`, on the
 * operation field alone.
 *
 * Two properties matter more than the happy path. **A plain call is
 * unaffected** — every other case here is a refusal, so a guard that refused
 * everything would satisfy all of them while making the tool unusable. And
 * **the reason a signer reads has to be true of the value in front of them**,
 * because a refusal that describes `1n` as "neither Call nor DelegateCall"
 * reads as a broken gate, which is what sends an operator looking for a way
 * round it.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  assertProposalOperationPermitted,
  evaluateDelegateCallGate,
  renderDelegateCallGate,
} from './delegatecall-gate'
import { OperationTypeEnum } from './safe-utils'

describe('evaluateDelegateCallGate', () => {
  it('allows a plain call, so the gate is not "refuse everything"', () => {
    const verdict = evaluateDelegateCallGate({
      operation: OperationTypeEnum.Call,
    })

    expect(verdict.refuses).toBe(false)
    expect(verdict.reason).toBe('')
  })

  it('refuses a delegatecall', () => {
    const verdict = evaluateDelegateCallGate({
      operation: OperationTypeEnum.DelegateCall,
    })

    expect(verdict.refuses).toBe(true)
    expect(verdict.reason).toMatch(/delegatecall/i)
  })

  it('says why the decoded calldata is not the answer', () => {
    // The refusal has to override the intuition it exists to correct: a
    // delegatecall makes "the calldata looked harmless" irrelevant, so stating
    // the field value alone would not tell a signer anything they can act on.
    const verdict = evaluateDelegateCallGate({
      operation: OperationTypeEnum.DelegateCall,
    })

    expect(verdict.reason).toMatch(/own storage/)
    expect(verdict.reason).toMatch(/calldata/)
  })

  it('refuses anything that is not exactly Call', () => {
    // A floor, not a claim to catch a missing operation: the mandated source
    // normalises absence to Call before the struct exists, so `undefined`
    // arrives here only from a caller reading somewhere else.
    for (const operation of [undefined, 2, -1]) {
      const verdict = evaluateDelegateCallGate({ operation })
      expect(verdict.refuses).toBe(true)
    }

    expect(evaluateDelegateCallGate(null).refuses).toBe(true)
    expect(evaluateDelegateCallGate(undefined).refuses).toBe(true)
  })

  it('refuses a Call of the wrong type, because the type is not the value', () => {
    // The field is cast, not validated, so these can reach it. `== 0` would
    // accept both.
    for (const operation of ['0', BigInt(0)] as unknown as number[])
      expect(evaluateDelegateCallGate({ operation }).refuses).toBe(true)
  })

  it('never tells a signer a delegatecall-shaped value is not one', () => {
    // `1n` and `'1'` fail the identity test and land in the catch-all branch.
    // Describing them as "neither Call (0) nor DelegateCall (1)" would be a
    // sentence contradicted by the value printed in the same breath.
    for (const operation of ['1', BigInt(1)] as unknown as number[]) {
      const { refuses, reason } = evaluateDelegateCallGate({ operation })

      expect(refuses).toBe(true)
      expect(reason).not.toMatch(/neither/)
      // The type is what makes it refusable, so the type is what it names.
      expect(reason).toMatch(/\(string\)|\(bigint\)/)
    }
  })
})

describe('renderDelegateCallGate', () => {
  it('says nothing for a plain call, so the line is never noise', () => {
    expect(
      renderDelegateCallGate(
        evaluateDelegateCallGate({ operation: OperationTypeEnum.Call })
      )
    ).toEqual([])
  })

  it('colours the whole refusal, not just the badge', () => {
    // The first version closed the reset immediately after "REFUSED", so the
    // sentence a signer actually has to read rendered in the default colour
    // while the assertion — a `toContain` for the escape code — still passed on
    // the badge alone. Assert the reset comes last instead.
    const [line = ''] = renderDelegateCallGate(
      evaluateDelegateCallGate({ operation: OperationTypeEnum.DelegateCall })
    )
    const reset = `${String.fromCharCode(27)}[0m`

    expect(line).toContain('REFUSED')
    expect(line).toMatch(/own storage/)
    expect(line.startsWith(`${String.fromCharCode(27)}[31m`)).toBe(true)
    expect(line.endsWith(reset)).toBe(true)
    // Nothing resets in the middle, which is the only way the reason could be
    // left uncoloured while the badge is red.
    expect(line.slice(0, -reset.length)).not.toContain(reset)
  })
})

describe('assertProposalOperationPermitted', () => {
  it('returns quietly for a plain call', () => {
    expect(() =>
      assertProposalOperationPermitted(
        evaluateDelegateCallGate({ operation: OperationTypeEnum.Call })
      )
    ).not.toThrow()
  })

  it('throws for a delegatecall, and names both irreversible routes', () => {
    // "will not proceed" and "signed or executed", not "will not be signed":
    // execution needs no signature of ours, and a message about signing invites
    // wiring this into the sign funnel alone.
    expect(() =>
      assertProposalOperationPermitted(
        evaluateDelegateCallGate({
          operation: OperationTypeEnum.DelegateCall,
        })
      )
    ).toThrow(/will not proceed[\s\S]*Nothing has been signed or executed/)
  })

  it('throws for a value that is not exactly Call', () => {
    expect(() =>
      assertProposalOperationPermitted(evaluateDelegateCallGate({}))
    ).toThrow(/only the number 0/)
  })
})
