/**
 * Where gate G, I, J and L's definite-red refusal sits inside
 * `confirm-safe-tx.ts` and `signing-funnels.ts`, not what it decides.
 *
 * The decision is driven in `definite-red-gate.test.ts`, the funnels and the
 * action dispatch in `definite-red-funnels.test.ts`, the menu in
 * `signer-action-menu.test.ts` and the closing sentence in
 * `signer-outcome.test.ts`. `confirm-safe-tx.ts` calls `runMain` at module
 * scope and signs and broadcasts, so it is neither imported nor spawned here;
 * these assertions read the source, shaped so the ways the refusal could come
 * loose fail them: a verdict surviving into the next proposal, a route to the
 * chain that bypasses the funnels, a refusal ahead of the more specific ones,
 * and a menu or banner reading something other than the one verdict.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

const SOURCE = readFileSync(join(import.meta.dir, 'confirm-safe-tx.ts'), 'utf8')
const FUNNELS = readFileSync(
  join(import.meta.dir, 'signing-funnels.ts'),
  'utf8'
)

const REFUSAL = 'assertNoDefiniteRed('
const INTEGRITY_REFUSAL = 'assertIntegrityAssertsAllowSigning('

const indicesOf = (needle: string, text = SOURCE): number[] => {
  const found: number[] = []
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  )
    found.push(at)
  return found
}

/** First index of `needle` at or after `from`, failing the test when absent. */
const after = (needle: string, from: number, text = SOURCE): number => {
  const at = text.indexOf(needle, from)
  expect(at).toBeGreaterThan(-1)
  return at
}

describe('the refusal covers both routes to the chain', () => {
  it('is called on exactly the two funnels, plus its import', () => {
    expect(indicesOf(REFUSAL, FUNNELS)).toHaveLength(2)
    expect(FUNNELS).toContain("from './definite-red-gate'")
    expect(indicesOf(REFUSAL)).toHaveLength(0)
  })

  it('sits inside the sign funnel, after the integrity refusal and before the signature', () => {
    const funnel = after(
      'sign: async (safeTransaction, client = safe) => {',
      0,
      FUNNELS
    )
    const integrity = after(INTEGRITY_REFUSAL, funnel, FUNNELS)
    const refusal = after(REFUSAL, funnel, FUNNELS)
    const signs = after('client.signTransaction(', funnel, FUNNELS)
    expect(refusal).toBeGreaterThan(integrity)
    expect(refusal).toBeLessThan(signs)
  })

  it('sits inside the execute funnel, after the integrity refusal and before the broadcast', () => {
    const funnel = after('const executeTransaction = async (', 0, FUNNELS)
    const integrity = after(INTEGRITY_REFUSAL, funnel, FUNNELS)
    const refusal = after(REFUSAL, funnel, FUNNELS)
    const broadcast = after('deps.broadcast(', funnel, FUNNELS)
    expect(refusal).toBeGreaterThan(integrity)
    expect(refusal).toBeLessThan(broadcast)
  })

  it('keys every refusal on the transaction reaching it', () => {
    for (const at of indicesOf(REFUSAL, FUNNELS))
      expect(FUNNELS.slice(at, at + 80)).toContain(
        'assertNoDefiniteRed(definiteRed, proposalKeyOf(safeTransaction.data))'
      )
  })

  it('reaches the chain from confirm-safe-tx only through the factory', () => {
    // The broadcast body is unguarded on its own; it is safe only while the
    // factory's execute funnel is its one caller.
    expect(indicesOf('broadcastSafeTransaction')).toHaveLength(2)
    expect(SOURCE).toContain('broadcast: broadcastSafeTransaction,')
    expect(SOURCE).toContain(
      'verdicts: () => ({ codehashGate, integrityRun, definiteRed }),'
    )
    expect(indicesOf('await runAction(action, tx)')).toHaveLength(1)
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
