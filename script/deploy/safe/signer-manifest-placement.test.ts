/**
 * Where the gate manifest is rendered inside `confirm-safe-tx.ts` — not what it
 * says.
 *
 * What it says is driven for real in `signer-view.test.ts`. What cannot be
 * driven at all is the script: `confirm-safe-tx.ts` calls `runMain` at module
 * scope, so importing it runs the CLI, and reaching its signer view needs
 * MongoDB, a Safe and a Ledger. So the wiring is asserted on the source.
 *
 * Two regressions this is shaped to fail, both of which leave every unit test
 * green:
 *
 * - deleting the call, which puts the signer back in front of a screen that
 *   lists the checks that reported and cannot say which ones did not;
 * - rendering it *after* the grouped sections, where the roster stops being the
 *   thing read first and becomes a footnote under the wall it exists to frame.
 *
 * Anchored on the call expressions, never on a rendered string: a display
 * literal is reworded for reasons that have nothing to do with the wiring.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  ScriptTarget,
  type Node,
  type SourceFile,
} from 'typescript'

const SPINE = join(__dirname, 'confirm-safe-tx.ts')

/**
 * Every call to a named function, as the character offset it starts at.
 *
 * Offsets rather than an array index, so "is A before B" is answered by the
 * source positions and not by the order a traversal happened to visit them in.
 *
 * @param source - The parsed spine.
 * @param callee - The function name to find.
 * @returns One offset per call site, ascending.
 */
const callOffsets = (source: SourceFile, callee: string): number[] => {
  const found: number[] = []
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === callee
    )
      found.push(node.getStart(source))
    forEachChild(node, visit)
  }
  forEachChild(source, visit)
  return found.sort((left, right) => left - right)
}

const parse = (text: string): SourceFile =>
  createSourceFile('confirm-safe-tx.ts', text, ScriptTarget.Latest, true)

describe('the gate manifest reaches the signer', () => {
  const text = readFileSync(SPINE, 'utf8')
  const source = parse(text)

  it('is rendered by the spine', () => {
    expect(callOffsets(source, 'renderGateManifest')).toHaveLength(1)
  })

  it('is rendered before the grouped sections', () => {
    const manifest = callOffsets(source, 'renderGateManifest')[0]
    const groups = callOffsets(source, 'renderCheckGroups')[0]
    expect(manifest).toBeDefined()
    expect(groups).toBeDefined()
    expect(manifest as number).toBeLessThan(groups as number)
  })

  it('is handed the whole roster, not only the checks that reported', () => {
    // `ALL_GATE_DEFINITIONS` is the roster including the gates with a letter and
    // no ledger denominator; `CONFIRM_CHECK_DEFINITIONS` is the subset that owes
    // a result. Passing the results as the roster would make the manifest agree
    // with the sections about what exists, which is the hole it closes.
    const call = text.slice(
      callOffsets(source, 'renderGateManifest')[0] as number
    )
    const args = call.slice(0, call.indexOf('})') + 2)
    expect(args).toContain('ALL_GATE_DEFINITIONS')
    expect(args).toContain('CONFIRM_CHECK_DEFINITIONS')
  })

  describe('falsification — the assertions fail on the regressions they name', () => {
    it('fails when the call is deleted', () => {
      const without = parse(text.replace(/renderGateManifest\(/gu, 'noRender('))
      expect(callOffsets(without, 'renderGateManifest')).toHaveLength(0)
    })

    it('fails when the manifest is moved after the sections', () => {
      // The two calls swapped, which is the reordering the second assertion
      // exists to catch and which no unit test would notice.
      const swapped = parse(
        text
          .replace(/renderGateManifest\(/gu, '__FIRST__(')
          .replace(/renderCheckGroups\(/gu, 'renderGateManifest(')
          .replace(/__FIRST__\(/gu, 'renderCheckGroups(')
      )
      const manifest = callOffsets(swapped, 'renderGateManifest')[0] as number
      const groups = callOffsets(swapped, 'renderCheckGroups')[0] as number
      expect(manifest).toBeGreaterThan(groups)
    })
  })
})
