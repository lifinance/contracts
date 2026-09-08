/**
 * Where the operation refusal sits, and that the printed field goes through
 * the sanitiser — not what the gate decides or how it renders.
 * `delegatecall-gate.test.ts` covers the decision and the sanitising;
 * `safe-utils.test.ts` proves the signing client and the chain executor are
 * never reached.
 *
 * `confirm-safe-tx.ts` and `SafeClient` cannot be imported as the CLI
 * (`runMain` at module scope). Placement is asserted on the source, shaped
 * so a second ungated call site fails the suite.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const CONFIRM = readFileSync(
  join(import.meta.dir, 'confirm-safe-tx.ts'),
  'utf8'
)
const CLIENT = readFileSync(join(import.meta.dir, 'safe-utils.ts'), 'utf8')

const SIGN_METHOD = CLIENT.slice(
  CLIENT.indexOf('public async signTransaction('),
  CLIENT.indexOf('private validateSignature(')
)
const HASH_SIGN_METHOD = CLIENT.slice(
  CLIENT.indexOf('public async signTransactionWithHash('),
  CLIENT.indexOf('public async signTransaction(')
)
const EXECUTE_METHOD = CLIENT.slice(
  CLIENT.indexOf('public async executeTransaction('),
  CLIENT.indexOf('public async cleanup()')
)

describe('the operation refusal sits on every operation-bearing route of the client', () => {
  it('asserts the gate before either signing path', () => {
    expect(SIGN_METHOD).toContain('assertProposalOperationPermitted')
    expect(SIGN_METHOD).toContain('evaluateDelegateCallGate(safeTx.data)')
    expect(
      SIGN_METHOD.indexOf('assertProposalOperationPermitted')
    ).toBeLessThan(SIGN_METHOD.indexOf('signTransactionWithHash'))
    expect(
      SIGN_METHOD.indexOf('assertProposalOperationPermitted')
    ).toBeLessThan(SIGN_METHOD.indexOf('signTypedData'))
  })

  it('asserts the gate on the public hash route reached directly', () => {
    // `signTransaction` delegates here, but the method is public, so a caller
    // that skips the funnel must not skip the gate with it.
    expect(HASH_SIGN_METHOD).toContain('assertProposalOperationPermitted')
    expect(HASH_SIGN_METHOD).toContain('evaluateDelegateCallGate(safeTx.data)')
    expect(
      HASH_SIGN_METHOD.indexOf('assertProposalOperationPermitted')
    ).toBeLessThan(HASH_SIGN_METHOD.indexOf('getTransactionHash'))
  })

  it('asserts the gate before the chain executor broadcasts', () => {
    expect(EXECUTE_METHOD).toContain('assertProposalOperationPermitted')
    expect(EXECUTE_METHOD).toContain('evaluateDelegateCallGate(safeTx.data)')
    expect(
      EXECUTE_METHOD.indexOf('assertProposalOperationPermitted')
    ).toBeLessThan(EXECUTE_METHOD.indexOf('chainExecutor.executeTransaction'))
  })

  it('shows the refusal on the signed struct before the action prompt', () => {
    expect(CONFIRM).toContain(
      'evaluateDelegateCallGate(tx.safeTransaction.data)'
    )
    expect(CONFIRM).toContain('renderDelegateCallGate(operationVerdict)')

    const prompt = CONFIRM.indexOf("consola.prompt('Select action:'")
    const evaluation = CONFIRM.indexOf(
      'evaluateDelegateCallGate(tx.safeTransaction.data)'
    )
    expect(evaluation).toBeGreaterThan(-1)
    expect(evaluation).toBeLessThan(prompt)
  })

  it('renders the refused operation through the sanitiser, never raw', () => {
    // Whitespace-insensitive: the call spans lines, and how prettier wraps it
    // is not what this asserts.
    const packed = CONFIRM.replace(/\s+/gu, '')

    expect(packed).toContain(
      'describeOperationValue(tx.safeTransaction.data.operation)'
    )

    // Counted rather than matched against one spelling: barring only
    // `String(...)` would pass on the more natural way the bug comes back,
    // interpolating the field directly. Every read of it must be a comparison
    // against a literal or the sanitiser call.
    const reads = packed.match(/tx\.safeTransaction\.data\.operation/gu) ?? []
    const permitted = packed.match(
      /tx\.safeTransaction\.data\.operation===\d|describeOperationValue\(tx\.safeTransaction\.data\.operation\)/gu
    )
    expect(reads.length).toBeGreaterThan(0)
    expect(permitted?.length).toBe(reads.length)
  })

  it('does not offer a sign or execute action once the gate has refused', () => {
    expect(CONFIRM).toContain('if (!operationVerdict.refuses)')
    expect(CONFIRM).toMatch(
      /if \(!operationVerdict\.refuses\) \{[\s\S]*options\.push\('Sign'\)/
    )
  })
})
