/**
 * Pins where a proposal's chain reads start inside `confirm-safe-tx.ts`.
 *
 * The prefetch's own semantics are covered by `confirm-safe-tx-prefetch.test.ts`.
 * What cannot be observed there is the one thing that decides whether it pays:
 * the reads have to be started before the proposal is drawn, or the signer waits
 * out a cold codehash rebuild — up to a minute — in front of an empty screen
 * instead of alongside the block they are meant to be reading. Scheduling was
 * wired for the *next* proposal only, so the first one paid it inline every run.
 *
 * A source-order assertion because the confirmation CLI cannot be spawned from a
 * test: it signs and broadcasts.
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

const SCHEDULE_THIS = 'evidencePrefetch.schedule(\n      tx,'
const SCHEDULE_NEXT = 'evidencePrefetch.schedule(\n        nextTx,'
const ZONE_ONE = 'zoneHeading(\n        1,'
const TAKE = 'await evidencePrefetch.take('

describe('evidence prefetch placement in confirm-safe-tx', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(CONFIRM_SCRIPT, 'utf8')
  })

  it('starts this proposal’s reads before its first zone is drawn', () => {
    expect(source.indexOf(SCHEDULE_THIS)).toBeGreaterThan(-1)
    expect(source.indexOf(ZONE_ONE)).toBeGreaterThan(-1)
    expect(source.indexOf(SCHEDULE_THIS)).toBeLessThan(source.indexOf(ZONE_ONE))
  })

  it('still queues the next proposal, one ahead and no further', () => {
    expect(source.indexOf(SCHEDULE_NEXT)).toBeGreaterThan(source.indexOf(TAKE))
  })
})
