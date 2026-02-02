#!/usr/bin/env bun

/**
 * Propose DeBridge DLN chainId mapping updates (batch)
 *
 * For each network where DeBridgeDlnFacet is deployed, this script:
 * 1) Reads mappings from config/debridgedln.json
 * 2) Builds a batch of LiFiDiamond.setDeBridgeChainId(chainId,deBridgeChainId) calls
 * 3) Wraps them in TimelockController.scheduleBatch(...)
 * 4) Proposes the transaction to the network Safe and stores it in MongoDB
 *
 * Example:
 * bun script/tasks/proposeDeBridgeDlnChainIdMappings.ts --environment production
 *
 * Single network:
 * bun script/tasks/proposeDeBridgeDlnChainIdMappings.ts --network arbitrum --environment production
 */

import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
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
} from '../utils/viemScriptHelpers'

interface IChainIdMapping {
  chainId: bigint
  deBridgeChainId: bigint
}

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

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

function loadDeBridgeMappings(): IChainIdMapping[] {
  const filePath = path.join(process.cwd(), 'config', 'debridgedln.json')
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as {
    mappings?: Array<{ chainId: unknown; deBridgeChainId: unknown }>
  }

  if (!parsed.mappings || !Array.isArray(parsed.mappings))
    throw new Error(`Invalid config file format: ${filePath} missing mappings`)

  const mappings: IChainIdMapping[] = parsed.mappings.map((m, idx) => {
    const chainId = BigInt(String(m.chainId))
    const deBridgeChainId = BigInt(String(m.deBridgeChainId))

    if (chainId <= 0n || deBridgeChainId <= 0n)
      throw new Error(
        `Invalid mapping at index ${idx}: chainId=${String(
          m.chainId
        )}, deBridgeChainId=${String(m.deBridgeChainId)}`
      )

    return { chainId, deBridgeChainId }
  })

  if (mappings.length === 0) throw new Error(`No mappings found in ${filePath}`)

  return mappings
}

async function buildTimelockScheduleBatchCalldata(params: {
  network: string
  timelockAddress: Address
  diamondAddress: Address
  mappings: IChainIdMapping[]
}): Promise<Hex> {
  const { network, timelockAddress, diamondAddress, mappings } = params

  // Build calldata for setDeBridgeChainId(chainId,deBridgeChainId) on the Diamond
  const setChainIdAbi = parseAbi([
    'function setDeBridgeChainId(uint256 chainId, uint256 deBridgeChainId)',
  ])

  const payloads: Hex[] = mappings.map((m) =>
    encodeFunctionData({
      abi: setChainIdAbi,
      functionName: 'setDeBridgeChainId',
      args: [m.chainId, m.deBridgeChainId],
    })
  )

  const targets: Address[] = mappings.map(() => diamondAddress)
  const values: bigint[] = mappings.map(() => 0n)

  // Fetch minDelay from timelock on-chain
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

  // Encode scheduleBatch call
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

    // Ensure signer is an owner (avoid creating proposals with non-owner key)
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
    name: 'propose-debridge-dln-chainid-mappings',
    description:
      'Creates Safe proposals (timelock scheduleBatch) to update DeBridge DLN chainId mappings on all networks where DeBridgeDlnFacet is deployed',
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
        'Optional Safe signer private key (defaults to PRIVATE_KEY_PRODUCTION from .env).',
      required: false,
    },
  },
  async run({ args }) {
    const environment = castEnv(args.environment)
    const mappings = loadDeBridgeMappings()

    const excludeSet = new Set<string>()
    if (args.excludeNetworks) {
      const parsed = JSON.parse(args.excludeNetworks) as unknown
      if (!Array.isArray(parsed))
        throw new Error('--excludeNetworks must be a JSON array of strings')
      for (const n of parsed) excludeSet.add(String(n).toLowerCase())
    }

    const privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)

    // Determine networks to process
    const networksToCheck = args.network
      ? [args.network]
      : getAllActiveNetworks().map((n) => n.id)

    const eligibleNetworks: string[] = []
    for (const network of networksToCheck) {
      if (excludeSet.has(network.toLowerCase())) continue

      const deployments = readDeploymentsFile(network, environment)
      if (!deployments) continue

      const facetAddress = deployments.DeBridgeDlnFacet
      if (!isNonZeroAddressString(facetAddress)) continue

      eligibleNetworks.push(network)
    }

    if (eligibleNetworks.length === 0) {
      consola.warn(
        'No eligible networks found (DeBridgeDlnFacet not deployed).'
      )
      return
    }

    consola.info(
      `Found ${
        eligibleNetworks.length
      } network(s) with DeBridgeDlnFacet deployed: ${eligibleNetworks.join(
        ', '
      )}`
    )
    consola.info(`Mappings to apply: ${mappings.length}`)

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

        const calldata = await buildTimelockScheduleBatchCalldata({
          network,
          timelockAddress,
          diamondAddress,
          mappings,
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
