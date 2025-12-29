import { consola } from 'consola'

import { runShellCommand } from './shell'
import type { IActionDefinition, IActionResult, IActionContext } from './types'

type CommandRunner = typeof runShellCommand

const runScriptCommand = async (
  runner: CommandRunner,
  command: string,
  prefix: string,
  env?: NodeJS.ProcessEnv
): Promise<IActionResult> => {
  const result = await runner(command, { prefix, env })
  if (result.code === 0) return { status: 'success' }

  return {
    status: 'failed',
    error: `Script exited with code ${result.code}`,
  }
}

const ensureContract = (context: IActionContext): string | null => {
  if (!context.contract) return null
  return context.contract
}

const buildPrefix = (context: IActionContext, actionId: string): string =>
  `[${context.network.id}][${actionId}]`

const deployContract = (runner: CommandRunner): IActionDefinition => ({
  id: 'deploy-contract',
  label: 'Deploy contract via deploySingleContract.sh',
  isTx: true,
  requiresContract: true,
  run: async (context: IActionContext) => {
    if (context.dryRun) return { status: 'skipped' }
    const contract = ensureContract(context)
    if (!contract) return { status: 'failed', error: 'Contract is required' }

    const prefix = buildPrefix(context, 'deploy-contract')
    const env = {
      CONTRACT: contract,
      ENVIRONMENT: context.environment,
    }
    const command = [
      'source script/deploy/deploySingleContract.sh',
      `deploySingleContract "${contract}" "${context.network.id}" "${context.environment}" "" "false"`,
    ].join(' && ')

    return runScriptCommand(runner, command, prefix, env)
  },
})

const createProposal = (runner: CommandRunner): IActionDefinition => ({
  id: 'create-proposal',
  label: 'Create multisig proposal via playgroundHelpers.sh',
  isTx: false,
  requiresContract: true,
  run: async (context: IActionContext) => {
    if (context.dryRun) return { status: 'skipped' }
    const contract = ensureContract(context)
    if (!contract) return { status: 'failed', error: 'Contract is required' }

    const prefix = buildPrefix(context, 'create-proposal')
    const env = {
      CONTRACT: contract,
      ENVIRONMENT: context.environment,
    }
    const command = [
      'source script/playgroundHelpers.sh',
      `createMultisigProposalForContract "${context.network.id}" "${context.environment}" "${contract}"`,
    ].join(' && ')

    return runScriptCommand(runner, command, prefix, env)
  },
})

export const getAvailableActions = (
  runner: CommandRunner = runShellCommand
): IActionDefinition[] => {
  return [deployContract(runner), createProposal(runner)]
}

export const resolveActions = (
  actionIds: string[],
  actions: IActionDefinition[]
): IActionDefinition[] => {
  const actionMap = new Map(actions.map((action) => [action.id, action]))
  const resolved: IActionDefinition[] = []

  for (const id of actionIds) {
    const action = actionMap.get(id)
    if (!action) throw new Error(`Unknown action "${id}"`)
    resolved.push(action)
  }

  return resolved
}

export const validateActionRequirements = (
  actions: IActionDefinition[],
  context: { contract?: string }
): void => {
  for (const action of actions) {
    if (action.requiresContract && !context.contract) {
      consola.warn(`Action ${action.id} requires --contract`)
    }
  }
}
