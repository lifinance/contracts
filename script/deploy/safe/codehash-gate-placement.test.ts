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

/**
 * Source with every string literal and comment removed.
 *
 * Strings go first, and that ordering is the point: a reviewer defeated an
 * earlier version by putting `'/*'` in a string above the call and `'*\/'`
 * below it, so the comment stripper ate the real call site and anchored on a
 * decoy. Stripping literals first means neither a fake comment marker nor a
 * string reciting the right spelling survives to be matched. It can only
 * remove text, never invent it, so every assertion below fails safe.
 */
const executableOnly = (text: string): string =>
  text
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "''")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

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

  it('delegates the choice of bytes to the type-policed selector', () => {
    // Which bytes the gate judges is no longer asserted on this file's text.
    // Three source-scanning attempts were all defeated — by a comment reciting
    // the correct spelling, by a string literal doing the same, and by an alias
    // (`const signed = tx.safeTransaction.data`) that read the right field and
    // failed the test anyway. A pin on spelling cannot tell those apart.
    //
    // `gateInputFor` takes `ISignableProposal`, which names `safeTransaction`
    // and nothing else, so handing over the stored `safeTx` document does not
    // compile. The behaviour is driven for real in codehash-sign-gate.test.ts.
    // What is left here is placement: this file must not build that input
    // itself.
    // No negative on the stored document's spelling: `tx.safeTx.data.data` is
    // read legitimately elsewhere in this file, by the Ledger filmstrip. What
    // matters is that the gate's input is not built here at all.
    expect(executableOnly(SOURCE)).toContain('gateInputFor(tx, networkKey)')
  })

  it('has exactly one gate call site, so nothing bypasses that selector', () => {
    // A second call site is D23's shape again: a route the assertions above
    // never look at. Counted on executable text only, for the reason
    // `executableOnly` documents.
    const bare = executableOnly(SOURCE)
    expect(bare.split('evaluateCodehashSignGate(').length - 1).toBe(1)
    expect(bare.split('gateInputFor(').length - 1).toBe(1)
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
