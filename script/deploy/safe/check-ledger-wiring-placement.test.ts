/**
 * Where the check ledger is created and written inside
 * `confirm-safe-tx.ts` — not what it decides.
 *
 * What it decides is driven for real in `check-ledger.test.ts` and
 * `confirm-check-registry.test.ts`. What cannot be driven at all is the script:
 * `confirm-safe-tx.ts` calls `runMain` at module scope, so importing it runs the
 * CLI, and reaching its loop needs MongoDB, a Safe and a Ledger. So the wiring
 * is asserted on the source, and the assertions are shaped so each of these
 * fails them:
 *
 * - deleting either call site;
 * - restoring the render, which puts a verdict that inverts back in front of a
 *   signer;
 * - recording per proposal, which lets `rollUpChecks` read two proposals on one
 *   network as a retry and a later clean one erase an earlier refusal;
 * - leaving a network the run skipped in the denominator, where it rolls up as
 *   missing and blocks a run on which nothing was wrong.
 *
 * Anchored on call sites throughout, never on a rendered string: a display
 * literal is reworded for reasons that have nothing to do with the wiring, and
 * a placement test pinned to one fails the rewording instead of the regression.
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
 * The per-proposal loop's body.
 *
 * Bounded by the loop's own dedented closing brace rather than by a character
 * count: a fixed window stops covering the tail of the loop the first time
 * anything is inserted near its top, and then reports a call site as absent
 * rather than as misplaced. Both ends are guarded, because an unfound delimiter
 * widens the window to the rest of the file instead of narrowing it.
 */
