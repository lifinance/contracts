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
  it('appears to pass the target straight off the row', () => {
    // Pre-sanitising it here would not be safer, it would be worse: the block
    // compares what it was given against what it can print to decide whether to
    // warn, so a value cleaned on the way in is a value it reports as clean.
    //
    // The proposer used to be passed the same way. Zone 1 no longer renders it:
    // gate C grades the stored signatures against the owner set, which is the
    // question the address was standing in for.
    expect(CONFIRM).toContain('to: tx.safeTx.data.to,')
    expect(CONFIRM).not.toContain('proposer: tx.proposer,')
  })

  it('builds the block in one place and prints what it returns', () => {
    // One input object, read by the block and by the footnote that closes it:
    // two literals would let the two halves of the zone describe different
    // proposals, which is the failure the shared const exists to prevent.
    expect(CONFIRM).toContain('const detailInput: ISafeTxDetailInput = {')
    // `log`, not `info`: consola's level prefix lands on the first line of a
    // multi-line string and shifts that line alone out of the block's column.
    expect(CONFIRM).toContain(
      "consola.log(buildSafeTxDetailLines(detailInput).join('\\n'))"
    )
    expect(CONFIRM).toContain(
      "consola.log(buildCalldataFootnote(detailInput).join('\\n'))"
    )
    // An inline push would add a line without passing through the builder.
    expect(CONFIRM).not.toContain('detailLines.push')
  })

  it('closes the comparison after the decode, not before it', () => {
    // The question is the point of the two blocks above it; printed before the
    // decoded calldata it asks the signer to compare something not yet shown.
    const decode = CONFIRM.indexOf('formatDecodedTxDataForDisplay(')
    const footnote = CONFIRM.indexOf('buildCalldataFootnote(detailInput)')
    const question = CONFIRM.indexOf("CLAIM_QUESTION.join('\\n')")

    expect(decode).toBeGreaterThan(-1)
    expect(footnote).toBeGreaterThan(decode)
    expect(question).toBeGreaterThan(footnote)
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
