/**
 * Where gate G, I, J and L's definite-red refusal sits inside
 * `confirm-safe-tx.ts`, not what it decides.
 *
 * The decision is driven in `definite-red-gate.test.ts`, the menu in
 * `signer-action-menu.test.ts` and the closing sentence in
 * `signer-outcome.test.ts`. `confirm-safe-tx.ts` calls `runMain` at module
 * scope and signs and broadcasts, so it is neither imported nor spawned here;
 * these assertions read the source, shaped so the ways the refusal could come
 * loose fail them: a verdict surviving into the next proposal, a funnel the
 * refusal does not cover, a refusal ahead of the more specific ones, and a menu
 * or banner reading something other than the one verdict.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

const SOURCE = readFileSync(join(import.meta.dir, 'confirm-safe-tx.ts'), 'utf8')

const REFUSAL = 'assertNoDefiniteRed('
const INTEGRITY_REFUSAL = 'assertIntegrityAssertsAllowSigning('

const indicesOf = (needle: string): number[] => {
  const found: number[] = []
  for (
    let at = SOURCE.indexOf(needle);
    at !== -1;
    at = SOURCE.indexOf(needle, at + 1)
  )
    found.push(at)
  return found
}

/** First index of `needle` at or after `from`, failing the test when absent. */
const after = (needle: string, from: number): number => {
  const at = SOURCE.indexOf(needle, from)
  expect(at).toBeGreaterThan(-1)
  return at
}

describe('the refusal covers both routes to the chain', () => {
  it('is called on exactly the two funnels, plus its import', () => {
    const calls = indicesOf(REFUSAL)
    expect(calls).toHaveLength(2)
    expect(SOURCE).toContain("from './definite-red-gate'")
  })

  it('sits inside the sign funnel, after the integrity refusal and before the signature', () => {
    const funnel = after('sign: async (safeTransaction, client = safe) => {', 0)
    const integrity = after(INTEGRITY_REFUSAL, funnel)
    const refusal = after(REFUSAL, funnel)
    const signs = after('client.signTransaction(', funnel)
    expect(refusal).toBeGreaterThan(integrity)
    expect(refusal).toBeLessThan(signs)
  })

  it('sits inside the execute funnel, after the integrity refusal and before the broadcast', () => {
    const funnel = after('async function executeTransaction(', 0)
    const integrity = after(INTEGRITY_REFUSAL, funnel)
    const refusal = after(REFUSAL, funnel)
    const broadcast = after('.executeTransaction(', funnel)
    expect(refusal).toBeGreaterThan(integrity)
    expect(refusal).toBeLessThan(broadcast)
  })

  it('keys every refusal on the transaction reaching it', () => {
    for (const at of indicesOf(REFUSAL))
      expect(SOURCE.slice(at, at + 80)).toContain(
        'assertNoDefiniteRed(definiteRed, proposalKeyOf(safeTransaction.data))'
      )
  })
})

describe('the verdict cannot survive into the next proposal', () => {
  it('resets to the refusing state beside the other per-proposal verdicts', () => {
    expect(SOURCE).toContain(
      'codehashGate = blockingUnevaluatedGate()\n    integrityRun = undefined\n    definiteRed = undefined'
    )
  })

  it('declares the verdict as possibly-absent, which is what makes absence refuse', () => {
    expect(SOURCE).toContain(
      'let definiteRed: IDefiniteRedVerdict | undefined\n'
    )
    expect(SOURCE).not.toContain('let definiteRed: IDefiniteRedVerdict =')
  })
})

describe('one verdict drives the menu, the banner and both funnels', () => {
  const evaluation = SOURCE.indexOf('evaluateDefiniteReds({')
  const evaluated = SOURCE.slice(evaluation, SOURCE.indexOf('})', evaluation))

  it('is taken from the evidence the rows are built from', () => {
    expect(evaluation).toBeGreaterThan(-1)
    expect(evaluated).toContain(
      'gradedKey: proposalKeyOf(tx.safeTransaction.data)'
    )
    expect(evaluated).toContain(
      'toSignedAuthorityEntries(installedAuthorities)'
    )
    expect(evaluated).toContain('executability,')
    expect(evaluated).toContain('rpcQuorum,')
    expect(evaluated).toContain('codehash: codehashGate,')
    // After this proposal's codehash verdict is adopted, not before: earlier it
    // would grade gate L on the blocking placeholder.
    expect(evaluation).toBeGreaterThan(
      SOURCE.indexOf('codehashGate = evidence.value.codehash')
    )
  })

  it('reaches the funnels, the menu, the banner and the summary before the prompt', () => {
    const prompt = SOURCE.indexOf("consola.prompt('Select action:'")
    const adopted = after('definiteRed = definiteRedVerdict', evaluation)
    const refused = after(
      'operationVerdict.refuses || definiteRedVerdict.reds.length > 0',
      evaluation
    )
    const banner = after('definiteReds: definiteRedVerdict.reds,', evaluation)
    const menu = after('refused: signingRefused,', evaluation)
    for (const at of [adopted, refused, banner, menu])
      expect(at).toBeLessThan(prompt)
    expect(SOURCE).toContain('blocked: signingRefused,')
  })

  it('leaves the target-state refusal where it was, after the prompt', () => {
    const prompt = SOURCE.indexOf("consola.prompt('Select action:'")
    expect(SOURCE.indexOf('if (!targetState.cleared) {')).toBeGreaterThan(
      prompt
    )
  })
})
