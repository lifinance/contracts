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
    // `1n` and `'1'` fail the identity test and land in the catch-all branch,
    // whose text must stay true of the value printed inside it.
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

  it('carries exactly one colour and one reset, at the ends', () => {
    // Counting escape sequences rather than hunting for a stray reset. The
    // earlier form asserted "starts red, ends reset, no reset in between",
    // which a value carrying a raw colour *switch* satisfies while visibly
    // recolouring the sentence mid-line — and which a legitimate reason
    // containing an escape would have failed. Two escapes, at the two ends, is
    // the property actually wanted.
    const [line = ''] = renderDelegateCallGate(
      evaluateDelegateCallGate({ operation: OperationTypeEnum.DelegateCall })
    )
    const esc = String.fromCharCode(27)

    expect(line).toContain('REFUSED')
    expect(line).toMatch(/own storage/)
    expect(line.split(esc).length - 1).toBe(2)
    expect(line.startsWith(`${esc}[31m`)).toBe(true)
    expect(line.endsWith(`${esc}[0m`)).toBe(true)
  })

  it('strips escape codes out of a proposer-supplied value', () => {
    // `operation` reaches the struct through a cast, so a row can carry a
    // string — and interpolating one raw let a proposal paint ANSI into the
    // signer's terminal, recolouring the refusal printed about it. The value is
    // sanitised, so the rendered line still carries exactly its own two codes.
    const injected = `${String.fromCharCode(27)}[33mYELLOW`
    const [line = ''] = renderDelegateCallGate(
      evaluateDelegateCallGate({
        operation: injected as unknown as number,
      })
    )
    const esc = String.fromCharCode(27)

    expect(line.split(esc).length - 1).toBe(2)
    expect(line).not.toContain(`${esc}[33m`)
    // Paired presence: the value is still described, not silently dropped —
    // stripping it entirely would hide what was refused.
    expect(line).toContain('YELLOW')
    expect(line).toContain('(string)')
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
