/**
 * Where the signing prompt's values come from, not what they render to —
 * `safe-tx-detail-display.test.ts` covers the rendering by executing it.
 *
 * `confirm-safe-tx.ts` cannot be imported as the CLI (`runMain` at module
 * scope), so this is asserted on the source. The rule is deliberately not
 * "no stored field inside a colour code": a value that rewinds a line does so
 * wherever it is printed, and the parked-cleanup fields are reached through
 * `ref.` rather than `tx.`, so a colour-code rule keyed on one receiver would
 * not see them.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

/* eslint-disable no-template-curly-in-string -- every `${...}` below is a source pattern this file matches, never a template of its own */

const CONFIRM = readFileSync(
  join(import.meta.dir, 'confirm-safe-tx.ts'),
  'utf8'
)

/** Receivers carrying a value read out of the stored proposal row. */
const STORED_RECEIVER =
  /\b(?:tx\.|ref\.|proposerDisplay|toDisplay|toAddrDisplay)/u

/**
 * Every `${...}` in the source, brace-counted rather than pattern-matched, so
 * an expression containing a nested template literal is still seen whole.
 */
function interpolations(source: string): string[] {
  const found: string[] = []
  for (let i = 0; i < source.length - 1; i++) {
    if (source[i] !== '$' || source[i + 1] !== '{') continue
    let depth = 1
    let j = i + 2
    for (; j < source.length && depth > 0; j++)
      if (source[j] === '{') depth++
      else if (source[j] === '}') depth--
    if (depth === 0) found.push(source.slice(i + 2, j - 1))
  }
  return found
}

const storedInterpolations = (source: string): string[] =>
  interpolations(source)
    .filter((expression) => STORED_RECEIVER.test(expression))
    .map((expression) => expression.replace(/\s+/gu, ' ').trim())

/**
 * The only stored values allowed to reach a printed line without going through
 * `buildSafeTxDetailLines`. Both are sanitised before they get here, and the
 * assertions below pin that rather than take it on trust.
 */
const ALLOWED = [
  'describeOperationValue( tx.safeTransaction.data.operation )',
  'toAddrDisplay',
]

describe('the signing prompt prints no stored value it has not sanitised', () => {
  it('interpolates only the stored expressions that are already safe', () => {
    expect(storedInterpolations(CONFIRM).sort()).toEqual([...ALLOWED].sort())
  })

  it('sanitises the target and proposer addresses before rendering them', () => {
    expect(CONFIRM).toContain(
      'const toAddress = sanitizeProvenanceText(tx.safeTx.data.to) as Address'
    )
    expect(CONFIRM).toContain(
      'const proposerAddress = sanitizeProvenanceText(tx.proposer) as Address'
    )
    // Every other read of those two fields would be a second, ungated route.
    for (const raw of ['tx.safeTx.data.to', 'tx.proposer'])
      expect(
        CONFIRM.split('\n').filter(
          (line) =>
            line.includes(raw) && !line.includes('sanitizeProvenanceText')
        )
      ).toEqual([])
  })

  it('prints the parsed nonce, never the stored string', () => {
    // `BigInt()` skips whitespace instead of refusing it — `BigInt('31\r')` is
    // 31n — so having been parsed does not make the stored string safe.
    expect(CONFIRM).not.toContain('${tx.safeTx.data.nonce}')
    expect(CONFIRM).toContain('const txNonce = BigInt(tx.safeTx.data.nonce)')
  })

  it('builds the detail block in one place and prints what it returns', () => {
    expect(CONFIRM).toContain('const detailLines = buildSafeTxDetailLines({')
    expect(CONFIRM).toContain("consola.info(detailLines.join('\\n'))")
    // An inline push would add a line without passing through the builder.
    expect(CONFIRM).not.toContain('detailLines.push')
  })

  it('flags every shape it exists to catch', () => {
    // Each of these passed the colour-code rule this replaced. Without them
    // the suite cannot tell a rule that holds from one that matches nothing.
    const reintroduced = [
      '`    Data:            \\u001b[32m${tx.safeTx.data.data}\\u001b[0m`',
      '`        ${GREEN}${ref.facet}${RESET} → ${CYAN}${ref.prUrl}${RESET}`',
      '`  Nonce ${tx.safeTx.data.nonce} was already used`',
      '`${nested ? `${tx.safeTxHash}` : ""}`',
      '`    Proposer:        ${proposerDisplay}`',
    ].join('\n')

    expect(storedInterpolations(reintroduced)).toEqual([
      'tx.safeTx.data.data',
      'ref.facet',
      'ref.prUrl',
      'tx.safeTx.data.nonce',
      'nested ? `${tx.safeTxHash}` : ""',
      // The scanner reports the inner interpolation too, so nesting hides
      // nothing from it.
      'tx.safeTxHash',
      'proposerDisplay',
    ])
  })
})
