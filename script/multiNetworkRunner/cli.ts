import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'

import { EnvironmentEnum } from '../common/types'

import { getAvailableActions, resolveActions } from './actions'
import { executeGroups } from './executor'
import { FoundryManager } from './foundry'
import { groupNetworks } from './grouping'
import { loadNetworks } from './registry'
import { RpcPool, type RpcSource } from './rpc'
import { selectNetworks } from './selectors'
import { hashActionParams, loadTrackingStore } from './tracking'
import type { EnvironmentName } from './types'

config()

const parseList = (value?: string): string[] => {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const toEnvironmentEnum = (value: EnvironmentName): EnvironmentEnum =>
  value === 'production' ? EnvironmentEnum.production : EnvironmentEnum.staging

const main = defineCommand({
  meta: {
    name: 'multi-network-runner',
    version: '0.1.0',
    description:
      'Run multi-network actions with grouping, retries, and tracking',
  },
  args: {
    actions: {
      type: 'string',
      description: 'Comma-separated action ids',
    },
    networks: {
      type: 'string',
      description: 'Comma-separated network ids',
    },
    selector: {
      type: 'string',
      description: 'Selector(s) like evm:london,deployed:ContractX,all',
    },
    exclude: {
      type: 'string',
      description: 'Comma-separated networks to exclude',
    },
    contract: {
      type: 'string',
      description: 'Contract name for contract-scoped actions/selectors',
    },
    environment: {
      type: 'string',
      default: 'production',
    },
    rpcSource: {
      type: 'string',
      default: 'env',
      description: 'RPC source: env, env-commented, mongo',
    },
    retryCount: {
      type: 'string',
      default: '3',
    },
    retryDelayMs: {
      type: 'string',
      default: '500',
    },
    rpcTimeoutMs: {
      type: 'string',
      default: '15000',
    },
    concurrency: {
      type: 'string',
      default: '8',
    },
    dryRun: {
      type: 'boolean',
      default: false,
    },
    serialActions: {
      type: 'boolean',
      default: false,
    },
    trackingFile: {
      type: 'string',
      default: '.multi_network_state.json',
    },
    listActions: {
      type: 'boolean',
      default: false,
    },
  },
  run: async ({ args }) => {
    const environment = args.environment as EnvironmentName
    if (environment !== 'production' && environment !== 'staging')
      throw new Error(`Invalid environment: ${environment}`)

    const networksMap = loadNetworks()
    const availableActions = getAvailableActions()

    if (args.listActions) {
      consola.info('Available actions:')
      for (const action of availableActions) {
        consola.info(`${action.id} - ${action.label}`)
      }
      return
    }

    const actionIds = parseList(
      typeof args.actions === 'string' ? args.actions : undefined
    )
    if (actionIds.length === 0)
      throw new Error('At least one action is required')

    const actions = resolveActions(actionIds, availableActions)
    const contract =
      typeof args.contract === 'string' ? args.contract : undefined
    for (const action of actions) {
      if (action.requiresContract && !contract) {
        throw new Error(`Action ${action.id} requires --contract`)
      }
    }

    const rpcSource = args.rpcSource as RpcSource
    if (!['env', 'env-commented', 'mongo'].includes(rpcSource))
      throw new Error(`Invalid rpcSource: ${rpcSource}`)

    const retryCount = Number.parseInt(
      typeof args.retryCount === 'string' ? args.retryCount : '3',
      10
    )
    const retryDelayMs = Number.parseInt(
      typeof args.retryDelayMs === 'string' ? args.retryDelayMs : '500',
      10
    )
    const rpcTimeoutMs = Number.parseInt(
      typeof args.rpcTimeoutMs === 'string' ? args.rpcTimeoutMs : '15000',
      10
    )

    const rpcPool = new RpcPool(rpcSource, {
      retryCount,
      retryDelayMs,
      timeoutMs: rpcTimeoutMs,
    })

    const selectorList = parseList(
      typeof args.selector === 'string' ? args.selector : undefined
    )
    const explicitNetworks = parseList(
      typeof args.networks === 'string' ? args.networks : undefined
    )

    const concurrency = Math.max(
      1,
      Number.parseInt(
        typeof args.concurrency === 'string' ? args.concurrency : '8',
        10
      ) || 8
    )

    const selected = await selectNetworks({
      networks: networksMap,
      selectors: selectorList,
      explicitNetworks,
      environment: toEnvironmentEnum(environment),
      contract,
      rpcPool,
      concurrency,
    })

    const excludeSet = new Set(
      parseList(
        typeof args.exclude === 'string' ? args.exclude : undefined
      ).map((name) => name.toLowerCase())
    )
    const filteredNetworks = selected.filter(
      (network) => !excludeSet.has(network.id)
    )

    if (filteredNetworks.length === 0)
      throw new Error('No networks selected after filtering')

    const foundryManager = new FoundryManager('foundry.toml')
    foundryManager.backup()

    const defaultEvmVersion = foundryManager.getDefaultEvmVersion()
    if (!defaultEvmVersion)
      throw new Error('Failed to read evm_version from foundry.toml')

    const { groups, skipped } = groupNetworks(
      filteredNetworks,
      defaultEvmVersion
    )

    if (skipped.length > 0) {
      consola.warn(
        `Skipping ${
          skipped.length
        } network(s) with unsupported EVM versions: ${skipped
          .map((network) => network.id)
          .join(', ')}`
      )
    }

    const actionParamsHash = new Map<string, string>()
    const actionMeta = actions.map((action) => {
      const paramsHash = hashActionParams({
        actionId: action.id,
        contract,
        environment,
      })
      actionParamsHash.set(action.id, paramsHash)
      return { id: action.id, label: action.label, paramsHash }
    })

    const trackingStore = loadTrackingStore({
      path:
        typeof args.trackingFile === 'string'
          ? args.trackingFile
          : '.multi_network_state.json',
      environment,
      actions: actionMeta,
      networks: filteredNetworks.map((network) => network.id),
    })

    try {
      await executeGroups(groups, filteredNetworks, {
        environment,
        contract,
        actions,
        actionParamsHash,
        rpcPool,
        trackingStore,
        foundryManager,
        networkConcurrency: concurrency,
        allowNonTxParallel: !(
          (typeof args.serialActions === 'boolean'
            ? args.serialActions
            : false) ?? false
        ),
        dryRun:
          (typeof args.dryRun === 'boolean' ? args.dryRun : false) ?? false,
      })
    } finally {
      await foundryManager.restore()
    }
  },
})

runMain(main)
