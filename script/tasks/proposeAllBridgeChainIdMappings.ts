/**
 * Propose AllBridge chainId-to-allBridgeChainId mapping updates (batch)
 *
 * For each network where AllBridgeFacet is deployed, this script:
 * 1) Reads mappings from config/allbridge.json
 * 2) Multicalls getChainIdToAllBridgeChainId on the diamond and keeps only rows
 *    that are unset (UnsupportedAllBridgeChainId) or differ from config, plus the
 *    stale keys an inverted seed left behind that still resolve
 * 3) Builds a LiFiDiamond.setChainIdToAllBridgeChainId(ChainIdConfig[]) call followed
 *    by one unsetChainIdToAllBridgeChainId(key) call per stale key
 * 4) Wraps them in one TimelockController.scheduleBatch(...)
 * 5) Proposes the transaction to the network Safe and stores it in MongoDB
 *
 * Example:
 * bunx tsx script/tasks/proposeAllBridgeChainIdMappings.ts --environment production
 *
 * Single network:
 * bunx tsx script/tasks/proposeAllBridgeChainIdMappings.ts --network arbitrum --environment production
 */

import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'

import { EnvironmentEnum } from '../common/types'
import { proposeSafeTx } from '../deploy/safe/propose-safe-tx'
import {
  getNextNonce,
  getPrivateKey,
  getSafeMongoCollection,
  initializeSafeClient,
  pickTimelockSalt,
} from '../deploy/safe/safe-utils'
import { encodeTimelockScheduleBatch } from '../deploy/safe/timelock-abi'
import type { IAllBridgeChainIdConfig } from '../deploy/tron/helpers/allBridgeInit'
import {
  getAllActiveNetworks,
  getViemChainForNetworkName,
  isTestnetNetwork,
} from '../utils/viemScriptHelpers'

import {
  assertMappingsInitialized,
  buildMappingRepairCalls,
  GET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI,
  getStaleAllBridgeKeys,
  loadAllBridgeMappings,
  selectMappingsNeedingUpdate,
  selectResolvingStaleKeys,
  type IMappingRepairCalls,
  type MappingReadResult,
} from './allBridgeChainIdMappings'

function castEnv(environment?: string): EnvironmentEnum {
  if (!environment) return EnvironmentEnum.production
  if (environment === 'production') return EnvironmentEnum.production
  if (environment === 'staging') return EnvironmentEnum.staging
  throw new Error(`Invalid environment: ${environment}`)
}

function getDeploymentsFilePath(
  network: string,
  environment: EnvironmentEnum
): string {
  const fileName =
    environment === EnvironmentEnum.production
      ? `${network}.json`
      : `${network}.staging.json`
  const base = path.join(process.cwd(), 'deployments')
  const filePath = path.join(base, fileName)
  const relativePath = path.relative(base, filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath))
    throw new Error(`Invalid network name: ${network}`)
  return filePath
}

function readDeploymentsFile(
  network: string,
  environment: EnvironmentEnum
): Record<string, unknown> | undefined {
  const filePath = getDeploymentsFilePath(network, environment)
  if (!fs.existsSync(filePath)) return undefined

  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return parsed as Record<string, unknown>
}

function isNonZeroAddressString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('0x') &&
    value.length === 42 &&
    value !== '0x0000000000000000000000000000000000000000'
  )
}

/**
 * Reads every config row and stale key from the diamond in one multicall.
 * @param params.network - Network the diamond lives on
 * @param params.diamondAddress - The LiFiDiamond to read
 * @param params.mappings - The configured mappings
 * @param params.staleKeys - Output of `getStaleAllBridgeKeys`
 * @returns The rows to (re)write and the stale keys that still resolve
 * @throws When the diamond was never initialized or a read fails for another reason
 */
