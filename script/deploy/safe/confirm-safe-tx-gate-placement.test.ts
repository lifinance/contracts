/**
 * Pins where the sign-time target-state gate sits inside `confirm-safe-tx.ts`.
 *
 * The decision itself is covered by `pinned-target-state.test.ts`; what cannot be
 * observed there is whether the refusal is wired in front of the irreversible
 * step. This is a source-order assertion because the confirmation CLI cannot be
 * spawned from a test — it signs and broadcasts — so it proves the ordering of
 * the code and not the behaviour of a run.
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

const GATE = 'if (!targetState.cleared) {'
const ACKNOWLEDGEMENT_RECORDED =
  'recordAcknowledgement(acknowledgementLedger, {'
const NONCE_GATE = "nonceDecision?.reason === 'stale-nonce'"

/** Every point past which the proposal is no longer only being reviewed. */
const IRREVERSIBLE_CALLS = [
  'await signTransaction(safeTransaction)',
  // Deployer re-sign goes through the same gated funnel; the old
  // `deployerSafe.signTransaction(...)` spelling is gone after the codehash
  // gate landed on main.
  'await signTransaction(signedTx, deployerSafe)',
  'await executeTransaction(',
]

describe('target-state gate placement in confirm-safe-tx', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(CONFIRM_SCRIPT, 'utf8')
  })

  it('skips to the next proposal rather than proceeding', () => {
    const at = source.indexOf(GATE)
    expect(at).toBeGreaterThan(-1)
    const block = source.slice(at, source.indexOf('\n    }', at))
    expect(block).toContain('continue')
    expect(block).not.toContain('signTransaction')
  })

  it('sits after the pre-existing nonce gate, which it must not swallow', () => {
    expect(source.indexOf(NONCE_GATE)).toBeGreaterThan(-1)
    expect(source.indexOf(GATE)).toBeGreaterThan(source.indexOf(NONCE_GATE))
  })

  it('sits before the acknowledgement is recorded', () => {
    expect(source.indexOf(ACKNOWLEDGEMENT_RECORDED)).toBeGreaterThan(-1)
    expect(source.indexOf(GATE)).toBeLessThan(
      source.indexOf(ACKNOWLEDGEMENT_RECORDED)
    )
  })

  it('sits before every signing and execution call site', () => {
    for (const call of IRREVERSIBLE_CALLS) {
      const at = source.indexOf(call)
      expect(at).toBeGreaterThan(-1)
      expect(source.indexOf(GATE)).toBeLessThan(at)
    }
  })

  // Enumerated over every `http(` in the file rather than asserted against the
  // spelling one bypass happened to use. viem lifts `user:pass@` out of a URL
  // itself but its branch is `if (url.username)`, so a password-only endpoint
  // handed to `http()` bare is queried unauthenticated and answers 401 — which
  // this CLI records as chain state that could not be read. Two of these were
  // added and fixed separately on one PR, so the next one is worth catching by
  // shape.
  it('builds no transport from a raw endpoint URL', () => {
    const callSites = [...source.matchAll(/(?<![$\w])http\(([^,)]*)/gu)]

    expect(callSites.length).toBeGreaterThan(0)
    // `url` is `getTransportConfigFromRpcUrl`'s output; a bare `http()` takes
    // the chain's own default and carries no endpoint of ours.
    for (const [, argument] of callSites)
      expect(argument?.trim() ?? '').toMatch(/^(url)?$/u)
  })

  it('passes every endpoint through the shared transport config first', () => {
    expect(source.indexOf('getTransportConfigFromRpcUrl(')).toBeGreaterThan(-1)
  })
})
