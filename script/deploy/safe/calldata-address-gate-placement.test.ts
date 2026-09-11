/**
 * Where the calldata address check runs inside `confirm-safe-tx.ts` — not what
 * it decides. `calldata-address-check.test.ts` covers the decision and the
 * rendering, `calldata-address-collector.test.ts` the reads that feed it.
 *
 * WP-3.3's success criterion is that an unknown address surfaces *before
 * signing*, and this gate carries no ledger row, so nothing else in the suite
 * can observe whether it is reached at all — deleting its call site leaves the
 * whole suite green. `confirm-safe-tx.ts` calls `runMain` at module scope, so
 * the CLI cannot be imported to drive it, and placement is asserted on the
 * source instead.
 *
 * Anchored on call sites, never on a rendered line: a display literal is
 * reworded for reasons unrelated to the wiring.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const CONFIRM = readFileSync(
  join(import.meta.dir, 'confirm-safe-tx.ts'),
  'utf8'
)

const ACTION_PROMPT = "consola.prompt('Select action:'"

describe('the calldata address check surfaces before the signing decision', () => {
  it('reads the addresses out of the signed struct, not out of the record', () => {
    // The references come from the calldata the signature will cover. Reading
    // them from anywhere else — the proposal document, the deploy log — would
    // grade a payload other than the one being signed.
    const packed = CONFIRM.replace(/\s+/gu, '')

    expect(packed).toContain(
      'collectAddressReferences(tx.safeTransaction.data.data?[tx.safeTransaction.data.dataasHex]:[])'
    )
  })

  it('resolves them against the record and renders the verdict', () => {
    expect(CONFIRM).toContain('evaluateCalldataAddresses(')
    expect(CONFIRM).toContain('renderCalldataAddresses(calldataAddresses)')
  })

  it('renders before the action prompt', () => {
    const rendered = CONFIRM.indexOf('renderCalldataAddresses(')
    const prompt = CONFIRM.indexOf(ACTION_PROMPT)

    expect(rendered).toBeGreaterThan(-1)
    expect(prompt).toBeGreaterThan(-1)
    expect(rendered).toBeLessThan(prompt)
  })

  it('indexes the record on the addresses the payload actually references', () => {
    // The index is a lookup built per proposal. Handed an empty address list it
    // resolves nothing, and every reference then reads as an address the record
    // does not carry — a gate that refuses everything is as useless as one that
    // refuses nothing.
    const packed = CONFIRM.replace(/\s+/gu, '')

    expect(packed).toContain(
      'buildDeploymentIndex(records,references.map((reference)=>reference.address))'
    )
  })

  it('reports a run it could not make through the sanitiser', () => {
    // A gate whose reads throw must say so on the screen the signer reads. The
    // deployment record is fetched over a keyed URI, so the message is redacted
    // rather than printed raw.
    const guarded = CONFIRM.slice(
      CONFIRM.indexOf('collectAddressReferences('),
      CONFIRM.indexOf(ACTION_PROMPT)
    )

    expect(guarded).toContain('Calldata addresses: the check could not be run')
    expect(guarded).toMatch(
      /Calldata addresses: the check could not be run[\s\S]*?redactUrls\(/u
    )
  })
})
