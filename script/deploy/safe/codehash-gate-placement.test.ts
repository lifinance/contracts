/**
 * Where the codehash refusal sits inside `confirm-safe-tx.ts`, not what it
 * decides.
 *
 * The decision is driven for real in `codehash-sign-gate.test.ts`, against a
 * spy, in both directions. What cannot be driven here is the script itself:
 * `confirm-safe-tx.ts` calls `runMain` at module scope, so importing it runs the
 * CLI, and reaching its signer needs MongoDB, a Safe and a Ledger. So the
 * placement is asserted on the source, and the assertions are shaped so the
 * obvious way to reintroduce the bug fails them: a second signing call site
 * anywhere in the file, or a funnel that no longer wraps the gate.
 *
 * The order the checks run in, at the point the gate was inserted, written down
 * before inserting it:
 *
 * 1. nonce status for the proposal
 * 2. `formatDecodedTxDataForDisplay` — the calldata the gate then judges
 * 3. detail lines, parked-cleanup refs, provenance
 * 4. the Ledger verification display (filmstrip or hash-compare)
 * 5. **the codehash gate** — evaluated and displayed here
 * 6. `evaluateProposalIntegrity`, the fingerprint and the two keys
 * 7. the pre-prompt `networkOutcomes.push`
 * 8. the action prompt, then `continue` on "Do Nothing"
 * 9. the nonce gate on execute actions, then `continue` on stale/unreachable
 * 10. the acknowledgement prompt, then `continue` on "No"
 * 11. `recordAcknowledgement`
 * 12. the sign and execute branches
 *
 * Nothing in 1-4 returns or continues, so inserting at 5 swallows no existing
 * check; and the refusal itself goes first inside the signer, where nothing
 * precedes it at all.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const SOURCE = readFileSync(join(import.meta.dir, 'confirm-safe-tx.ts'), 'utf8')

/**
 * Every spelling of "produce a signature" the Safe client and Ledger seam
 * expose. Narrowing this to `signTransaction` would let a future
 * `safe.signTransactionWithHash(tx)` satisfy the assertion below.
 */
const CLIENT_SIGN_CALLS =
  /\w+\.(?:signTransaction|signTransactionWithHash|signHash|signTypedData|signMessage)\(/g

/** Calls to the funnel itself, which is a bare identifier. */
const FUNNEL_CALLS = /(?<![.\w])signTransaction\(/g

const matches = (pattern: RegExp): string[] =>
  [...SOURCE.matchAll(pattern)].map((match) => match[0])

describe('the codehash refusal is in the one funnel every sign path uses', () => {
  it('builds the signer with createGatedSigner', () => {
    expect(SOURCE).toContain('createGatedSigner<')
    expect(SOURCE).toContain('gate: () => codehashGate')
  })

  it('has exactly one call that signs, and it is the funnel body', () => {
    const signing = matches(CLIENT_SIGN_CALLS)

    // The paired positive: the marker exists at all. An assertion that "no
    // ungated call is present" passes trivially against a file with no signing
    // call in it.
    expect(signing.length).toBeGreaterThan(0)
    expect(signing).toEqual(['client.signTransaction('])

    const funnelBody = SOURCE.slice(
      SOURCE.indexOf('createGatedSigner<'),
      SOURCE.indexOf('  /**\n   * Persists a signed Safe tx')
    )
    expect(funnelBody).toContain('client.signTransaction(')
  })

  it('routes every sign path through the funnel, including the deployer step', () => {
    // Four call sites: Sign, Sign & Execute, and both steps of Sign and Execute
    // With Deployer. The deployer's own signature used to call the Safe client
    // directly, which is a fourth sign path the gate would not have covered.
    expect(matches(FUNNEL_CALLS).length).toBeGreaterThanOrEqual(4)
    expect(SOURCE).toContain('await signTransaction(signedTx, deployerSafe)')
  })

  it('starts each proposal in the blocking state rather than the last verdict', () => {
    const loopHeader = SOURCE.indexOf('for (const tx of initialTxs')
    const reset = SOURCE.indexOf('codehashGate = blockingUnevaluatedGate()')
    const evaluation = SOURCE.indexOf('await evaluateCodehashSignGate(')

    expect(loopHeader).toBeGreaterThan(-1)
    // Inside the per-proposal loop, not hoisted above it: hoisted, the reset
    // runs once and the second proposal is judged on the first one's verdict,
    // while an assertion that only ordered reset before evaluation would still
    // pass.
    expect(reset).toBeGreaterThan(loopHeader)
    expect(evaluation).toBeGreaterThan(reset)
  })

  it('judges the same variable the display path was given', () => {
    expect(SOURCE).toContain(
      'await formatDecodedTxDataForDisplay(tx.safeTx.data.data as Hex'
    )
    expect(SOURCE).toContain(
      '{ data: tx.safeTx.data.data as Hex | undefined, network }'
    )
  })

  it('evaluates and displays the verdict before the action prompt', () => {
    const evaluation = SOURCE.indexOf('await evaluateCodehashSignGate(')
    const display = SOURCE.indexOf('renderCodehashSignGate(codehashGate)')
    const prompt = SOURCE.indexOf("await consola.prompt('Select action:'")

    expect(evaluation).toBeGreaterThan(-1)
    expect(display).toBeGreaterThan(evaluation)
    expect(prompt).toBeGreaterThan(display)
  })

  it('keeps Sign on offer, so a refusal states its reason', () => {
    // Decision 1: the option list is unchanged and the refusal happens after
    // the choice, the same convention the nonce gate follows.
    expect(SOURCE).toContain("options.push('Sign')")
  })

  it('releases the gate dependencies when the run ends', () => {
    expect(SOURCE).toContain('await deps.close().catch(() => undefined)')
  })
})
