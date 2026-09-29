/**
 * Where `confirm-safe-tx.ts` remembers that gate J's paragraph is already on
 * the screen — not what the pointer says.
 *
 * What it says is driven for real in `signer-zones.test.ts`. The spine cannot
 * be driven at all (`runMain` at module scope; MongoDB, a Safe and a Ledger to
 * reach zone 2), so the wiring is asserted on the source.
 *
 * Three regressions this is shaped to fail, each of which leaves every unit
 * test green:
 *
 * - dropping the state from the `signerChecks` call, which prints the same
 *   paragraph under every proposal on a network again;
 * - declaring the state inside the proposal loop, where it is fresh on every
 *   proposal and never says "shown";
 * - marking it before the grouped sections render, which points the first
 *   proposal at a paragraph that is not on the screen.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import {
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isCallExpression,
  isForOfStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isVariableDeclaration,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile,
} from 'typescript'

const SPINE = join(__dirname, 'confirm-safe-tx.ts')
const STATE = 'shownRpcQuorum'
const INPUT = 'rpcQuorumShown'

const parse = (text: string): SourceFile =>
  createSourceFile('confirm-safe-tx.ts', text, ScriptTarget.Latest, true)

const walk = (source: SourceFile, visit: (node: Node) => void): void => {
  const step = (node: Node): void => {
    visit(node)
    forEachChild(node, step)
  }
  forEachChild(source, step)
}

const callOffsets = (source: SourceFile, callee: string): number[] => {
  const found: number[] = []
  walk(source, (node) => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === callee
    )
      found.push(node.getStart(source))
  })
  return found.sort((left, right) => left - right)
}

/** The property names the one `signerChecks` call passes in its argument. */
const signerChecksInputs = (source: SourceFile): string[] => {
  const names: string[] = []
  walk(source, (node) => {
    if (
      !isCallExpression(node) ||
      !isIdentifier(node.expression) ||
      node.expression.text !== 'signerChecks'
    )
      return
    const [argument] = node.arguments
    if (argument && isObjectLiteralExpression(argument))
      for (const property of argument.properties)
        if (property.name && isIdentifier(property.name))
          names.push(property.name.text)
  })
  return names
}

const declarationOffset = (source: SourceFile): number | undefined => {
  let offset: number | undefined
  walk(source, (node) => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === STATE
    )
      offset ??= node.getStart(source)
  })
  return offset
}

/** Where the proposal loop opens: the one `for … of initialTxs`. */
const loopOffset = (source: SourceFile): number | undefined => {
  let offset: number | undefined
  walk(source, (node) => {
    if (
      isForOfStatement(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'initialTxs'
    )
      offset ??= node.getStart(source)
  })
  return offset
}

/** Where the state is set: assignments whose left side is the state. */
const markOffsets = (source: SourceFile): number[] => {
  const found: number[] = []
  walk(source, (node) => {
    if (
      isBinaryExpression(node) &&
      isIdentifier(node.left) &&
      node.left.text === STATE &&
      (node.operatorToken.kind === SyntaxKind.EqualsToken ||
        node.operatorToken.kind === SyntaxKind.QuestionQuestionEqualsToken)
    )
      found.push(node.getStart(source))
  })
  return found.sort((left, right) => left - right)
}

describe("gate J's paragraph is printed once per network", () => {
  const text = readFileSync(SPINE, 'utf8')
  const source = parse(text)

  it('hands signerChecks the state, on the one call that builds the rows', () => {
    expect(callOffsets(source, 'signerChecks')).toHaveLength(1)
    expect(signerChecksInputs(source)).toContain(INPUT)
  })

  it('declares the state once per network, before the proposal loop', () => {
    const declared = declarationOffset(source)
    const loop = loopOffset(source)
    expect(declared).toBeDefined()
    expect(loop).toBeDefined()
    expect(declared as number).toBeLessThan(loop as number)
  })

  it('marks the state inside the loop, after the grouped sections render', () => {
    const marks = markOffsets(source)
    const groups = callOffsets(source, 'renderCheckGroups')[0]
    const loop = loopOffset(source)
    expect(marks).toHaveLength(1)
    expect(groups).toBeDefined()
    expect(marks[0] as number).toBeGreaterThan(groups as number)
    expect(marks[0] as number).toBeGreaterThan(loop as number)
  })

  describe('falsification — the assertions fail on the regressions they name', () => {
    it('fails when the state is no longer passed', () => {
      const without = parse(
        text.replace(new RegExp(`${INPUT}: ${STATE},?`, 'gu'), '')
      )
      expect(callOffsets(without, 'signerChecks')).toHaveLength(1)
      expect(signerChecksInputs(without)).not.toContain(INPUT)
    })

    it('fails when the state is declared inside the loop', () => {
      const declaration = /^.*let shownRpcQuorum[^\n]*\n/mu.exec(text)?.[0]
      expect(declaration).toBeDefined()
      const loopHead = /for \(const tx of initialTxs\) \{\n/u.exec(text)?.[0]
      expect(loopHead).toBeDefined()
      const moved = parse(
        text
          .replace(declaration as string, '')
          .replace(
            loopHead as string,
            `${loopHead as string}${declaration as string}`
          )
      )
      expect(declarationOffset(moved) as number).toBeGreaterThan(
        loopOffset(moved) as number
      )
    })

    it('fails when the state is marked before the sections render', () => {
      const mark = /^.*shownRpcQuorum \?\?=[^\n]*\n/mu.exec(text)?.[0]
      expect(mark).toBeDefined()
      const groups = /^.*consola\.log\(renderCheckGroups\([^\n]*\n/mu.exec(
        text
      )?.[0]
      expect(groups).toBeDefined()
      const early = parse(
        text
          .replace(mark as string, '')
          .replace(groups as string, `${mark as string}${groups as string}`)
      )
      expect(markOffsets(early)[0] as number).toBeLessThan(
        callOffsets(early, 'renderCheckGroups')[0] as number
      )
    })
  })
})
