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

  // The findings already sit under their gate's row in section 2; a refusal
  // that lists them again shows the signer the same facts twice and invites a
  // search for the difference.
  it('does not print the gate H findings a second time in the refusal', () => {
    const at = source.indexOf(GATE)
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('\n    }', at)
    expect(end).toBeGreaterThan(at)
    const block = source.slice(at, end)
    expect(block).not.toContain('formatTargetStateLines(')
    expect(block).toContain('renderTargetStateRefusal(')
    expect(source.split('formatTargetStateLines(').length - 1).toBe(1)
  })

  // The provenance sentence is built as one line and printed through consola,
  // which does not wrap; on a real run it reached 206 columns.
  it('folds the evidence provenance lines to the view width', () => {
    expect(source).toContain('foldLines(describeEvidenceProvenance(evidence))')
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
    // `url` is the resolved transport config's output; a bare `http()` takes
    // the chain's own default and carries no endpoint of ours.
    for (const [, argument] of callSites)
      expect(argument?.trim() ?? '').toMatch(/^(url)?$/u)
  })

  // Through the sign-time wrapper specifically, not `getTransportConfigFromRpcUrl`
  // directly: every read in this file happens while a signer waits, and the raw
  // helper forwards the endpoint's own retry profile — TronGrid's is 8 retries
  // on a 2s exponential backoff, minutes of wall clock for one read.
  it('passes every endpoint through the sign-time transport config first', () => {
    expect(source.indexOf('getSignTimeTransportConfig(')).toBeGreaterThan(-1)
    expect(source.indexOf('getTransportConfigFromRpcUrl(')).toBe(-1)
  })

  // Gate G grades the contracts this proposal installs, while the observation
  // it is built from reads every address the calldata names — for the record
  // and for the pre-broadcast re-read. Handing the wide set to the gate is how
  // it comes to ask about a diamond's owner on a proposal that only removes a
  // facet from it, and the two sets are one expression apart in this file.
  // Asserted against what the grading call is handed, not against the file as a
  // whole: the record writer is the one place that legitimately keeps every
  // address it observed.
  it('grades gate G on the narrowed set, never the whole observation', () => {
    const at = source.indexOf('proposalCheckResults({')
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('\n      })', at)
    expect(end).toBeGreaterThan(at)
    const call = source.slice(at, end)

    expect(call).toContain('installedAuthorities')
    expect(call).not.toContain('observed.authorities')
    expect(source.indexOf('authoritiesOfInstalled(')).toBeLessThan(at)
  })
})
