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
 * The order the checks run in, kept current so it can be used to place the
 * next one:
 *
 * 1. nonce status for the proposal
 * 2. per-proposal reset of the codehash gate and of the integrity run
 * 3. `formatDecodedTxDataForDisplay` — the calldata the gate then judges
 * 4. detail lines, parked-cleanup refs, provenance
 * 5. the target-state verdict — evaluated and displayed; its refusal is at 14
 * 6. the delegatecall gate
 * 7. the Ledger verification display (filmstrip or hash-compare)
 * 8. **the codehash gate** — evaluated and displayed here
 * 9. the integrity assertions — run and displayed
 * 10. the executability simulation, the RPC quorum read and the calldata
 *     address check — each evaluated and displayed
 * 11. `proposalCheckResults` — the ledger-bearing verdicts above, collected
 *     for the run ledger; the calldata address check is displayed only
 * 12. `evaluateProposalIntegrity`, the fingerprint and the two keys
 * 13. the pre-prompt `networkOutcomes.push`
 * 14. the action prompt, then `continue` on "Do Nothing"
 * 15. the nonce gate on execute actions, then `continue` on stale/unreachable
 * 16. the target-state refusal, then `continue` when it did not clear
 * 17. `recordAcknowledgement`
 * 18. the sign and execute branches
 *
 * Nothing in 1-7 returns or continues, so the gate at 8 swallows no existing
 * check; and the refusal itself goes first inside the signer, where nothing
 * precedes it at all. 10 and 11 are likewise straight-line: the gates there
 * report onto the ledger and refuse nothing themselves.
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
const SIGN_METHODS =
  'signTransaction|signTransactionWithHash|signHash|signTypedData|signMessage'

const CLIENT_SIGN_CALLS = new RegExp(`\\w+\\.(?:${SIGN_METHODS})\\(`, 'gu')

/**
 * The same methods reached by any spelling `CLIENT_SIGN_CALLS`/`EXECUTE_CALLS`
 * cannot see, because those require a bare `\w+` receiver immediately before
 * the dot: a cast or call receiver (`(x as SafeClient).signTransaction(`,
 * `foo().signHash(`), optional chaining (`x?.executeTransaction(`), computed
 * access in any quote style, and a reference detached from its receiver
 * (`const b = safeClient.executeTransaction` — later `b.call(...)`).
 *
 * A separate pattern rather than a widened `CLIENT_SIGN_CALLS`, so the
 * exhaustive assertion below keeps comparing against readable call text. Every
 * one of these compiles and survives prettier unchanged, and a cast is the
 * natural shape at the Safe/Tron seam — so an ungated route could be added in
 * one of the forms the check cannot see. Line-broken and spaced-out dots are
 * deliberately not covered: prettier collapses them before they can be
 * committed.
 */
const ANY_ROUTE = `${SIGN_METHODS}|executeTransaction`

const EXOTIC_RECEIVER_CALLS = new RegExp(
  // cast / call receiver, and optional chaining on any receiver
  `[)\\]]\\s*\\??\\.\\s*(?:${ANY_ROUTE})\\(` +
    `|\\w\\s*\\?\\.\\s*(?:${ANY_ROUTE})\\(` +
    // computed access, single/double/backtick
    `|\\[\\s*['"\`](?:${ANY_ROUTE})['"\`]\\s*\\]\\s*\\(` +
    // the method named but not called — a reference that can be invoked later
    `|\\.\\s*(?:${ANY_ROUTE})\\s*(?![(\\w])`,
  'gu'
)

/**
 * The one call that broadcasts. Execution needs no signature of ours, so it
 * cannot be covered by the sign funnel.
 *
 * Any identifier receiver, as `CLIENT_SIGN_CALLS` already does: bound to
 * `safeClient.` it could not see a later `safe.executeTransaction(` or
 * `deployerSafe.executeTransaction(` at all, so the assertion below stayed
 * green over exactly the ungated route it exists to catch. Both those receivers
 * are in scope in this file, so it was not a hypothetical. Receivers that are
 * not identifiers are covered by `EXOTIC_RECEIVER_CALLS`.
 */
const EXECUTE_CALLS = /\w+\.executeTransaction\(/g

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
    expect(matches(EXOTIC_RECEIVER_CALLS)).toEqual([])

    // Ends at the signer's own closing `})`, not at the next declaration and
    // not at that declaration's docstring. Prose meant rewording a comment
    // widened the window to the whole file; the next declaration still leaves
    // the gap between the two as somewhere a signing helper can sit, be reached
    // from an ungated branch, and still be counted as inside the funnel. Both
    // ends guarded.
    const bodyStart = SOURCE.indexOf('createGatedSigner<')
    expect(bodyStart).toBeGreaterThan(-1)
    const bodyEnd = SOURCE.indexOf('\n  })\n', bodyStart)
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    expect(SOURCE.slice(bodyStart, bodyEnd)).toContain(
      'client.signTransaction('
    )
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
    // Exactly one, whatever the receiver is called. A second broadcast site is
    // a second route, and the assert below only covers the funnel's.
    expect(executing).toEqual(['safeClient.executeTransaction('])

    // …and it lives inside the one local helper every execute branch calls.
    //
    // Bounded by the helper's own dedented closing brace rather than by a
    // character count: a fixed window silently stops covering the tail of the
    // function the first time anything is inserted near its top, and then
    // reports the broadcast as missing rather than as ungated. Both ends are
    // guarded, because an unfound delimiter widens the window to the rest of
    // the file instead of narrowing it, and the assertions then hold on text
    // outside the helper.
    const funnelStart = SOURCE.indexOf('async function executeTransaction(')
    expect(funnelStart).toBeGreaterThan(-1)
    const funnelEnd = SOURCE.indexOf('\n  }\n', funnelStart)
    expect(funnelEnd).toBeGreaterThan(funnelStart)
    const funnelBody = SOURCE.slice(funnelStart, funnelEnd)
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

  // Which transaction the gate judges is not asserted here. (The number of
  // *signing* call sites still is, above — that is a different guard, and a
  // source scan is all this file can do for it.) Six attempts, five of them defeated by a reviewer: a pin on
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
  // signed, so a pass on other calldata refuses. A second call site that
  // hand-builds the gate's input is caught by `tsc-files` on a changed
  // production file, which CI runs; one fed by `gateInputFor` compiles, and is
  // harmless for that reason — it grades the struct it was handed and its
  // verdict binds to that transaction. Nothing about this
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