const proposalLoop = (): { start: number; end: number; body: string } => {
  const start = SOURCE.indexOf('for (const tx of initialTxs')
  expect(start).toBeGreaterThan(-1)

  // Brace depth, not the first line that looks like a dedented `}`. A literal
  // delimiter is shrinkable: a template literal holding a line of exactly two
  // spaces and a brace ends the window early, and a reintroduced call then sits
  // outside it while every positive assertion still passes. Counting can only be
  // fooled the other way — an unbalanced brace inside a string widens the
  // window, which makes the negative assertion stricter, not weaker.
  //
  // The header is skipped by paren depth first, because it contains a brace of
  // its own: `initialTxs.sort((a, b) => {` would otherwise be taken for the
  // loop body and the window would cover only the comparator.
  let parens = 0
  let open = -1
  for (let i = SOURCE.indexOf('(', start); i < SOURCE.length; i++) {
    if (SOURCE[i] === '(') parens++
    else if (SOURCE[i] === ')' && --parens === 0) {
      open = SOURCE.indexOf('{', i)
      break
    }
  }
  expect(open).toBeGreaterThan(start)

  let depth = 0
  let end = -1
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++
    else if (SOURCE[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  expect(end).toBeGreaterThan(open)

  const body = SOURCE.slice(start, end)
  // Proves the window reaches the loop's real tail. A shrunken window would
  // still satisfy every positive assertion below while hiding a call from the
  // negative one, so the span itself is checked rather than assumed.
  expect(body).toContain("consola.error('Error executing with deployer:'")

  return { start, end, body }
}

const countOf = (pattern: RegExp): number =>
  [...SOURCE.matchAll(pattern)].length

/**
 * Every function declared in the file, by name, with its body.
 *
 * Brace-counted from the declaration, the same way {@link proposalLoop} bounds
 * the loop, so a nested function or an object literal cannot end a body early.
 */
const localFunctionBodies = (): Map<string, string> => {
  const bodies = new Map<string, string>()

  for (const match of SOURCE.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/gu)) {
    const name = match[1]
    if (name === undefined) continue

    let parens = 0
    let open = -1
    for (let i = match.index + match[0].length - 1; i < SOURCE.length; i++) {
      if (SOURCE[i] === '(') parens++
      else if (SOURCE[i] === ')' && --parens === 0) {
        open = SOURCE.indexOf('{', i)
        break
      }
    }
    if (open === -1) continue

    let depth = 0
    for (let i = open; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') depth++
      else if (SOURCE[i] === '}' && --depth === 0) {
        bodies.set(name, SOURCE.slice(open, i))
        break
      }
    }
  }

  return bodies
}

describe('the check ledger is wired into the confirmation run', () => {
  it('creates the ledger and records into it', () => {
    // The paired positive for every negative below: an assertion that no call
    // site is misplaced passes trivially against a file that has none.
    expect(SOURCE).toContain('createCheckLedger({')
    expect(SOURCE).toContain('recordCheck(checkLedger,')
  })

  it('fixes the denominator before the first network is processed', () => {
    const created = SOURCE.indexOf('createCheckLedger({')
    const networkLoop = SOURCE.indexOf(
      'for (let i = 0; i < networks.length; i++)'
    )

    expect(networkLoop).toBeGreaterThan(-1)
    // Created from the run's own network set, and before anything is graded: a
    // ledger built later would take its denominator from whatever had already
    // been reached.
    expect(created).toBeLessThan(networkLoop)
    // The filter body, not just the call: `toContain` on the opening line stays
    // green while the predicate grows a condition that drops networks from the
    // denominator, which is the one thing fixing it early is meant to prevent.
    expect(SOURCE).toMatch(
      /expectedNetworks: networks\.filter\(\(network\): network is string =>\s*Boolean\(network\)\s*\),/
    )
  })
})

describe('one row per network, not one per proposal', () => {
  it('grades every proposal inside the loop', () => {
    const { body } = proposalLoop()

    expect(body).toContain('targetStateCheckResult(targetState, network)')
    expect(body).toContain('proposalChecks.push(')

    // Position, not just presence. Below the operator's own `continue` the push
    // is skipped for a declined proposal, and a network whose only proposal was
    // declined then reaches `proposalChecks.length === 0` and records a pass —
    // a green row for a real proposal nothing graded.
    const graded = body.indexOf('proposalChecks.push(')
    const declined = body.indexOf("if (action === 'Do Nothing') continue")

    expect(declined).toBeGreaterThan(-1)
    expect(graded).toBeLessThan(declined)
  })

  it('records nothing from inside the loop', () => {
    const { body } = proposalLoop()

    // `rollUpChecks` treats two records for one (check, network) pair as a retry
    // and lets a later `pass` supersede an earlier `error`, so a per-proposal
    // record would let the last proposal's verdict stand for the network.
    expect([...body.matchAll(/recordCheck\(/g)]).toEqual([])
  })

  // Lexical absence is not runtime absence. `recordSignedSet` is declared above
  // the loop and called from inside it, so scanning the loop's own text reports
  // a clean file while a row is still written once per proposal. Reachability
  // is the property the ledger actually needs.
  it('records nothing from anything the loop calls either', () => {
    const { body } = proposalLoop()
    const bodies = localFunctionBodies()

    // A positive control: the traversal is worth nothing if it cannot see the
    // helper the loop is known to reach.
    expect(bodies.has('recordSignedSet')).toBe(true)
    expect(body).toContain('persistSignedSafeTx(')

    const reached = new Set<string>()
    const walk = (source: string): void => {
      for (const [name, functionBody] of bodies)
        if (
          !reached.has(name) &&
          new RegExp(`\\b${name}\\s*\\(`, 'u').test(source)
        ) {
          reached.add(name)
          walk(functionBody)
        }
    }
    walk(body)

    expect(reached).toContain('recordSignedSet')

    const recording = [...reached].filter((name) =>
      (bodies.get(name) ?? '').includes('recordCheck(')
    )
    expect(recording).toEqual([])
  })

  it('reduces the proposals worst-first and records once, after the loop', () => {
    const { end } = proposalLoop()
    const reduce = SOURCE.indexOf('worstResultPerCheck(proposalChecks)')

    expect(reduce).toBeGreaterThan(-1)
    // After the loop closes, so every proposal on the network has been graded
    // before the one surviving row is written.
    expect(reduce).toBeGreaterThan(end)
    expect(SOURCE.slice(end)).toContain('recordCheck(checkLedger, result)')
  })
})

describe('a network the run skipped does not block it', () => {
  /**
   * Every `prepare` outcome that continues the run without grading anything,
   * and which of the two recorders it must use.
   *
   * The distinction is the whole point: an outcome that *answered* is a
   * verified "nothing here", while a read that *failed* established nothing and
   * must stay unverified. Recording the second as a pass is how a run that
   * examined two networks out of three rolls up all three as verified.
   *
   * `read-failed` and `prepare-error` are deliberately absent: both throw, so
   * the run aborts and the networks it never reached *should* roll up as
   * missing.
   */
  const SKIPPING_CASES = [
    [
      "case 'nothing-actionable':",
      "case 'not-owner':",
      'recordNothingToGrade(',
    ],
    [
      "case 'not-owner':",
      "case 'owner-check-failed':",
      'recordNothingToGrade(',
    ],
    [
      "case 'owner-check-failed':",
      "case 'read-failed':",
      'recordCouldNotGrade(',
    ],
  ] as const

  it('records the right kind of row in every branch that skips a network', () => {
    for (const [open, close, recorder] of SKIPPING_CASES) {
      const start = SOURCE.indexOf(open)
      expect(start).toBeGreaterThan(-1)
      const end = SOURCE.indexOf(close, start)
      expect(end).toBeGreaterThan(start)
      const branch = SOURCE.slice(start, end)

      // Without a row the network stays in the denominator, rolls up as missing
      // and hard-blocks the verdict on a run where nothing was wrong…
      expect(branch).toContain(recorder)
      // …and with the wrong row it goes green on a network nothing examined.
      const wrong =
        recorder === 'recordNothingToGrade('
          ? 'recordCouldNotGrade('
          : 'recordNothingToGrade('
      expect(branch).not.toContain(wrong)
    }
  })

  it('records one for a network whose transactions never arrived', () => {
    expect(SOURCE).toContain(
      "recordNothingToGrade(network, 'no pending transaction was fetched')"
    )
  })

  /**
   * The status each recorder writes — the field that *is* the fix.
   *
   * Pinned because neither helper can be reached any other way: `confirm-safe-tx.ts`
   * calls `runMain` at module scope, so importing it runs the CLI, and both
   * helpers are module-private. Asserting only the anchor and the prose left the
   * status free — flipping `recordNothingToGrade` to `error` kept the whole
   * directory green while reinstating the spurious hard block it exists to
   * prevent.
   */
  const RECORDERS = [
    ['const recordNothingToGrade = (', "status: 'pass'", "anchor: 'A-LOCAL'"],
    [
      'const recordCouldNotGrade = (',
      "status: 'error'",
      "anchor: 'A-UNRESOLVED'",
    ],
  ] as const

  it('writes a verified row for one and an unverified row for the other', () => {
    for (const [declaration, status, anchor] of RECORDERS) {
      const helper = SOURCE.indexOf(declaration)
      expect(helper).toBeGreaterThan(-1)
      const closes = SOURCE.indexOf('\n  })\n', helper)
      expect(closes).toBeGreaterThan(helper)
      const body = SOURCE.slice(helper, closes)

      expect(body).toContain(status)
      expect(body).toContain(anchor)
    }
  })

  it('keeps both recorders reachable from every branch that needs one', () => {
    // Four skip paths plus the empty-proposal branch inside processTxs.
    expect(
      countOf(/recordNothingToGrade\(|recordCouldNotGrade\(/g)
    ).toBeGreaterThanOrEqual(5)
  })
})

describe('the verdict stays withheld', () => {
  it('does not render the ledger', () => {
    // Only a `pass` counts toward the verified coverage while every status a
    // correct Add/Replace cut produces is `needs-ack`, so a correct rollout
    // grades 0/N and a run that graded nothing grades green. EXSC-994 owns
    // fixing that before any of it is printed.
    //
    // `summariseLedger` is pinned alongside the renderer because it is where
    // the inversion lives: the render is a thin wrapper over it, this file
    // already imports from that module, and printing its verdict directly
    // would restore the display without naming the renderer at all.
    expect(SOURCE).not.toMatch(
      /renderCheckLedger|render-check-ledger|summariseLedger/
    )
  })
})
