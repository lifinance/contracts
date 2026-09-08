/**
 * Where the operation refusal sits, not what it decides.
 * `delegatecall-gate.test.ts` covers the decision; `safe-utils.test.ts`
 * proves the signing client and the chain executor are never reached.
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
const EXECUTE_METHOD = CLIENT.slice(
  CLIENT.indexOf('public async executeTransaction('),
  CLIENT.indexOf('public async cleanup()')
)

describe('the operation refusal sits in the client every sign and execute path uses', () => {
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

  it('does not offer a sign or execute action once the gate has refused', () => {
    expect(CONFIRM).toContain('if (!operationVerdict.refuses)')
    expect(CONFIRM).toMatch(
      /if \(!operationVerdict\.refuses\) \{[\s\S]*options\.push\('Sign'\)/
    )
  })
})
