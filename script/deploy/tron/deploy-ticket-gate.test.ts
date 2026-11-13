/**
 * Where the Tron deploy-and-register scripts check the proposal ticket: before
 * the build and before any deploy, so a run without one stops before it spends
 * TRX on a contract whose proposal would then be refused. Also pins that
 * `--proposeOnly` still shows the network confirmation before it proposes.
 *
 * Read from the source rather than by spawning the scripts: every one imports
 * the generated typechain bindings, which CI does not build, so a spawned
 * script cannot load there. The checks are positional, so the AST answers them.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import ts from 'typescript'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

/** Every deploy-and-register script, so a new one is checked without being listed. */
const SCRIPTS = readdirSync(import.meta.dir)
  .filter((name) => /^deploy-and-register-.+(?<!\.test)\.ts$/.test(name))
  .sort()

/**
 * The exact condition each script guards the check with. Anything beyond the
 * dry-run exemption has to be named here, so a new bypass fails the test.
 */
const DEFAULT_GUARD = '!dryRun'
const GUARDS: Record<string, string> = {
  'deploy-and-register-periphery.ts': '!options.dryRun',
  // DEFER_CUT=true deploys without proposing, so there is no proposal to ticket.
  'deploy-and-register-symbiosis-facet.ts': '!dryRun && !deferCut',
}

/** Calls that spend TRX or come before anything that does. */
const SPENDING_CALLS = [
  'buildForgeArtifactsOrThrow',
  'deployContractWithLogging',
]

interface ICall {
  name: string
  position: number
  /** The conditions of every enclosing `if`, innermost first, so a nested bypass shows too. */
  guards: string[]
}

const enclosingIfConditions = (
  node: ts.Node,
  source: ts.SourceFile
): string[] => {
  const conditions: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isIfStatement(parent))
      conditions.push(parent.expression.getText(source))
  return conditions
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
      calls.push({
        name: node.expression.text,
        position: node.getStart(source),
        guards: enclosingIfConditions(node, source),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

describe('Tron deploy-and-register scripts check the ticket first', () => {
  it('finds the scripts', () => {
    // A floor, so a renamed directory or pattern cannot pass on zero scripts.
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(7)
  })

  it.each(SCRIPTS)(
    '%s checks the ticket, except on a dry run, before it builds or deploys',
    (script) => {
      const calls = callsIn(script)
      const gates = calls.filter((c) => c.name === 'assertTicketPresent')

      expect(gates).toHaveLength(1)
      const gate = gates[0] as ICall
      expect(gate.guards).toEqual([GUARDS[script] ?? DEFAULT_GUARD])

      const spending = calls.filter((c) => SPENDING_CALLS.includes(c.name))
      expect(spending.length).toBeGreaterThan(0)
      for (const call of spending)
        expect(call.position).toBeGreaterThan(gate.position)
    }
  )

  it.each(SCRIPTS)(
    '%s shows the network confirmation on every run, --proposeOnly included',
    (script) => {
      const confirmations = callsIn(script).filter(
        (c) => c.name === 'confirmDeployment'
      )

      for (const confirmation of confirmations)
        for (const guard of confirmation.guards)
          expect(guard).not.toContain('proposeOnly')
    }
  )
})
