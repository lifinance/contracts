/**
 * Pins where the preflight sits inside `confirm-safe-tx.ts`.
 *
 * The decision is covered by `signer-preflight.test.ts`; what cannot be observed
 * there is whether it runs early enough to be worth having. Three orderings
 * carry the whole design, and all three are invisible to a unit test of the
 * module: the preflight has to run before the ledger exists, before the
 * ownership reads that would otherwise report a dead endpoint as "you are not a
 * Safe owner", and the ledger's denominator has to be the networks it cleared.
 *
 * Source-order assertions, because the confirmation CLI cannot be spawned from a
 * test — it reconciles the store at startup and goes on to sign — so this proves
 * the ordering of the code and not the behaviour of a run.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const CONFIRM_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'confirm-safe-tx.ts'
)

const PREFLIGHT_CALL = 'const preflightVerdict = await preflight('
const LEDGER_CREATED = 'checkLedger = createCheckLedger({'
const OWNERSHIP_FILTER = 'await getNetworksWithActionableTransactions('
const EARLY_RETURN = 'if (preflightVerdict.startable.length === 0) {'

describe('preflight placement in confirm-safe-tx', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(CONFIRM_SCRIPT, 'utf8')
  })

  const at = (needle: string): number => {
    const index = source.indexOf(needle)
    expect(index, `not found in confirm-safe-tx.ts: ${needle}`).toBeGreaterThan(
      -1
    )
    return index
  }

  it('runs before a ledger exists', () => {
    expect(at(PREFLIGHT_CALL)).toBeLessThan(at(LEDGER_CREATED))
  })

  // A failed read there is swallowed as "not actionable", which is a true
  // statement with a false explanation.
  it('runs before the ownership reads', () => {
    expect(at(PREFLIGHT_CALL)).toBeLessThan(at(OWNERSHIP_FILTER))
  })

  it('returns before the ledger when no network can start', () => {
    expect(at(EARLY_RETURN)).toBeLessThan(at(LEDGER_CREATED))
    const earlyReturn = source.slice(at(EARLY_RETURN), at(EARLY_RETURN) + 240)
    expect(earlyReturn).toContain('PREFLIGHT_EXIT_CODE')
    expect(earlyReturn).toContain('return')
    expect(earlyReturn).not.toContain('createCheckLedger')
  })

  // The denominator is the whole point: a refused network left in it comes back
  // as a column of unverified rows describing one unset variable, which is the
  // display this preflight exists to remove.
  it('gives the ledger only the networks the preflight cleared', () => {
    const ownershipCall = source.slice(at(OWNERSHIP_FILTER), at(LEDGER_CREATED))

    expect(ownershipCall).toContain('preflightVerdict.startable.includes(')
    expect(source).toContain('networks = [...preflightVerdict.startable]')
  })

  it('says at the end of the run what the verdict does not cover', () => {
    const tail = source.slice(at('renderCheckLedger(checkLedger)'))

    expect(tail).toContain('refusedNetworks.length > 0')
    expect(tail).toContain('Not covered by the verdict above')
  })
})
