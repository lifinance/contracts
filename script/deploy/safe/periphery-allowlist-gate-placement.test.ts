/** Pins gate W's position in `confirm-safe-tx.ts` from its source, since that CLI signs and cannot be spawned from a test. */
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
import {
  createSourceFile,
  forEachChild,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionLike,
  isIdentifier,
  isIfStatement,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteralLike,
  isVariableDeclaration,
  ScriptTarget,
  type CallExpression,
  type Identifier,
  type IfStatement,
  type Node,
  type SourceFile,
} from 'typescript'

const CONFIRM_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'confirm-safe-tx.ts'
)

const GATE = 'if (!peripheryAllowlist.cleared) {'
const GATE_H = 'if (!targetState.cleared) {'
const EVALUATION = 'peripheryAllowlist = await evaluatePeripheryAllowlist('
const ACKNOWLEDGEMENT_RECORDED =
  'recordAcknowledgement(acknowledgementLedger, {'
const ACTION_PROMPT = "consola.prompt('Select action:'"

const IRREVERSIBLE_CALLEES: ReadonlySet<string> = new Set([
  'signTransaction',
  'executeTransaction',
])

const calleeName = (call: CallExpression): string | undefined => {
  const callee = call.expression
  if (isIdentifier(callee)) return callee.text
  if (isPropertyAccessExpression(callee)) return callee.name.text
  if (
    isElementAccessExpression(callee) &&
    isStringLiteralLike(callee.argumentExpression)
  )
    return callee.argumentExpression.text
  return undefined
}

const parse = (text: string): SourceFile =>
  createSourceFile(CONFIRM_SCRIPT, text, ScriptTarget.Latest, true)

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1)
  const [item] = items
  if (item === undefined) throw new Error('expected exactly one match')
  return item
}

const nodesOf = <T extends Node>(
  tree: SourceFile,
  keep: (node: Node) => node is T
): T[] => {
  const found: T[] = []
  const visit = (node: Node): void => {
    if (keep(node)) found.push(node)
    forEachChild(node, visit)
  }
  forEachChild(tree, visit)
  return found
}

const callsNamed = (tree: SourceFile, name: string): CallExpression[] =>
  nodesOf(
    tree,
    (node): node is CallExpression =>
      isCallExpression(node) && calleeName(node) === name
  )

const statementOf = (node: Node): Node => {
  let at = node
  while (!isBlock(at.parent)) at = at.parent
  return at
}

const enclosingFunction = (node: Node): Node | undefined => {
  for (let at = node.parent; at; at = at.parent)
    if (isFunctionLike(at)) return at
  return undefined
}

describe('gate W placement in confirm-safe-tx', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(CONFIRM_SCRIPT, 'utf8')
  })

  it('skips the proposal as blocked rather than proceeding', () => {
    const at = source.indexOf(GATE)
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('\n    }', at)
    expect(end).toBeGreaterThan(at)
    const block = source.slice(at, end)
    expect(block).toContain('renderPeripheryAllowlistRefusal(')
    expect(block).toContain('recordProposalOutcome({ blocked: true })')
    expect(block).toContain('continue')
    expect(block).not.toContain('signTransaction')
  })

  it('is evaluated before the checks are graded and the prompt is drawn', () => {
    const evaluated = source.indexOf(EVALUATION)
    expect(evaluated).toBeGreaterThan(-1)
    expect(evaluated).toBeLessThan(source.indexOf('proposalCheckResults({'))
    expect(evaluated).toBeLessThan(source.indexOf(ACTION_PROMPT))
  })

  it('hands the ledger the verdict the refusal acts on', () => {
    const at = source.indexOf('proposalCheckResults({')
    expect(at).toBeGreaterThan(-1)
    const end = source.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const call = source.slice(at, end)
    expect(call).toContain('peripheryAllowlist,')
  })

  it('prints its findings under the row, once', () => {
    expect(source).toContain(
      'renderPeripheryAllowlistLines(peripheryAllowlist)'
    )
    expect(source.split('renderPeripheryAllowlistLines(').length - 1).toBe(1)
  })

  it('sits after gate H, which it must not swallow', () => {
    expect(source.indexOf(GATE_H)).toBeGreaterThan(-1)
    expect(source.indexOf(GATE)).toBeGreaterThan(source.indexOf(GATE_H))
  })

  it('sits before the acknowledgement is recorded', () => {
    expect(source.indexOf(GATE)).toBeLessThan(
      source.indexOf(ACKNOWLEDGEMENT_RECORDED)
    )
  })

  it('sits before the action dispatch, in the same loop body', () => {
    const tree = parse(source)
    const gate = only(
      nodesOf(
        tree,
        (node): node is IfStatement =>
          isIfStatement(node) &&
          node.expression.getText(tree) === '!peripheryAllowlist.cleared'
      )
    )
    const dispatch = statementOf(only(callsNamed(tree, 'runAction')))
    expect(gate.parent).toBe(dispatch.parent)
    expect(gate.getEnd()).toBeLessThanOrEqual(dispatch.getStart(tree))
  })

  it('leaves the dispatch as the only route to a signature or broadcast', () => {
    const tree = parse(source)

    const factory = only(callsNamed(tree, 'createSigningFunnels'))
    const binding = factory.parent
    if (
      !isVariableDeclaration(binding) ||
      !isObjectBindingPattern(binding.name)
    )
      throw new Error('createSigningFunnels must be destructured')
    expect(
      binding.name.elements.map((element) => [
        element.propertyName?.getText(tree),
        element.name.getText(tree),
      ])
    ).toEqual([[undefined, 'runAction']])

    // The one primitive the script owns is the broadcast body it injects.
    const irreversible = nodesOf(
      tree,
      (node): node is CallExpression =>
        isCallExpression(node) &&
        IRREVERSIBLE_CALLEES.has(calleeName(node) ?? '')
    )
    expect(irreversible.map((call) => call.expression.getText(tree))).toEqual([
      'safeClient.executeTransaction',
    ])
    const owner = enclosingFunction(only(irreversible))
    expect(owner && isFunctionDeclaration(owner) && owner.name?.text).toBe(
      'broadcastSafeTransaction'
    )
    const injected = only(
      nodesOf(
        tree,
        (node): node is Identifier =>
          isIdentifier(node) && node.text === 'broadcastSafeTransaction'
      ).filter((use) => use.parent !== owner)
    ).parent
    expect(isPropertyAssignment(injected) && injected.name.getText(tree)).toBe(
      'broadcast'
    )
    expect(injected.parent.parent).toBe(factory)
  })
})
