import { consola } from 'consola'
import { isAddress, getAddress } from 'viem'

import type { EnvironmentEnum } from '../common/types'
import { getDeployments } from '../utils/deploymentHelpers'

import type { RpcPool } from './rpc'
import type { INetworkConfig } from './types'

type DeploymentLoader = (
  chain: INetworkConfig['id'],
  environment: EnvironmentEnum
) => Promise<Record<string, string>>

interface ISelectionOptions {
  networks: Record<string, INetworkConfig>
  selectors?: string[]
  explicitNetworks?: string[]
  environment: EnvironmentEnum
  contract?: string
  rpcPool?: RpcPool
  deploymentLoader?: DeploymentLoader
  concurrency?: number
}

const normalizeNetworkName = (name: string): string => name.trim().toLowerCase()

const parseSelector = (raw: string): { type: string; value?: string } => {
  const trimmed = raw.trim()
  if (!trimmed) return { type: 'unknown' }
  if (trimmed === 'all') return { type: 'all' }
  if (trimmed.startsWith('evm:'))
    return { type: 'evm', value: trimmed.slice(4) }
  if (trimmed.startsWith('deployed:'))
    return { type: 'deployed', value: trimmed.slice(9) }
  if (trimmed === 'deployed') return { type: 'deployed' }

  return { type: 'unknown', value: trimmed }
}

const selectByExplicitNetworks = (
  networks: Record<string, INetworkConfig>,
  names: string[]
): Set<string> => {
  const selected = new Set<string>()
  for (const rawName of names) {
    const name = normalizeNetworkName(rawName)
    if (!name) continue
    if (networks[name]) {
      selected.add(name)
    } else {
      consola.warn(`Unknown network "${rawName}" requested; skipping`)
    }
  }
  return selected
}

const selectByEvmVersion = (
  networks: Record<string, INetworkConfig>,
  evmVersion: string
): Set<string> => {
  const selected = new Set<string>()
  const target = evmVersion.toLowerCase()
  for (const [name, network] of Object.entries(networks)) {
    const networkVersion = network.deployedWithEvmVersion?.toLowerCase()
    if (networkVersion === target) selected.add(name)
  }
  return selected
}

const hasBytecode = (code: string | null): boolean => {
  if (!code) return false
  const trimmed = code.toLowerCase()
  return trimmed !== '0x' && trimmed !== '0x0'
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

const selectByDeployedContract = async (
  networks: Record<string, INetworkConfig>,
  contract: string,
  environment: EnvironmentEnum,
  rpcPool: RpcPool,
  deploymentLoader: DeploymentLoader,
  concurrency: number
): Promise<Set<string>> => {
  const selected = new Set<string>()
  const networkList = Object.values(networks)

  await runWithConcurrency(networkList, concurrency, async (network) => {
    let deployments: Record<string, string> | null = null
    try {
      deployments = await deploymentLoader(network.id, environment)
    } catch (error) {
      consola.warn(
        `Missing deployment log for ${network.id}: ${(error as Error).message}`
      )
      return
    }

    const rawAddress = deployments?.[contract]
    if (!rawAddress) return

    if (!isAddress(rawAddress)) {
      consola.warn(
        `Invalid deployment address for ${network.id} (${contract}): ${rawAddress}`
      )
      return
    }

    let code = '0x'
    try {
      code = await rpcPool.getCode(network, getAddress(rawAddress))
    } catch (error) {
      consola.warn(
        `Failed to fetch code for ${network.id} (${contract}): ${
          (error as Error).message
        }`
      )
      return
    }

    if (hasBytecode(code)) selected.add(network.id)
  })

  return selected
}

export const selectNetworks = async (
  options: ISelectionOptions
): Promise<INetworkConfig[]> => {
  const {
    networks,
    selectors,
    explicitNetworks,
    environment,
    contract,
    rpcPool,
    deploymentLoader = getDeployments,
    concurrency = 6,
  } = options

  const allNetworks = Object.values(networks)
  const selectedIds = new Set<string>()
  const selectorList = selectors?.length ? selectors : []

  if (explicitNetworks?.length) {
    const explicit = selectByExplicitNetworks(networks, explicitNetworks)
    explicit.forEach((name) => selectedIds.add(name))
  }

  if (selectorList.length === 0 && selectedIds.size === 0) {
    selectorList.push('all')
  }

  for (const selector of selectorList) {
    const parsed = parseSelector(selector)
    if (parsed.type === 'all') {
      allNetworks.forEach((network) => selectedIds.add(network.id))
      continue
    }
    if (parsed.type === 'evm') {
      if (!parsed.value)
        throw new Error('Selector evm:<version> requires a version')
      const matches = selectByEvmVersion(networks, parsed.value)
      matches.forEach((name) => selectedIds.add(name))
      continue
    }
    if (parsed.type === 'deployed') {
      const resolvedContract = parsed.value ?? contract
      if (!resolvedContract)
        throw new Error('Selector deployed:<contract> requires a contract name')
      if (!rpcPool)
        throw new Error('RPC pool is required for deployed selector')
      const matches = await selectByDeployedContract(
        networks,
        resolvedContract,
        environment,
        rpcPool,
        deploymentLoader,
        concurrency
      )
      matches.forEach((name) => selectedIds.add(name))
      continue
    }

    throw new Error(`Unknown selector: ${selector}`)
  }

  return allNetworks.filter((network) => selectedIds.has(network.id))
}
