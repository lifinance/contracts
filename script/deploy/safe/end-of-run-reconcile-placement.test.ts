/**
 * Where the end-of-run reconcile sits inside `confirm-safe-tx.ts`, not what it
 * decides — `reconcile.test.ts` drives `reconcileRunSubmissions` for real.
 *
 * `confirm-safe-tx.ts` calls `runMain` at module scope, so importing it runs the
 * CLI; the placement is asserted on the parsed source instead. It fails when
 * the pass is moved out of the `finally` that guards the network loop (a loop
 * that throws after broadcasting would then exit without queuing the timelock
 * op), or when the executor's no-receipt branch stops recording the submission.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isForStatement,
  isIdentifier,
  isPropertyAccessExpression,
  isTryStatement,
  ScriptTarget,
  type Node,
  type TryStatement,
} from 'typescript'

const SOURCE = readFileSync(join(import.meta.dir, 'confirm-safe-tx.ts'), 'utf8')
const TREE = createSourceFile(
  'confirm-safe-tx.ts',
  SOURCE,
  ScriptTarget.Latest,
  true
)

const findAll = (root: Node, match: (node: Node) => boolean): Node[] => {
  const found: Node[] = []
  const visit = (node: Node): void => {
    if (match(node)) found.push(node)
    forEachChild(node, visit)
  }
  visit(root)
  return found
}

const callsTo = (root: Node, name: string): Node[] =>
  findAll(
    root,
    (node) =>
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === name
  )

const enclosingTry = (node: Node): TryStatement | undefined => {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (isTryStatement(parent) && parent.tryBlock.pos <= node.pos)
      if (node.end <= parent.tryBlock.end) return parent
  return undefined
}

describe('end-of-run reconcile placement in confirm-safe-tx', () => {
  it('runs in the finally of the try that holds the network loop', () => {
    const [networkLoop, ...others] = findAll(
      TREE,
      (node) =>
        isForStatement(node) &&
        (node.condition?.getText(TREE) ?? '') === 'i < networks.length'
    )
    expect(networkLoop).toBeDefined()
    expect(others).toHaveLength(0)

    const guard = enclosingTry(networkLoop as Node)
    expect(guard?.finallyBlock).toBeDefined()
    const finallyBlock = guard?.finallyBlock as Node

    expect(callsTo(finallyBlock, 'settleRunSubmissions')).toHaveLength(1)
    expect(callsTo(TREE, 'settleRunSubmissions')).toHaveLength(1)

    // The pass needs the connection, so the close must follow it.
    const settle = callsTo(finallyBlock, 'settleRunSubmissions')[0] as Node
    const closes = findAll(
      finallyBlock,
      (node) =>
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        node.expression.getText(TREE) === 'mongoClient.close'
    )
    expect(closes).toHaveLength(1)
    expect((closes[0] as Node).pos).toBeGreaterThan(settle.end)
  })

  it('records a submission where the executor saw no receipt', () => {
    const pushes = findAll(
      TREE,
      (node) =>
        isCallExpression(node) &&
        node.expression.getText(TREE) === 'runSubmissions.push'
    )
    expect(pushes).toHaveLength(1)
  })
})
