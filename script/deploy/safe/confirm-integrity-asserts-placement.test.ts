/**
 * Where the integrity refusal sits inside `confirm-safe-tx.ts`, not what it
 * decides.
 *
 * The decision is driven for real in `confirm-integrity-asserts.test.ts`, in
 * both directions, against injected lookups. What cannot be driven here is the
 * script: `confirm-safe-tx.ts` calls `runMain` at module scope so importing it
 * runs the CLI, and it signs and broadcasts, so it must never be spawned from a
 * test either. **No assertion in this file executes the refusal.** They read the
 * source, and are shaped so the obvious ways to reintroduce the bug fail them:
 * a run reused across proposals, a refusal placed ahead of the codehash one, or
 * a sign/execute route the refusal does not cover.
 *
 * The order the checks run in, at the point this was inserted, written down
 * before inserting it:
 *
 * 1. nonce status for the proposal
 * 2. per-proposal reset of the codehash gate and of the integrity run
 * 3. `formatDecodedTxDataForDisplay` — the calldata the checks then judge
 * 4. detail lines, parked-cleanup refs, provenance
 * 5. the delegatecall gate
 * 6. the Ledger verification display (filmstrip or hash-compare)
 * 7. the codehash gate — evaluated and displayed
 * 8. **the integrity assertions** — run and displayed here
 * 9. `evaluateProposalIntegrity`, the fingerprint and the two keys
 * 10. the pre-prompt `networkOutcomes.push`
 * 11. the action prompt, then `continue` on "Do Nothing"
 * 12. the nonce gate on execute actions, then `continue` on stale/unreachable
 * 13. the acknowledgement prompt, then `continue` on "No"
 * 14. `recordAcknowledgement`
 * 15. the sign and execute branches
 *
 * Nothing in 1-7 returns or continues, so inserting at 8 swallows no existing
 * check, and 11-14 keep their order relative to each other — the acknowledgement
 * prompt still sits after the action prompt and the nonce gate, where it was.
 * The refusal itself goes inside both funnels, immediately after the codehash
 * refusal: ahead of it, this one would swallow the more specific answer.
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

const PREFETCH = readFileSync(
  join(import.meta.dir, 'confirm-safe-tx-prefetch.ts'),
  'utf8'
)

const REFUSAL = 'assertIntegrityAssertsAllowSigning('
const CODEHASH_REFUSAL = 'assertCodehashSignGateAllowsSigning('

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

describe('the integrity refusal covers both routes to the chain', () => {
  it('is called on exactly the two funnels, plus its import', () => {
    // Paired positive: the marker exists at all, or every "no ungated route"
    // assertion below passes against a file that never calls the refusal.
    const calls = indicesOf(REFUSAL)
    expect(calls.length).toBeGreaterThan(0)
    // Two call sites. A third would be a third route, and the two funnels
    // already cover every sign and execute branch by construction.
    expect(calls).toHaveLength(2)
    expect(SOURCE).toContain("from './confirm-integrity-asserts'")
  })

  it('sits inside the sign funnel, after the codehash refusal', () => {
    const funnelStart = SOURCE.indexOf(
      'sign: async (safeTransaction, client = safe) => {'
    )
    expect(funnelStart).toBeGreaterThan(-1)
    const funnelBody = SOURCE.slice(
      funnelStart,
      SOURCE.indexOf('client.signTransaction(')
    )
    expect(funnelBody).toContain(REFUSAL)

    // The codehash refusal for this route lives in `createGatedSigner`, which
    // runs before `sign` is entered at all — so being anywhere in this body is
    // already after it. Pinned so a future inlining of that wrapper into this
    // body cannot silently put ours first.
    expect(SOURCE).toContain('createGatedSigner<')
    expect(SOURCE).toContain('gate: () => codehashGate')
  })

  it('sits inside the execute funnel, after the codehash refusal and before the broadcast', () => {
    const funnelStart = SOURCE.indexOf('async function executeTransaction(')
    expect(funnelStart).toBeGreaterThan(-1)
    const broadcast = SOURCE.indexOf('.executeTransaction(', funnelStart)
    expect(broadcast).toBeGreaterThan(funnelStart)

    const codehashAt = SOURCE.indexOf(CODEHASH_REFUSAL, funnelStart)
    const integrityAt = SOURCE.indexOf(REFUSAL, funnelStart)
    expect(codehashAt).toBeGreaterThan(funnelStart)
    expect(integrityAt).toBeGreaterThan(codehashAt)
    expect(integrityAt).toBeLessThan(broadcast)
  })

  it('keys every refusal on the transaction reaching it, not on the run alone', () => {
    // A verdict is a statement about one transaction. Both call sites pass the
    // key of the struct in hand, so a run left over from the previous proposal
    // cannot authorise this one.
    for (const at of indicesOf(REFUSAL)) {
      const call = SOURCE.slice(at, at + 200)
      expect(call).toContain('integrityRun')
      expect(call).toContain('proposalKeyOf(safeTransaction.data)')
    }
  })
})

describe('the run cannot survive into the next proposal', () => {
  it('resets to the blocking state at the top of each proposal', () => {
    const reset = SOURCE.indexOf('integrityRun = undefined')
    expect(reset).toBeGreaterThan(-1)
    // Alongside the codehash gate's own reset, so the two cannot drift apart.
    expect(SOURCE).toContain(
      'codehashGate = blockingUnevaluatedGate()\n    integrityRun = undefined'
    )
  })

  it('declares the run as possibly-absent, which is what makes absence block', () => {
    expect(SOURCE).toContain(
      'let integrityRun: IIntegrityAssertRun | undefined'
    )
    // No initialiser: a declaration that started from a passing value would
    // make the reset the only thing standing between a proposal and a green
    // verdict it never earned.
    expect(SOURCE).not.toContain('let integrityRun: IIntegrityAssertRun =')
  })

  it('leaves the run absent when the assertions throw', () => {
    const evaluation = SOURCE.indexOf(
      'integrityRun = await runIntegrityAsserts('
    )
    expect(evaluation).toBeGreaterThan(-1)

    // Bounded by the catch's own delimiters rather than by a character count:
    // a fixed window stops covering the block the first time a comment is
    // added above it, and then reports the reset as missing rather than as
    // misplaced. It also has to be the *handler*, not the whole try — the
    // assignment inside the try is what this exists to distinguish from.
    const opens = SOURCE.indexOf('} catch (error) {', evaluation)
    expect(opens).toBeGreaterThan(evaluation)
    const handler = SOURCE.slice(opens, SOURCE.indexOf('\n    }\n', opens))
    expect(handler).toContain('integrityRun = undefined')
  })
})

describe('the evaluation is placed where it swallows nothing', () => {
  it('runs after the codehash gate is rendered and before the acknowledgement keys', () => {
    const codehashRender = SOURCE.indexOf(
      'renderCodehashSignGate(codehashGate)'
    )
    const evaluation = SOURCE.indexOf(
      'integrityRun = await runIntegrityAsserts('
    )
    const ackKeys = SOURCE.indexOf(
      'const acknowledgementKey = buildAcknowledgementKey({'
    )
    expect(codehashRender).toBeGreaterThan(-1)
    expect(evaluation).toBeGreaterThan(codehashRender)
    expect(ackKeys).toBeGreaterThan(evaluation)
  })

  // The last leg is anchored on the ledger write rather than the prompt that
  // precedes it, so the ordering holds whether acknowledgement is prompted for
  // or implicit in the action choice.
  it('leaves the action prompt, the nonce gate and the acknowledgement in that order', () => {
    const evaluation = SOURCE.indexOf(
      'integrityRun = await runIntegrityAsserts('
    )
    const actionPrompt = SOURCE.indexOf(
      "action = await consola.prompt('Select action:'",
      evaluation
    )
    const nonceGate = SOURCE.indexOf(
      'canExecuteWithNonceStatus(nonceStatus',
      evaluation
    )
    const ackRecorded = SOURCE.indexOf(
      'recordAcknowledgement(acknowledgementLedger, {',
      evaluation
    )
    expect(actionPrompt).toBeGreaterThan(evaluation)
    expect(nonceGate).toBeGreaterThan(actionPrompt)
    expect(ackRecorded).toBeGreaterThan(nonceGate)
  })

  it('prints the verdict before any prompt offers to sign', () => {
    const render = SOURCE.indexOf('renderIntegrityAsserts(integrityRun)')
    const firstPrompt = SOURCE.indexOf("consola.prompt('Select action:'")
    expect(render).toBeGreaterThan(-1)
    expect(render).toBeLessThan(firstPrompt)
  })

  it('points the signing client at the configured Safe, not at the document', () => {
    // WP-3.1 asks for both halves: the comparison, and the client actually
    // being re-pointed. Every read the assertions rest on — the hash recompute,
    // the owner set — goes through that client, so one pointed at the address
    // the proposer wrote answers for whatever Safe they chose, and comparing
    // config against the document then proves nothing.
    //
    // Source-asserted, and this is the one placement here that carries no
    // executed assertion: `prepareConfirmSafeTxNetwork` builds a real Safe
    // client and reads Mongo, and `confirm-safe-tx.ts` may never be spawned.
    expect(PREFETCH).toContain(
      'const configuredSafeAddress = networks[network.toLowerCase()]?.safeAddress'
    )
    expect(PREFETCH).toContain(
      'configuredSafeAddress ? undefined : txSafeAddress'
    )

    // …and the claim it displaces survives, so the assertions have two values
    // to compare rather than one value agreeing with itself.
    expect(PREFETCH).toContain('configuredSafeAddress?: string')
    expect(SOURCE).toContain('documentSafeAddress: tx.safeAddress')
  })

  it('reads the signed struct, never the stored row, for every field it keys on', () => {
    const evaluation = SOURCE.indexOf(
      'integrityRun = await runIntegrityAsserts('
    )
    const call = SOURCE.slice(
      evaluation,
      SOURCE.indexOf('createIntegrityAssertDeps({', evaluation)
    )
    for (const field of [
      'to: tx.safeTransaction.data.to',
      'signedValue: String(tx.safeTransaction.data.value)',
      'signedOperation: tx.safeTransaction.data.operation ?? 0',
      'signedNonce: Number(tx.safeTransaction.data.nonce)',
    ])
      expect(call).toContain(field)

    // The payload is handed over unchanged. A `?? '0x'` here invents a payload
    // the struct does not carry, and the graded key then disagrees with the
    // funnels' — which refuses every proposal with no calldata.
    expect(call).toContain('data: tx.safeTransaction.data.data,')
    expect(call).not.toContain("tx.safeTransaction.data.data ?? '0x'")

    // …and the stored row reaches it only as the thing being compared.
    expect(call).toContain('storedTxData: (tx.safeTx.data ?? {})')
    expect(call).not.toContain('to: tx.safeTx.data.to')
  })
})
