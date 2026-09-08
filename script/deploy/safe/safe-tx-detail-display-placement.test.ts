/**
 * Where the detail block is built, not what it renders —
 * `safe-tx-detail-display.test.ts` covers the rendering by executing it.
 *
 * `confirm-safe-tx.ts` cannot be imported as the CLI (`runMain` at module
 * scope), so placement is asserted on the source, shaped so a field added back
 * into a colour code raw fails the suite.
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

/**
 * A stored field interpolated directly inside an SGR colour code — the shape
 * that lets a row's own content recolour or repaint the line printing it.
 *
 * Matches the escape as the source spells it and as a literal ESC byte, so
 * switching spelling does not slip past.
 */
// eslint-disable-next-line no-control-regex -- matching the escape sequences is the point
const RAW_IN_COLOUR = /(?:\\u001b|\u001b)\[[^\]]{0,20}?m\$\{\s*(tx\.[^}]*)\}/gs

const storedFieldsInColour = (source: string): string[] =>
  [...source.matchAll(RAW_IN_COLOUR)].map((match) => match[1] ?? '')

describe('the signing prompt builds its detail block through the sanitiser', () => {
  it('prints the array the builder returns, and builds it nowhere else', () => {
    expect(CONFIRM).toContain('const detailLines = buildSafeTxDetailLines({')
    expect(CONFIRM).toContain("consola.info(detailLines.join('\\n'))")
    // An inline `detailLines.push` would put a line into the block without
    // passing through the builder.
    expect(CONFIRM).not.toContain('detailLines.push')
  })

  it('leaves no stored field but the nonce inside a colour code', () => {
    // The nonce is the one exemption: `BigInt(tx.safeTx.data.nonce)` runs
    // unwrapped earlier in the same loop, so a row whose nonce is not numeric
    // throws before any of these lines is reached.
    expect(CONFIRM).toContain('const txNonce = BigInt(tx.safeTx.data.nonce)')
    expect(
      CONFIRM.indexOf('const txNonce = BigInt(tx.safeTx.data.nonce)')
    ).toBeLessThan(CONFIRM.lastIndexOf('${tx.safeTx.data.nonce}'))

    for (const field of storedFieldsInColour(CONFIRM))
      expect(field).toBe('tx.safeTx.data.nonce')
  })

  it('flags the shape it exists to catch', () => {
    // Without this the rule above passes on a file that simply stopped using
    // template literals, which is the same bug wearing a different syntax.
    const reintroduced = [
      '`    Data:            \\u001b[32m${tx.safeTx.data.data}\\u001b[0m`',
      '`    Safe Tx Hash:    \\u001b[36m${tx.safeTxHash}\\u001b[0m`',
    ].join('\n')

    expect(storedFieldsInColour(reintroduced)).toEqual([
      'tx.safeTx.data.data',
      'tx.safeTxHash',
    ])
  })
})
