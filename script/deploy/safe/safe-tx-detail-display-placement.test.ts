/**
 * That the CLI still hands the block its stored values unrendered.
 *
 * This is a tripwire, not the guarantee. The guarantee is that
 * `buildSafeTxDetailLines` sanitises every stored value it is given, which
 * `safe-tx-detail-display.test.ts` proves by executing it. What execution
 * cannot reach is `confirm-safe-tx.ts` itself — it is a CLI with `runMain` at
 * module scope — so the one thing asserted here is the shape of the call.
 *
 * Two earlier versions of this file tried to prove the property by scanning
 * the source for unsafe interpolations. Both were defeated by rewrites that
 * changed nothing about the behaviour: a `const d = tx.safeTx.data` alias, an
 * `include`-based exclusion that a trailing comment satisfied, bracket access,
 * optional chaining, string concatenation. A scanner cannot decide where a
 * value came from, so it is not asked to any more.
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

describe('the CLI hands the detail block its stored values unrendered', () => {
  it('passes the target and proposer straight off the row', () => {
    // Pre-sanitising either one here would not be safer, it would be worse:
    // the block compares what it was given against what it can print to decide
    // whether to warn, so a value cleaned on the way in is a value it reports
    // as clean.
    expect(CONFIRM).toContain('to: tx.safeTx.data.to,')
    expect(CONFIRM).toContain('proposer: tx.proposer,')
  })

  it('builds the block in one place and prints what it returns', () => {
    expect(CONFIRM).toContain('const detailLines = buildSafeTxDetailLines({')
    expect(CONFIRM).toContain("consola.info(detailLines.join('\\n'))")
    // An inline push would add a line without passing through the builder.
    expect(CONFIRM).not.toContain('detailLines.push')
  })

  it('prints the parsed nonce in the mismatch warnings', () => {
    // Those warnings are outside the block. `txNonce` is a `bigint`, so no
    // string can reach them at all — the compiler holds this one, and this
    // assertion only catches the field being swapped back in wholesale.
    // eslint-disable-next-line no-template-curly-in-string -- a source pattern, not a template
    expect(CONFIRM).not.toContain('${tx.safeTx.data.nonce}')
    expect(CONFIRM).toContain('const txNonce = BigInt(tx.safeTx.data.nonce)')
  })
})