async function readMappingRepairs(params: {
  network: string
  diamondAddress: Address
  mappings: IAllBridgeChainIdConfig[]
  staleKeys: bigint[]
}): Promise<{
  mappingsToSet: IAllBridgeChainIdConfig[]
  staleKeysToUnset: bigint[]
}> {
  const { network, diamondAddress, mappings, staleKeys } = params

  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({ chain, transport: http() })

  const keys = [...mappings.map((m) => m.chainId), ...staleKeys]
  const results = (await client.multicall({
    contracts: keys.map((key) => ({
      address: diamondAddress,
      abi: GET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI,
      functionName: 'getChainIdToAllBridgeChainId',
      args: [key],
    })),
    allowFailure: true,
  })) as MappingReadResult[]

  assertMappingsInitialized(results)

  return {
    mappingsToSet: selectMappingsNeedingUpdate(
      mappings,
      results.slice(0, mappings.length)
    ),
    staleKeysToUnset: selectResolvingStaleKeys(
      staleKeys,
      results.slice(mappings.length)
    ),
  }
}

/**
 * Wraps the repair calls in a timelock `scheduleBatch` with the timelock's min delay.
 * @param params.network - Network the timelock lives on
 * @param params.timelockAddress - The diamond's TimelockController
 * @param params.calls - Output of `buildMappingRepairCalls`
 * @returns The `scheduleBatch` calldata for the Safe proposal
 */
async function buildTimelockScheduleBatchCalldata(params: {
  network: string
  timelockAddress: Address
  calls: IMappingRepairCalls
}): Promise<Hex> {
  const { network, timelockAddress, calls } = params
  const { targets, values, payloads } = calls

  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({ chain, transport: http() })
  const timelockViewAbi = parseAbi([
    'function getMinDelay() view returns (uint256)',
  ])
  const minDelay = await client.readContract({
    address: timelockAddress,
    abi: timelockViewAbi,
    functionName: 'getMinDelay',
  })

  const salt = await pickTimelockSalt({
    client,
    chainId: chain.id,
    timelockAddress,
    targetAddresses: targets,
    originalCalldatas: payloads,
    values,
  })

  return encodeTimelockScheduleBatch(targets, payloads, salt, minDelay, values)
}

async function proposeToSafe(params: {
  network: string
  to: Address
  calldata: Hex
  privateKey?: string
  rpcUrl?: string
}): Promise<void> {
  const { network, to, calldata, privateKey, rpcUrl } = params

  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()

  try {
    const { safe, chain, safeAddress } = await initializeSafeClient(
      network,
      privateKey,
      rpcUrl
    )

    const nextNonce = await getNextNonce(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      await safe.getNonce()
    )

    const { safeTxHash, stored } = await proposeSafeTx({
      safe,
      network,
      chainId: chain.id,
      safeAddress,
      pendingTransactions,
      payload: { kind: 'call', to, data: calldata, nonce: nextNonce },
    })

    if (!stored) {
      consola.info(`[${network}] ℹ️ Proposal already exists - skipping insert`)
      return
    }

    consola.success(`[${network}] ✅ Proposed Safe tx ${safeTxHash}`)
  } finally {
    await mongoClient.close()
  }
}

