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
}

/** The facet each facet script deploys, which `--proposeOnly` must check the build of. */
const FACETS: Record<string, string> = {
  'deploy-and-register-allbridge-facet.ts': 'AllBridgeFacet',
  'deploy-and-register-eco-facet.ts': 'EcoFacet',
  'deploy-and-register-layerswap-facet.ts': 'LayerSwapFacet',
  'deploy-and-register-lifi-intent-escrow-facet-v2.ts':
    'LiFiIntentEscrowFacetV2',
  'deploy-and-register-near-intents-facet.ts': 'NEARIntentsFacet',
  'deploy-and-register-symbiosis-facet.ts': 'SymbiosisFacet',
}
const FACET_SCRIPTS = SCRIPTS.filter((script) => script in FACETS)

/** Calls that spend TRX or come before anything that does. */
const SPENDING_CALLS = [
  'buildForgeArtifactsOrThrow',
  'deployContractWithLogging',
]

interface ICall {
  name: string
  position: number
  /**
   * The conditions of every `if` whose branch holds the call, innermost first, so a nested
   * bypass shows too. A call inside an `if`'s own condition is not guarded by it.
   */
  guards: string[]
  node: ts.CallExpression
}

const enclosingIfConditions = (
  node: ts.Node,
  source: ts.SourceFile
): string[] => {
  const conditions: string[] = []
  for (
    let child = node, parent = node.parent;
    parent;
    child = parent, parent = parent.parent
  )
    if (ts.isIfStatement(parent) && child !== parent.expression)
      conditions.push(parent.expression.getText(source))
  return conditions
}

const parse = (script: string): ts.SourceFile => {
  const path = join(import.meta.dir, script)
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
}

const callsIn = (script: string): ICall[] => {
  const source = parse(script)
  const calls: ICall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({
        name: node.expression.text,
        position: node.getStart(source),
        guards: enclosingIfConditions(node, source),
        node,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

/**
 * The string an argument names: a literal, or an identifier bound to a `const` string literal
 * in the same file.
 */
const stringValueOf = (
  arg: ts.Expression | undefined,
  script: string
): string | undefined => {
  if (!arg) return undefined
  if (ts.isStringLiteral(arg)) return arg.text
  if (!ts.isIdentifier(arg)) return undefined
  let value: string | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === arg.text &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    )
      value = node.initializer.text
    ts.forEachChild(node, visit)
  }
  visit(parse(script))
  return value
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

  it('knows every facet script', () => {
    expect(FACET_SCRIPTS).toEqual(Object.keys(FACETS).sort())
  })

  it.each(FACET_SCRIPTS)(
    '%s shows the network confirmation on every run, --proposeOnly included',
    (script) => {
      const confirmations = callsIn(script).filter(
        (c) => c.name === 'confirmDeployment'
      )

      expect(confirmations).toHaveLength(1)
      expect((confirmations[0] as ICall).guards).toEqual([])
    }
  )

  it.each([...FACET_SCRIPTS, 'deploy-core-facets.ts'])(
    '%s hands confirmDeployment the --skipConfirmation flag, read strictly',
    (script) => {
      const calls = callsIn(script)
      const [confirmation] = calls.filter((c) => c.name === 'confirmDeployment')
      const options = confirmation?.node.arguments[3]
      expect(options?.getText()).toMatch(
        /skipConfirmation: options\.skipConfirmation/
      )

      const reads = calls.filter(({ name, node }) => {
        const { parent } = node
        return (
          name === 'readBooleanFlag' &&
          ts.isPropertyAssignment(parent) &&
          parent.name.getText() === 'skipConfirmation'
        )
      })
      expect(reads).toHaveLength(1)
      expect((reads[0] as ICall).node.arguments[1]?.getText()).toContain(
        "camel: 'skipConfirmation'"
      )
    }
  )

  it.each([...SCRIPTS, 'deploy-core-facets.ts'])(
    '%s never waits on a prompt',
    (script) => {
      const source = readFileSync(join(import.meta.dir, script), 'utf8')
      expect(source).not.toMatch(/consola\.prompt|promptEnergyRentalReminder/)
    }
  )

  it.each(FACET_SCRIPTS)(
    '%s passes --proposeOnly to the deployment-mode check for the facet it deploys',
    (script) => {
      const calls = callsIn(script)
      const modes = calls.filter((c) => c.name === 'tronExistingDeploymentMode')

      expect(modes).toHaveLength(1)
      const [flag, contract] = (modes[0] as ICall).node.arguments
      expect(flag?.getText()).toBe('proposeOnly')
      expect(stringValueOf(contract, script)).toBe(FACETS[script])

      const reads = calls.filter(({ name, node }) => {
        const { parent } = node
        return (
          name === 'readBooleanFlag' &&
          ts.isPropertyAssignment(parent) &&
          parent.name.getText() === 'proposeOnly'
        )
      })
      expect(reads).toHaveLength(1)
      expect((reads[0] as ICall).node.arguments[1]?.getText()).toContain(
        "camel: 'proposeOnly'"
      )
    }
  )
})

describe('deploy-and-register-periphery.ts redeploy decisions', () => {
  const calls = callsIn('deploy-and-register-periphery.ts')
  const argsOf = (name: string) =>
    calls
      .filter((c) => c.name === name)
      .map((c) => c.node.arguments.map((arg) => arg.getText()))

  it('deploys Executor and ReceiverOIF again when this run replaced what they are built against', () => {
    expect(argsOf('modeAfterDependency')).toEqual([
      ["'Executor'", "'ERC20Proxy'"],
      ["'ReceiverOIF'", "'Executor'"],
    ])
    const direct = argsOf('tronExistingDeploymentMode').map((args) => args[1])
    expect(direct).not.toContain("'Executor'")
    expect(direct).not.toContain("'ReceiverOIF'")
  })

  it('keeps a recorded timelock unless --only names it', () => {
    const keep = calls.filter((c) => c.name === 'keepRecordedTimelock')
    expect(keep).toHaveLength(1)
    const conditional = (keep[0] as ICall).node.parent.parent
    expect(ts.isConditionalExpression(conditional)).toBe(true)
    expect(
      (conditional as ts.ConditionalExpression).condition.getText()
    ).toMatch(/onlyContracts\?\.includes\(\s*'LiFiTimelockController'\s*\)/)
  })
})
