#!/usr/bin/env bun

/**
 * Propose Polymer CCTP chainId-to-domainId mapping updates (batch)
 *
 * For each network where PolymerCCTPFacet is deployed, this script:
 * 1) Reads mappings from config/polymercctp.json
 * 2) Multicalls getChainIdToDomainId on the diamond and keeps only rows that
 *    are unset (UnsupportedChainId) or differ from config
 * 3) Builds a LiFiDiamond.setChainIdToDomainId(ChainIdConfig[]) call
 * 4) Wraps them in TimelockController.scheduleBatch(...)
 * 5) Proposes the transaction to the network Safe and stores it in MongoDB
 *
 * Example:
 * bun script/tasks/proposePolymerCCTPChainIdMappings.ts --environment production
 *
 * Single network:
 * bun script/tasks/proposePolymerCCTPChainIdMappings.ts --network arbitrum --environment production
 */

import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'

import { EnvironmentEnum } from '../common/types'
import {
  getNextNonce,
  getPrivateKey,
  getSafeMongoCollection,
  initializeSafeClient,
  isAddressASafeOwner,
  OperationTypeEnum,
  storeTransactionInMongoDB,
} from '../deploy/safe/safe-utils'
import {
  getAllActiveNetworks,
  getViemChainForNetworkName,
  isTestnetNetwork,
} from '../utils/viemScriptHelpers'

interface IChainIdMapping {
  chainId: bigint
  domainId: number
}

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex // pre-commit-checker: not a secret

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
  return path.join(process.cwd(), 'deployments', fileName)
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

function loadPolymerCCTPMappings(): IChainIdMapping[] {
  const filePath = path.join(process.cwd(), 'config', 'polymercctp.json')
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as {
    mappings?: Array<{ chainId: unknown; domainId: unknown }>
  }

  if (!parsed.mappings || !Array.isArray(parsed.mappings))
    throw new Error(`Invalid config file format: ${filePath} missing mappings`)

  const mappings: IChainIdMapping[] = parsed.mappings.map((m, idx) => {
    const chainId = BigInt(String(m.chainId))
    const domainId = Number(m.domainId)

    if (chainId <= 0n)
      throw new Error(
        `Invalid mapping at index ${idx}: chainId=${String(m.chainId)}`
      )
    if (!Number.isInteger(domainId) || domainId < 0)
      throw new Error(
        `Invalid mapping at index ${idx}: domainId=${String(m.domainId)}`
      )

    return { chainId, domainId }
  })

  if (mappings.length === 0) throw new Error(`No mappings found in ${filePath}`)

  return mappings
}

function getRevertData(error: unknown): Hex | undefined {
  if (!error || typeof error !== 'object') return undefined

  if ('data' in error && typeof error.data === 'string')
    return error.data as Hex

  if ('cause' in error) return getRevertData(error.cause)

  return undefined
}

async function filterMappingsNeedingUpdate(params: {
  network: string
  diamondAddress: Address
  mappings: IChainIdMapping[]
}): Promise<IChainIdMapping[]> {
  const { network, diamondAddress, mappings } = params

  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({ chain, transport: http() })

  const getChainIdAbi = parseAbi([
    'function getChainIdToDomainId(uint256 chainId) view returns (uint32 domainId)',
  ])
  const errorsAbi = parseAbi(['error UnsupportedChainId(uint256 chainId)'])

  const results = await client.multicall({
    contracts: mappings.map((m) => ({
      address: diamondAddress,
      abi: getChainIdAbi,
      functionName: 'getChainIdToDomainId',
      args: [m.chainId],
    })),
    allowFailure: true,
  })

  const needingUpdate: IChainIdMapping[] = []

  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i]
    const result = results[i]
    if (!mapping || !result)
      throw new Error(`Missing multicall result for mapping index ${i}`)

    if (result.status === 'success') {
      if (Number(result.result) !== mapping.domainId)
        needingUpdate.push(mapping)
      continue
    }

    const revertData = getRevertData(result.error)
    if (revertData) {
      try {
        const decoded = decodeErrorResult({ abi: errorsAbi, data: revertData })
        if (decoded.errorName === 'UnsupportedChainId') {
          needingUpdate.push(mapping)
          continue
        }
      } catch {
        // not UnsupportedChainId
      }
    }

    const message =
      result.error instanceof Error
        ? result.error.message
        : String(result.error)
    throw new Error(
      `Failed to read chainId ${mapping.chainId.toString()} on ${network}: ${message}`
    )
  }

  return needingUpdate
}

