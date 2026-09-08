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
  describeOperationValue,
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
      expect(reason).toMatch(/\(string, 1 char\)|\(bigint\)/)
    }
  })

  it('keeps two values distinguishable that sanitise to the same text', () => {
    // Sanitising is lossy: a zero-width space is stripped, so `0\u200b1` and
    // `01` print identically. Without the length a signer reading the refusal
    // cannot tell which malformed row produced it.
    const plain = evaluateDelegateCallGate({
      operation: '01' as unknown as number,
    }).reason
    const zeroWidth = evaluateDelegateCallGate({
      operation: '0\u200b1' as unknown as number,
    }).reason

    expect(plain).toContain('01 (string, 2 chars)')
    expect(zeroWidth).toContain('01 (string, 3 chars)')
    expect(plain).not.toBe(zeroWidth)
  })

  it('says a value rendered to nothing, not that it could not be rendered', () => {
    // A row made entirely of stripped characters did render — to nothing.
    // Calling that "unrenderable" describes a different failure, the one where
    // `String()` itself throws.
    const allStripped = evaluateDelegateCallGate({
      operation: `${String.fromCharCode(27)}${String.fromCharCode(
        7
      )}` as unknown as number,
    }).reason

    expect(allStripped).toContain('no printable characters')
    expect(allStripped).not.toContain('unrenderable')
  })

  it('still says unrenderable when the value cannot be stringified', () => {
    // The paired case, so the two labels cannot collapse into one.
    const noToString = Object.create(null) as unknown as number
    const reason = evaluateDelegateCallGate({ operation: noToString }).reason

    expect(reason).toContain('unrenderable')
    expect(reason).not.toContain('no printable characters')
  })

  it('clips on a code-point boundary, never mid-surrogate', () => {
    // `slice(0, n)` is index-based, so a pair straddling the boundary is cut in
    // half and a lone surrogate reaches the terminal — the same garbled output
    // the sanitising exists to prevent, arriving by a different route.
    const straddling = `${'A'.repeat(79)}\u{1F600}${'B'.repeat(20)}`
    const reason = evaluateDelegateCallGate({
      operation: straddling as unknown as number,
    }).reason

    // No unpaired surrogate anywhere in what a signer would see.
    expect(reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(reason).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    // Paired presence: it did clip, so the assertion is not passing on an
    // unclipped string.
    expect(reason).toContain('…')
  })

  it('reports null as null, not as characters that were stripped', () => {
    const reason = evaluateDelegateCallGate({
      operation: null as unknown as number,
    }).reason

    expect(reason).toContain('null')
    expect(reason).not.toContain('no printable characters')
  })

  it('bounds a long value instead of flooding the terminal', () => {
    const long = 'A'.repeat(500)
    const reason = evaluateDelegateCallGate({
      operation: long as unknown as number,
    }).reason

    expect(reason).toContain('…')
    expect(reason).not.toContain('A'.repeat(200))
    // The type and true length survive the clip — otherwise bounding the value
    // would also hide what it was.
    expect(reason).toContain('(string, 500 chars)')
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
    // Exactly two escapes, one at each end. The reason is sanitised, so it
    // cannot contribute a third.
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
    expect(line).toMatch(/\(string, \d+ chars\)/)
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

describe('describeOperationValue', () => {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)

  // The detail block in `confirm-safe-tx.ts` prints this value inside its own
  // colour codes, so anything the value carries lands in the signer's terminal
  // as a live sequence rather than as text.
  it('strips a CSI colour sequence instead of emitting it', () => {
    const rendered = describeOperationValue(
      `${ESC}[31mDelegateCall${ESC}[0m` as unknown as number
    )

    expect(rendered).not.toContain(ESC)
    expect(rendered).toContain('[31mDelegateCall[0m')
  })

  it('strips an OSC sequence, terminator included', () => {
    // OSC 8 is a hyperlink: left raw, a refused operation renders as a link to
    // wherever the proposer chose.
    const rendered = describeOperationValue(
      `${ESC}]8;;https://example.invalid${BEL}Call${ESC}]8;;${BEL}` as unknown as number
    )

    expect(rendered).not.toContain(ESC)
    expect(rendered).not.toContain(BEL)
  })

  it('leaves no control character in any rendering', () => {
    // The point of the assertion is that these characters do not survive, so
    // the rule barring them from a pattern is what has to give way here.
    // eslint-disable-next-line no-control-regex
    const anyControlCharacter = /[\u0000-\u001f\u007f]/u

    for (const value of [
      `${ESC}[2J` as unknown as number,
      `\r\nOperation: Call` as unknown as number,
      `${String.fromCharCode(8)}${String.fromCharCode(
        8
      )}Call` as unknown as number,
    ])
      expect(describeOperationValue(value)).not.toMatch(anyControlCharacter)
  })
})
