/**
 * Where zone 3 is rendered inside `confirm-safe-tx.ts` — not what it says.
 *
 * What it says is driven for real in `signer-view.test.ts`. The script itself
 * cannot be driven: `confirm-safe-tx.ts` calls `runMain` at module scope, and
 * reaching its signer view needs MongoDB, a Safe and a Ledger. So the wiring is
 * asserted on the source, the way `signer-manifest-placement.test.ts` does.
 *
 * Three regressions this is shaped to fail, all of which leave every unit test
 * green:
 *
 * - printing the checklist back on the decision screen, which is the thirty
 *   lines of device art between zone 2 and the prompt that moving it removed;
 * - printing it before the nonce and expected-state interlocks, which `continue`
 *   past the device entirely — instructions for a step the run will not reach;
 * - dropping the guard, which puts the device screens in front of a signer who
 *   chose to broadcast rather than sign.
 *
 * Anchored on call expressions and on the guard's identifier, never on a
 * rendered string.
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
  isIfStatement,
  isPropertyAccessExpression,
  ScriptTarget,
  type Node,
  type SourceFile,
} from 'typescript'

const SPINE = join(__dirname, 'confirm-safe-tx.ts')

/**
 * Every call to a named function, as the character offset it starts at.
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

/**
 * Every call to `object.method(...)`, as the offset it starts at.
 *
 * The action prompt is `consola.prompt`, which is a property access rather than
 * a bare identifier and so is invisible to `callOffsets`.
 *
 * @param source - The parsed spine.
 * @param object - The receiver's name.
 * @param method - The method's name.
 * @returns One offset per call site, ascending.
 */
const methodCallOffsets = (
  source: SourceFile,
  object: string,
  method: string
): number[] => {
  const found: number[] = []
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === object &&
      node.expression.name.text === method
    )
      found.push(node.getStart(source))
    forEachChild(node, visit)
  }
  forEachChild(source, visit)
  return found.sort((left, right) => left - right)
}

/**
 * The span of the `if` statement whose condition calls `callee`.
 *
 * @param source - The parsed spine.
 * @param callee - The guard function named in the condition.
 * @returns Start and end offsets, or undefined when there is no such guard.
 */
const guardSpan = (
  source: SourceFile,
  callee: string
): { start: number; end: number } | undefined => {
  let span: { start: number; end: number } | undefined
  const visit = (node: Node): void => {
    if (
      isIfStatement(node) &&
      callOffsets(
        createSourceFile(
          'cond.ts',
          node.expression.getText(source),
          ScriptTarget.Latest,
          true
        ),
        callee
      ).length > 0
    )
      span ??= { start: node.getStart(source), end: node.getEnd() }
    forEachChild(node, visit)
  }
  forEachChild(source, visit)
  return span
}

const parse = (text: string): SourceFile =>
  createSourceFile('confirm-safe-tx.ts', text, ScriptTarget.Latest, true)

describe('zone 3 reaches the signer at the device, not at the prompt', () => {
  const text = readFileSync(SPINE, 'utf8')
  const source = parse(text)

  it('renders the placeholder in zone 3s slot and the checklist exactly once', () => {
    expect(callOffsets(source, 'renderDeferredTodos')).toHaveLength(1)
    expect(callOffsets(source, 'renderTodos')).toHaveLength(1)
  })

  it('puts the placeholder before the action prompt and the checklist after it', () => {
    const prompt = methodCallOffsets(source, 'consola', 'prompt')[0]
    const placeholder = callOffsets(source, 'renderDeferredTodos')[0] as number
    const todos = callOffsets(source, 'renderTodos')[0] as number
    expect(prompt).toBeDefined()
    expect(placeholder).toBeLessThan(prompt as number)
    expect(todos).toBeGreaterThan(prompt as number)
  })

  it('renders the checklist after the interlocks that can still end the run', () => {
    const todos = callOffsets(source, 'renderTodos')[0] as number
    // The acknowledgement is written once every `continue` above it has been
    // passed, so it is the cheapest single anchor for "no interlock remains".
    const acknowledged = callOffsets(source, 'recordAcknowledgement')[0]
    expect(acknowledged).toBeDefined()
    expect(todos).toBeGreaterThan(acknowledged as number)
  })

  it('renders the checklist before anything signs', () => {
    const todos = callOffsets(source, 'renderTodos')[0] as number
    const signs = callOffsets(source, 'signTransaction')
    // The declaration of the gated signer is itself a call, and it sits far
    // above; what matters is that every *invocation* in the proposal loop is
    // below zone 3.
    const invocations = signs.filter(
      (offset) => offset > (acknowledgeStart(source) as number)
    )
    expect(invocations.length).toBeGreaterThan(0)
    for (const offset of invocations) expect(offset).toBeGreaterThan(todos)
  })

  it('guards the checklist on the action opening a device screen', () => {
    const span = guardSpan(source, 'opensDeviceScreens')
    const todos = callOffsets(source, 'renderTodos')[0] as number
    expect(span).toBeDefined()
    expect(todos).toBeGreaterThan((span as { start: number }).start)
    expect(todos).toBeLessThan((span as { end: number }).end)
  })

  describe('falsification — the assertions fail on the regressions they name', () => {
    it('fails when the checklist goes back above the prompt', () => {
      // The whole guarded block hoisted to where the placeholder stands.
      const span = guardSpan(source, 'opensDeviceScreens') as {
        start: number
        end: number
      }
      const block = text.slice(span.start, span.end)
      const hoisted = parse(
        text
          .slice(0, span.start)
          .replace(
            'consola.log(renderDeferredTodos().join',
            `${block}\nconsola.log(renderDeferredTodos().join`
          ) + text.slice(span.end)
      )
      const prompt = methodCallOffsets(
        hoisted,
        'consola',
        'prompt'
      )[0] as number
      const todos = callOffsets(hoisted, 'renderTodos')[0] as number
      expect(todos).toBeLessThan(prompt)
    })

    it('fails when the guard is dropped', () => {
      const ungated = parse(text.replace(/opensDeviceScreens\(/gu, 'always('))
      expect(guardSpan(ungated, 'opensDeviceScreens')).toBeUndefined()
    })

    it('fails when the checklist is deleted', () => {
      const without = parse(text.replace(/renderTodos\(/gu, 'noRender('))
      expect(callOffsets(without, 'renderTodos')).toHaveLength(0)
    })
  })
})

/**
 * Where the proposal loop's acknowledgement is written.
 *
 * @param source - The parsed spine.
 * @returns The offset, or undefined when the call is gone.
 */
function acknowledgeStart(source: SourceFile): number | undefined {
  return callOffsets(source, 'recordAcknowledgement')[0]
}
