/**
 * Where the pre-broadcast gate's refusals sit inside
 * `enforcePreBroadcastGateOrAbort`, not what they decide.
 *
 * The decision is driven for real against `unverifiedGateOutcome` and
 * `evaluatePreBroadcastGate`. What cannot be driven here is the wiring:
 * `execute-pending-timelock-tx.ts` calls `runMain` at module scope, so
 * importing it runs the CLI, and reaching the gate needs MongoDB, an RPC and a
 * populated timelock queue. So the placement is asserted on the source.
 *
 * The property being pinned is the whole point of shadow mode: the caller turns
 * every outcome other than `'ok'` into `failed`, so a refusal that is reachable
 * with `PRE_BROADCAST_GATE_ENFORCE` unset stops a production timelock execution
 * and reports an honest operation as failed. Reverting any one of the three
 * catch blocks to a bare `return 'retry'` reintroduces exactly that, and left
 * the rest of the suite green — which is what this file exists to stop.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

const SOURCE = readFileSync(
  join(import.meta.dir, 'execute-pending-timelock-tx.ts'),
  'utf8'
)

/**
 * The body of `enforcePreBroadcastGateOrAbort`, from its declaration to the
 * next declaration at column zero.
 *
 * Sliced rather than parsed because the assertions below are all about the
 * order of statements as written, which is what a reviewer reads and what a
 * regression would change.
 */
const gateFunctionSource = (): string => {
  const start = SOURCE.indexOf('async function enforcePreBroadcastGateOrAbort(')
  expect(start).toBeGreaterThan(-1)
  const end = SOURCE.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

/** Both spellings of "only when a refusal is binding". */
const ENFORCING_CHECK =
  /unverifiedGateOutcome\(process\.env\)|isPreBroadcastGateEnforcing\(process\.env\)/gu

const REFUSING_RETURN = /return '(?:retry|blocked)'/gu

/**
 * The same pattern without `g`, for the `toMatch` assertions.
 *
 * bun's `toMatch` advances `lastIndex` on a global regex, so a second call with
 * the same object starts scanning past the first match and reports no match.
 * Under `.not.toMatch` that reads as a pass — the assertion would go green on
 * exactly the refusal it exists to catch.
 */
const REFUSING_RETURN_TEST = /return '(?:retry|blocked)'/u

describe('pre-broadcast gate placement', () => {
  const body = gateFunctionSource()

  // The gate's own premise. A refusal that no enforcing check dominates is a
  // production broadcast stopped by a verdict shadow mode is not allowed to act
  // on — the bug this placement exists to keep out.
  it('never refuses before an enforcing check', () => {
    const firstEnforcing = body.search(ENFORCING_CHECK)
    expect(firstEnforcing).toBeGreaterThan(-1)

    const refusals = [...body.matchAll(REFUSING_RETURN)].map((m) => m.index)
    expect(refusals.length).toBeGreaterThan(0)
    for (const at of refusals) expect(at).toBeGreaterThan(firstEnforcing)
  })

  // Every way the gate can fail to produce a verdict has to go through the one
  // helper that consults the flag. A catch that answers for itself is the
  // revert this file is aimed at.
  it('routes every catch through abortUnverified', () => {
    const catches = [...body.matchAll(/\}\s*catch\s*\(\w+\)\s*\{/gu)]
    expect(catches.length).toBe(3)

    for (const match of catches) {
      const after = body.slice(
        match.index + match[0].length,
        body.indexOf('}', match.index + match[0].length) + 1
      )
      expect(after).toContain('abortUnverified')
      expect(after).not.toMatch(REFUSING_RETURN_TEST)
    }
  })

  // `abortUnverified` is the only place a not-a-verdict may become a refusal,
  // so a second bare refusal outside the disposition branch means a path was
  // added that skipped it.
  it('keeps the unverified refusal in one place', () => {
    const helper = body.slice(
      body.indexOf('const abortUnverified'),
      body.indexOf('let deployments')
    )
    expect(helper).toContain("unverifiedGateOutcome(process.env) === 'ok'")
    expect([...helper.matchAll(REFUSING_RETURN)]).toHaveLength(1)
  })

  // Goran, PR #2353: the totality of this function rested on every alert call
  // being unable to throw, which is a property of `sendNotificationWithRetry`'s
  // default argument in another module — something a scan of this file cannot
  // see. The call site catching makes it hold whatever that module does.
  it('catches at the call site, so a throw here cannot escape unhandled', () => {
    const callSite = SOURCE.slice(
      SOURCE.indexOf('const gate = networkName'),
      SOURCE.indexOf('// If interactive mode, show choice prompt')
    )
    expect(callSite).toContain('enforcePreBroadcastGateOrAbort(')
    expect(callSite).toContain('.catch(')
    // And what it answers with is the flag-aware outcome, not a bare refusal:
    // a throw must not stop a production broadcast under shadow mode either.
    expect(callSite).toContain('unverifiedGateOutcome(process.env)')
    expect(callSite).not.toMatch(REFUSING_RETURN_TEST)
  })

  // Daniel's call, PR #2353: while the gate cannot stop anything, its output
  // must not compete with the escalations a human is expected to act on. Every
  // operation queued before this shipped has no sign-time record, so the gap
  // alert would otherwise fire on every honest operation on every chain.
  it('sends nothing to Slack until enforcement is on', () => {
    const guard = body.slice(
      body.indexOf('const mayAlert'),
      body.indexOf('const alertFailure')
    )
    expect(guard).toContain('isPreBroadcastGateEnforcing(process.env)')

    // Every notifier call in this function is behind that guard. The trailing
    // paren keeps a mention in a comment from counting as a call site.
    const sends = [...body.matchAll(/sendNotificationWithRetry\(/gu)]
    expect(sends.length).toBeGreaterThan(0)
    for (const send of sends) {
      const statement = body.slice(
        body.lastIndexOf('if (', send.index),
        send.index
      )
      expect(statement).toContain('mayAlert()')
    }
  })

  // The alert channels are not interchangeable: a gap says nothing was checked,
  // a failure says an operation failed. Shadow mode has not failed anything.
  it('reports an unverified operation as a gap, not a failure', () => {
    const helper = body.slice(
      body.indexOf('const abortUnverified'),
      body.indexOf('let deployments')
    )
    const shadowBranch = helper.slice(
      helper.indexOf("unverifiedGateOutcome(process.env) === 'ok'"),
      helper.indexOf("return 'ok'")
    )
    expect(shadowBranch).toContain('alertGap')
    expect(shadowBranch).not.toContain('alertFailure')
  })
})
