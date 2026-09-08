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

/**
 * The one call that broadcasts. Execution needs no signature of ours, so it
 * cannot be covered by the sign funnel.
 */
const EXECUTE_CALLS = /safeClient\.executeTransaction\(/g

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

  it('routes every execute path through one funnel that asserts the gate', () => {
    // A proposal already at threshold is broadcast by this operator without any
    // signature of theirs, so the sign funnel is never consulted — the gate was
    // on screen in red and nothing refused. That is D23's shape: WP-1.4 read
    // D9's "never in two places" as forbidding a second gate and left the
    // direct-broadcast route open. The ruling was two route-disjoint gates.
    const executing = matches(EXECUTE_CALLS)

    // Paired positive: the marker exists, or "no ungated execute" passes on a
    // file with no execute call in it.
    expect(executing.length).toBeGreaterThan(0)
    expect(executing).toEqual(['safeClient.executeTransaction('])

    // …and it lives inside the one local helper every execute branch calls.
    const funnelBody = SOURCE.slice(
      SOURCE.indexOf('async function executeTransaction('),
      SOURCE.indexOf('async function executeTransaction(') + 1600
    )
    expect(funnelBody).toContain('safeClient.executeTransaction(')
    expect(funnelBody).toContain('assertCodehashSignGateAllowsSigning')

    // The assert must precede the broadcast inside that helper.
    expect(
      funnelBody.indexOf('assertCodehashSignGateAllowsSigning')
    ).toBeLessThan(funnelBody.indexOf('safeClient.executeTransaction('))
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

  // Which bytes the gate judges is not asserted here, and neither is the number
  // of call sites. Six attempts, five of them defeated by a reviewer: a pin on
  // the call site's spelling (satisfied by a comment reciting it), the same pin
  // on comment-stripped text (satisfied by a string literal, and by a `'/*'`
  // inside a string that deleted the real call site), an interface naming the
  // right field (defeated cast-free — `safeTx` and `safeTransaction` are the
  // same type), a type-level brand (defeated by a spread, which keeps the brand
  // and swaps the bytes), and a runtime identity check on a value the selector
  // then discarded (defeated by mutating or spreading the detached bytes it
  // returned, and by grading one pending proposal while signing another).
  //
  // What holds now lives in codehash-sign-gate.test.ts, under `bun test`: the
  // input carries the struct by reference so the gate reads the calldata itself
  // at judge time, and the verdict is compared against the bytes actually being
  // signed, so a pass on other calldata refuses. A second call site is caught by
  // `tsc-files` on a changed production file, which CI runs. Nothing about this
  // is asserted by reading this file's own source, because four versions of that
  // idea were each defeated and each also failed a correct refactor.

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