async function buildTimelockScheduleBatchCalldata(params: {
  network: string
  timelockAddress: Address
  diamondAddress: Address
  mappings: IChainIdMapping[]
}): Promise<Hex> {
  const { network, timelockAddress, diamondAddress, mappings } = params

  const setChainIdAbi = parseAbi([
    'function setChainIdToDomainId((uint256 chainId, uint32 domainId)[] chainIdConfigs)',
  ])

  const chainIdConfigs = mappings.map((m) => ({
    chainId: m.chainId,
    domainId: m.domainId,
  }))

  const payload = encodeFunctionData({
    abi: setChainIdAbi,
    functionName: 'setChainIdToDomainId',
    args: [chainIdConfigs],
  })

  const targets: Address[] = [diamondAddress]
  const values: bigint[] = [0n]
  const payloads: Hex[] = [payload]

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

  const scheduleBatchAbi = parseAbi([
    'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
  ])

  const salt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex

  return encodeFunctionData({
    abi: scheduleBatchAbi,
    functionName: 'scheduleBatch',
    args: [targets, values, payloads, ZERO_BYTES32, salt, minDelay],
  })
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

    const owners = await safe.getOwners()
    if (!isAddressASafeOwner(owners, safe.account.address)) {
      throw new Error(
        `Signer ${safe.account.address} is not an owner of Safe ${safeAddress} on ${network}`
      )
    }

    const nextNonce = await getNextNonce(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      await safe.getNonce()
    )

    const safeTransaction = await safe.createTransaction({
      transactions: [
        {
          to,
          value: 0n,
          data: calldata,
          operation: OperationTypeEnum.Call,
          nonce: nextNonce,
        },
      ],
    })

    const signedTx = await safe.signTransaction(safeTransaction)
    const safeTxHash = await safe.getTransactionHash(signedTx)

    const result = await storeTransactionInMongoDB(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      signedTx,
      safeTxHash,
      safe.account.address
    )

    if (result === null) {
      consola.info(`[${network}] ℹ️ Proposal already exists - skipping insert`)
      return
    }

    if (!result.acknowledged)
      throw new Error(`[${network}] MongoDB insert was not acknowledged`)

    consola.success(`[${network}] ✅ Proposed Safe tx ${safeTxHash}`)
  } finally {
    await mongoClient.close()
  }
}

const main = defineCommand({
  meta: {
    name: 'propose-polymer-cctp-chainid-mappings',
    description:
      'Creates Safe proposals (timelock scheduleBatch) to update Polymer CCTP chainId-to-domainId mappings on all networks where PolymerCCTPFacet is deployed',
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
    const mappings = loadPolymerCCTPMappings()

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

      const facetAddress = deployments.PolymerCCTPFacet
      if (!isNonZeroAddressString(facetAddress)) continue

      eligibleNetworks.push(network)
    }

    if (eligibleNetworks.length === 0) {
      consola.warn(
        'No eligible networks found (PolymerCCTPFacet not deployed).'
      )
      return
    }

    consola.info(
      `Found ${
        eligibleNetworks.length
      } network(s) with PolymerCCTPFacet deployed: ${eligibleNetworks.join(
        ', '
      )}`
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

        const mappingsToUpdate = await filterMappingsNeedingUpdate({
          network,
          diamondAddress,
          mappings,
        })

        if (mappingsToUpdate.length === 0) {
          consola.info(
            `[${network}] All ${mappings.length} mapping(s) up to date - skipping`
          )
          results.push({ network, ok: true })
          continue
        }

        consola.info(
          `[${network}] ${mappingsToUpdate.length}/${mappings.length} mapping(s) need update`
        )

        const calldata = await buildTimelockScheduleBatchCalldata({
          network,
          timelockAddress,
          diamondAddress,
          mappings: mappingsToUpdate,
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
