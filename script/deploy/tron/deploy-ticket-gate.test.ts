/**
 * Where the Tron deploy-and-register scripts check the proposal ticket: before
 * the build and before any deploy, so a run without one stops before it spends
 * TRX on a contract whose proposal would then be refused.
 *
 * Read from the source rather than by spawning the scripts: every one imports
 * the generated typechain bindings, which CI does not build, so a spawned
 * script cannot load there. The check is positional, so the AST answers it.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import ts from 'typescript'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const SCRIPTS = [
  'deploy-and-register-allbridge-facet.ts',
  'deploy-and-register-eco-facet.ts',
  'deploy-and-register-layerswap-facet.ts',
  'deploy-and-register-lifi-intent-escrow-facet-v2.ts',
  'deploy-and-register-near-intents-facet.ts',
  'deploy-and-register-symbiosis-facet.ts',
  'deploy-and-register-periphery.ts',
]

/** Calls that spend TRX or come before anything that does. */
const SPENDING_CALLS = [
  'buildForgeArtifactsOrThrow',
  'deployContractWithLogging',
]

interface ICall {
  name: string
  position: number
  /** The `if` condition that guards the call, when it is an `if`'s statement. */
  guard?: string
}

const callsIn = (script: string): ICall[] => {
  const path = join(import.meta.dir, script)
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const calls: ICall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const statement = node.parent?.parent
      const guard =
        statement && ts.isIfStatement(statement)
          ? statement.expression.getText(source)
          : undefined
      calls.push({
        name: node.expression.text,
        position: node.getStart(source),
        ...(guard === undefined ? {} : { guard }),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

describe('Tron deploy-and-register scripts check the ticket first', () => {
  it.each(SCRIPTS)(
    '%s checks the ticket, except on a dry run, before it builds or deploys',
    (script) => {
      const calls = callsIn(script)
      const gates = calls.filter((c) => c.name === 'assertTicketPresent')

      expect(gates).toHaveLength(1)
      const gate = gates[0] as ICall
      expect(gate.guard).toMatch(/^!(options\.)?dryRun\b/)

      const spending = calls.filter((c) => SPENDING_CALLS.includes(c.name))
      expect(spending.length).toBeGreaterThan(0)
      for (const call of spending)
        expect(call.position).toBeGreaterThan(gate.position)
    }
  )
})
