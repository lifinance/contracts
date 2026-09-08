/**
 * A smoke check on the shape of one call. It proves nothing about safety.
 *
 * Read that literally. The positive assertions are `toContain` over the file's
 * text, which a comment anywhere in the file satisfies and a spread override
 * defeats — measured, not supposed. They catch an accidental rewrite and an
 * adversary walks past them.
 *
 * The `not.toContain` pair is the half worth keeping: it fails conservatively,
 * catching an inline `detailLines.push` or the raw nonce being interpolated
 * again. Its cost is the mirror image — a comment or string literal elsewhere
 * in `confirm-safe-tx.ts` that merely mentions either turns this suite red for
 * no behavioural reason.
 *
 * The property that matters — no stored value reaches a printed line
 * unsanitised — is held by `buildSafeTxDetailLines`, which takes every stored
 * value unrendered and is exercised directly in
 * `safe-tx-detail-display.test.ts`. That is the file to read and to extend.
 * `confirm-safe-tx.ts` is a CLI with `runMain` at module scope and cannot be
 * imported, which is why the composition was moved out of it rather than
 * scanned inside it.
 *
 * Three versions of this file tried to prove the property by scanning, and all
 * three were defeated by rewrites that changed no behaviour: a
 * `const d = tx.safeTx.data` alias, an `includes` exclusion a trailing comment
 * satisfied, bracket access, optional chaining, concatenation, a `}` inside a
 * string literal. A scanner cannot decide where a value came from.
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

describe('smoke check: the shape of the call into the detail block', () => {
  it('appears to pass the target and proposer straight off the row', () => {
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
