/**
 * Where the check ledger is created, written and rendered inside
 * `confirm-safe-tx.ts` — not what it decides.
 *
 * What it decides is driven for real in `check-ledger.test.ts` and
 * `confirm-check-registry.test.ts`. What cannot be driven at all is the script:
 * `confirm-safe-tx.ts` calls `runMain` at module scope, so importing it runs the
 * CLI, and reaching its loop needs MongoDB, a Safe and a Ledger. So the wiring
 * is asserted on the source, and the assertions are shaped so each bug this file
 * was written after fails them:
 *
 * - deleting either call site, which left the whole suite green while three
 *   merged gates sat unreached;
 * - recording per proposal, which lets `rollUpChecks` read two proposals on one
 *   network as a retry and a later clean one erase an earlier refusal;
 * - leaving a network the run skipped in the denominator, where it rolls up as
 *   missing and blocks a run on which nothing was wrong;
 * - gating the render on the ledger holding results, which suppresses the report
 *   for exactly the runs that aborted before their first proposal.
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

describe('the check ledger is wired into the confirmation run', () => {
  it('creates the ledger, records into it and renders it', () => {
    // The paired positive for every negative below: an assertion that no call
    // site is misplaced passes trivially against a file that has none.
    expect(SOURCE).toContain('createCheckLedger({')
    expect(SOURCE).toContain('recordCheck(checkLedger,')
    expect(SOURCE).toContain('renderCheckLedger(checkLedger)')
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

    // Every gate's verdict for this proposal, produced in one ordered step and
    // pushed rather than recorded. The order itself is pinned in
    // `confirm-check-registry.test.ts` over the rows, not over this source.
    expect(body).toContain('proposalCheckResults({')
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

    // The bug: `recordCheck` per proposal. `rollUpChecks` treats two records for
    // one (check, network) pair as a retry and lets a later `pass` supersede an
    // earlier `error`, so the last proposal's verdict stood for the network.
    expect([...body.matchAll(/recordCheck\(/g)]).toEqual([])
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
   * examined two networks out of three reports `3/3 network results verified`.
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
      // and produces VERDICT: BLOCKED on a run where nothing was wrong…
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
   * directory green while reinstating the spurious BLOCKED it exists to prevent.
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

describe('the report is printed whatever the ledger holds', () => {
  it('renders in the finally block, after the signing decisions', () => {
    const finallyBlock = SOURCE.indexOf('} finally {')
    const render = SOURCE.indexOf('renderCheckLedger(checkLedger)')

    expect(finallyBlock).toBeGreaterThan(-1)
    // An aborted run is where the report matters most, so it cannot sit on the
    // happy path.
    expect(render).toBeGreaterThan(finallyBlock)
  })

  it('is not suppressed for a run that recorded nothing', () => {
    // A ledger with no results renders a BLOCKED verdict counting every
    // expected network as an unverified result, which is the single most
    // important report there is; the old guard hid it for exactly the runs that
    // aborted before the first proposal.
    //
    // Asserted as a shape rather than as one spelling: pinning the literal
    // `checkLedger.results.length` leaves `checkLedger?.results?.length` free,
    // which restores the suppression and reads as a tidy-up in review.
    expect(SOURCE).not.toMatch(/checkLedger\s*\??\.\s*results\s*\??\.\s*length/)

    // The paired positive — the guard is the existence check and nothing else.
    expect(SOURCE).toMatch(/if \(checkLedger\)\s*\n\s*renderCheckLedger\(/)
  })
})

/**
 * The argument object handed to `proposalCheckResults`, brace-matched from the
 * call rather than sliced by a character count, so a field inserted near its
 * top cannot push another out of the window.
 */
const recorderArguments = (): string => {
  const { body } = proposalLoop()
  const open = body.indexOf('proposalCheckResults({')

  expect(open).toBeGreaterThan(-1)

  let depth = 0
  const from = body.indexOf('{', open)
  for (let i = from; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}' && --depth === 0) return body.slice(from, i)
  }

  throw new Error('recorderArguments: unbalanced argument object')
}

describe('each gate that owns a ledger row hands the recorder its verdict', () => {
  /**
   * The gates whose verdict is collected in the loop, by the reader that
   * produces it, the evaluator that grades it and the field it arrives under.
   *
   * A registered check the recorder is never given a verdict for is not a gap
   * the type system sees: the row falls through to the unresolved branch and
   * records an `error`, so the run blocks for an evidence reason and the gate
   * reads as wired.
   */
  const collected = [
    {
      gate: 'executability',
      reader: 'collectExecutabilityInput(',
      evaluator: 'evaluateExecutability(',
      field: 'executability',
    },
    {
      gate: 'rpc quorum',
      reader: 'collectProviderObservations(',
      evaluator: 'evaluateRpcQuorum(',
      field: 'rpcQuorum',
    },
  ]

  for (const { gate, reader, evaluator, field } of collected) {
    it(`collects the ${gate} verdict and passes it to the recorder`, () => {
      const { body } = proposalLoop()

      expect(body).toContain(reader)
      expect(body).toContain(evaluator)
      expect(recorderArguments()).toContain(`${field},`)
    })

    it(`leaves a failed ${gate} read absent rather than defaulting it`, () => {
      // The decision modules grade an absent observation as unchecked and an
      // unchecked one as an error. A `catch` that assigned a plausible verdict
      // instead would turn "nobody asked" into "the chain agreed" — the
      // false-green path the collectors exist to close.
      const { body } = proposalLoop()
      const assignments =
        body.match(new RegExp(`\\b${field}\\s*=(?!=)`, 'gu')) ?? []
      const fromEvaluator =
        body.match(
          new RegExp(
            `\\b${field}\\s*=\\s*${evaluator.replace('(', '\\(')}`,
            'gu'
          )
        ) ?? []

      expect(assignments.length).toBeGreaterThan(0)
      expect(fromEvaluator.length).toBe(assignments.length)
    })
  }
})