const main = defineCommand({
  meta: {
    name: 'propose-allbridge-chainid-mappings',
    description:
      'Creates Safe proposals (timelock scheduleBatch) to update AllBridge chainId-to-allBridgeChainId mappings on all networks where AllBridgeFacet is deployed',
  },
  args: {
    environment: {
      type: 'string',
      description: 'Environment (production | staging). Default: production.',
      required: false,
    },
    network: {
      type: 'string',
      description:
        'Optional single network (e.g. arbitrum). If omitted, auto-detect all.',
      required: false,
    },
    excludeNetworks: {
      type: 'string',
      description:
        'Optional JSON array of network names to exclude, e.g. ["megaeth","flow"]',
      required: false,
    },
    privateKey: {
      type: 'string',
      description:
        'Optional Safe signer private key (defaults to PRIVATE_KEY_PRODUCTION, or PRIVATE_KEY when --environment=staging).',
      required: false,
    },
  },
  async run({ args }) {
    const environment = castEnv(args.environment)
    const mappings = loadAllBridgeMappings()
    const staleKeys = getStaleAllBridgeKeys(mappings)

    const excludeSet = new Set<string>()
    if (args.excludeNetworks) {
      const parsed = JSON.parse(args.excludeNetworks) as unknown
      if (!Array.isArray(parsed))
        throw new Error('--excludeNetworks must be a JSON array of strings')
      for (const n of parsed) excludeSet.add(String(n).toLowerCase())
    }

    const keyName =
      environment === EnvironmentEnum.staging
        ? 'PRIVATE_KEY'
        : 'PRIVATE_KEY_PRODUCTION'
    const privateKey = getPrivateKey(keyName, args.privateKey)

    const networksToCheck = args.network
      ? [args.network]
      : getAllActiveNetworks().map((n) => n.id)

    const eligibleNetworks: string[] = []
    for (const network of networksToCheck) {
      if (excludeSet.has(network.toLowerCase())) continue
      if (isTestnetNetwork(network)) continue

      const deployments = readDeploymentsFile(network, environment)
      if (!deployments) continue

      const facetAddress = deployments.AllBridgeFacet
      if (!isNonZeroAddressString(facetAddress)) continue

      eligibleNetworks.push(network)
    }

    if (eligibleNetworks.length === 0) {
      consola.warn('No eligible networks found (AllBridgeFacet not deployed).')
      return
    }

    consola.info(
      `Found ${
        eligibleNetworks.length
      } network(s) with AllBridgeFacet deployed: ${eligibleNetworks.join(', ')}`
    )
    consola.info(`Mappings in config: ${mappings.length}`)

    const results: Array<{ network: string; ok: boolean; error?: string }> = []

    for (const network of eligibleNetworks) {
      try {
        const deployments = readDeploymentsFile(network, environment)
        if (!deployments)
          throw new Error(
            `Missing deployments file: ${getDeploymentsFilePath(
              network,
              environment
            )}`
          )

        const diamondRaw = deployments.LiFiDiamond
        const timelockRaw = deployments.LiFiTimelockController

        if (!isNonZeroAddressString(diamondRaw))
          throw new Error(`Missing LiFiDiamond deployment on ${network}`)
        if (!isNonZeroAddressString(timelockRaw))
          throw new Error(
            `Missing LiFiTimelockController deployment on ${network}`
          )

        const diamondAddress = getAddress(diamondRaw as Address)
        const timelockAddress = getAddress(timelockRaw as Address)

        const { mappingsToSet, staleKeysToUnset } = await readMappingRepairs({
          network,
          diamondAddress,
          mappings,
          staleKeys,
        })

        const calls = buildMappingRepairCalls({
          diamondAddress,
          mappingsToSet,
          staleKeysToUnset,
        })

        if (calls.payloads.length === 0) {
          consola.info(
            `[${network}] All ${mappings.length} mapping(s) up to date, no stale keys - skipping`
          )
          results.push({ network, ok: true })
          continue
        }

        consola.info(
          `[${network}] ${mappingsToSet.length}/${
            mappings.length
          } mapping(s) need update, ${
            staleKeysToUnset.length
          } stale key(s) to unset${
            staleKeysToUnset.length > 0
              ? ` (${staleKeysToUnset.join(', ')})`
              : ''
          }`
        )

        const calldata = await buildTimelockScheduleBatchCalldata({
          network,
          timelockAddress,
          calls,
        })

        await proposeToSafe({
          network,
          to: timelockAddress,
          calldata,
          privateKey,
        })

        results.push({ network, ok: true })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        consola.error(`[${network}] ❌ Failed: ${msg}`)
        results.push({ network, ok: false, error: msg })
      }
    }

    const okCount = results.filter((r) => r.ok).length
    const failCount = results.length - okCount

    consola.info(`Done. Success: ${okCount}, Failed: ${failCount}`)
    if (failCount > 0) {
      const failed = results.filter((r) => !r.ok)
      consola.info('Failed networks:')
      for (const f of failed)
        consola.info(`- ${f.network}: ${f.error ?? 'Unknown error'}`)
      process.exitCode = 1
    }
  },
})

runMain(main)
