import { consola } from 'consola'
import type { PublicClient } from 'viem'

import type { FoundryManager } from './foundry'
import type { RpcPool } from './rpc'
import type { TrackingStore } from './tracking'
import type {
  IActionContext,
  IActionDefinition,
  EnvironmentName,
  IExecutionGroup,
  INetworkConfig,
  IRpcEndpoint,
} from './types'

interface IExecutionOptions {
  environment: EnvironmentName
  contract?: string
  actions: IActionDefinition[]
  actionParamsHash: Map<string, string>
  rpcPool: RpcPool
  trackingStore: TrackingStore
  foundryManager: FoundryManager
  networkConcurrency: number
  allowNonTxParallel: boolean
  dryRun: boolean
}

interface IActionSummary {
  actionId: string
  success: number
  failed: number
  skipped: number
  pending: number
}

interface IExecutionSummary {
  actions: IActionSummary[]
  failures: Array<{ network: string; actionId: string; error: string }>
}

const runWithConcurrency = async <T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  if (limit <= 1) {
    for (const item of items) {
      await task(item)
    }
    return
  }

  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, items.length) }).map(
    async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) return
        await task(item)
      }
    }
  )

  await Promise.all(workers)
}

const logPrefix = (network: INetworkConfig, actionId: string): string =>
  `[${network.id}][${actionId}]`

const executeAction = async (
  action: IActionDefinition,
  context: IActionContext,
  trackingStore: TrackingStore,
  actionParamsHash: Map<string, string>
): Promise<void> => {
  const paramsHash = actionParamsHash.get(action.id)
  if (!paramsHash)
    throw new Error(`Missing params hash for action ${action.id}`)
  const actionKey = trackingStore.getActionKey(action.id, paramsHash)
  const prefix = logPrefix(context.network, action.id)

  if (trackingStore.shouldSkip(context.network.id, actionKey)) {
    consola.info(`${prefix} already successful; skipping`)
    return
  }

  if (context.dryRun) {
    consola.info(`${prefix} dry-run enabled; skipping`)
    return
  }

  try {
    trackingStore.startAction(context.network.id, actionKey)
    await trackingStore.save()

    const result = await action.run(context)
    if (result.status === 'failed') {
      const errorMessage = result.error ?? 'Action failed'
      trackingStore.finishAction(
        context.network.id,
        actionKey,
        'failed',
        errorMessage
      )
      await trackingStore.save()
      consola.error(`${prefix} failed: ${errorMessage}`)
      return
    }

    if (result.status === 'skipped') {
      trackingStore.finishAction(context.network.id, actionKey, 'skipped')
      await trackingStore.save()
      consola.info(`${prefix} skipped`)
      return
    }

    trackingStore.finishAction(context.network.id, actionKey, 'success')
    await trackingStore.save()
    consola.success(`${prefix} success`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    trackingStore.finishAction(context.network.id, actionKey, 'failed', message)
    await trackingStore.save()
    consola.error(`${prefix} error: ${message}`)
  }
}

const executeNetwork = async (
  network: INetworkConfig,
  options: IExecutionOptions
): Promise<void> => {
  const { rpcPool, environment, contract, dryRun } = options
  let rpcClient: PublicClient
  let rpcEndpoints: IRpcEndpoint[]

  if (dryRun) {
    // Create a minimal PublicClient-like object for dry run
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcClient = {} as any as PublicClient
    rpcEndpoints = []
  } else {
    try {
      rpcClient = await rpcPool.getPublicClient(network)
      rpcEndpoints = await rpcPool.describeEndpoints(network)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      consola.error(`[${network.id}] RPC setup failed: ${message}`)
      for (const action of options.actions) {
        const paramsHash = options.actionParamsHash.get(action.id)
        if (!paramsHash) continue
        const actionKey = options.trackingStore.getActionKey(
          action.id,
          paramsHash
        )
        if (options.trackingStore.shouldSkip(network.id, actionKey)) continue
        options.trackingStore.startAction(network.id, actionKey)
        options.trackingStore.finishAction(
          network.id,
          actionKey,
          'failed',
          message
        )
      }
      await options.trackingStore.save()
      return
    }
  }

  const context: IActionContext = {
    network,
    environment,
    contract,
    rpcClient,
    rpcEndpoints,
    dryRun,
  }

  let txChain = Promise.resolve()
  const nonTx: Promise<void>[] = []

  for (const action of options.actions) {
    if (options.allowNonTxParallel && !action.isTx) {
      nonTx.push(
        executeAction(
          action,
          context,
          options.trackingStore,
          options.actionParamsHash
        )
      )
      continue
    }

    txChain = txChain.then(() =>
      executeAction(
        action,
        context,
        options.trackingStore,
        options.actionParamsHash
      )
    )
  }

  await Promise.all([...nonTx, txChain])
}

const summarize = (
  networks: INetworkConfig[],
  actions: IActionDefinition[],
  trackingStore: TrackingStore,
  actionParamsHash: Map<string, string>
): IExecutionSummary => {
  const summaryMap = new Map<string, IActionSummary>()
  const failures: Array<{ network: string; actionId: string; error: string }> =
    []

  for (const action of actions) {
    summaryMap.set(action.id, {
      actionId: action.id,
      success: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
    })
  }

  for (const network of networks) {
    for (const action of actions) {
      const paramsHash = actionParamsHash.get(action.id)
      if (!paramsHash) continue
      const actionKey = trackingStore.getActionKey(action.id, paramsHash)
      const entry = trackingStore.getEntry(network.id, actionKey)
      const summary = summaryMap.get(action.id)
      if (!summary) continue

      switch (entry.status) {
        case 'success':
          summary.success += 1
          break
        case 'failed':
          summary.failed += 1
          failures.push({
            network: network.id,
            actionId: action.id,
            error: entry.error ?? 'Unknown error',
          })
          break
        case 'skipped':
          summary.skipped += 1
          break
        default:
          summary.pending += 1
      }
    }
  }

  return { actions: Array.from(summaryMap.values()), failures }
}

const printSummary = (summary: IExecutionSummary): void => {
  consola.info('Execution summary:')
  for (const action of summary.actions) {
    consola.info(
      `${action.actionId}: success=${action.success} failed=${action.failed} skipped=${action.skipped} pending=${action.pending}`
    )
  }

  if (summary.failures.length > 0) {
    consola.warn('Failures:')
    for (const failure of summary.failures) {
      consola.warn(`[${failure.network}][${failure.actionId}] ${failure.error}`)
    }
  }
}

export const executeGroups = async (
  groups: IExecutionGroup[],
  networks: INetworkConfig[],
  options: IExecutionOptions
): Promise<void> => {
  for (const group of groups) {
    consola.info(
      `Starting group ${group.name} (${group.networks.length} networks)`
    )

    if (group.name === 'london') {
      await options.foundryManager.applyLondonProfile()
    } else {
      await options.foundryManager.ensurePrimaryProfile()
    }

    const concurrency =
      group.name === 'zkevm' ? 1 : Math.max(1, options.networkConcurrency)

    await runWithConcurrency(group.networks, concurrency, async (network) =>
      executeNetwork(network, options)
    )
  }

  const summary = summarize(
    networks,
    options.actions,
    options.trackingStore,
    options.actionParamsHash
  )
  printSummary(summary)
}
