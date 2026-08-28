#!/usr/bin/env bun

/**
 * Propose Frax chainId-to-LayerZero-EID mapping updates (batch)
 *
 * For each network where FraxFacet is deployed, this script:
 * 1) Reads mappings from config/frax.json
 * 2) Multicalls getFraxChainIdToEid on the diamond and keeps only rows that
 *    are unset (UnsupportedChainId) or differ from config
 * 3) Builds a LiFiDiamond.setFraxChainIdToEid(ChainIdConfig[]) call
 * 4) Wraps them in TimelockController.scheduleBatch(...)
 * 5) Proposes the transaction to the network Safe and stores it in MongoDB
 *
 * Example:
 * bunx tsx script/tasks/proposeFraxChainIdMappings.ts --environment production
 *
 * Single network:
 * bunx tsx script/tasks/proposeFraxChainIdMappings.ts --network arbitrum --environment production
 *
 * Preview without proposing:
 * bunx tsx script/tasks/proposeFraxChainIdMappings.ts --environment production --dryRun
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

import {
  encodeSetFraxChainIdToEid,
  GET_FRAX_CHAIN_ID_TO_EID_ABI,
  getRevertData,
  loadFraxMappings,
  type IFraxChainIdMapping,
} from './fraxChainIdMappings'

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

async function filterMappingsNeedingUpdate(params: {
  network: string
  diamondAddress: Address
  mappings: IFraxChainIdMapping[]
}): Promise<IFraxChainIdMapping[]> {
  const { network, diamondAddress, mappings } = params

  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({ chain, transport: http() })

  const errorsAbi = parseAbi([
    'error UnsupportedChainId(uint256 chainId)',
    // the diamond's fallback when the selector is not routed — a facet whose
    // bytecode is deployed but whose diamondCut has not executed yet
    'error FunctionDoesNotExist()',
  ])

  const results = await client.multicall({
    contracts: mappings.map((m) => ({
      address: diamondAddress,
      abi: GET_FRAX_CHAIN_ID_TO_EID_ABI,
      functionName: 'getFraxChainIdToEid',
      args: [m.chainId],
    })),
    allowFailure: true,
  })

  const needingUpdate: IFraxChainIdMapping[] = []

  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i]
    const result = results[i]
    if (!mapping || !result)
      throw new Error(`Missing multicall result for mapping index ${i}`)

    if (result.status === 'success') {
      if (Number(result.result) !== mapping.lzEid) needingUpdate.push(mapping)
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
        if (decoded.errorName === 'FunctionDoesNotExist')
          throw new Error(
            `FraxFacet is not cut into the diamond on ${network} yet (getFraxChainIdToEid is unrouted). ` +
              `Its address is in the deployment log, but the diamondCut that runs initFrax has not executed — ` +
              `execute that cut before propagating mappings.`
          )
      } catch (e: unknown) {
        // rethrow our own diagnosis; a decode miss just means some other revert
        if (
          e instanceof Error &&
          e.message.includes('not cut into the diamond')
        )
          throw e
      }
    }

    const message =
      result.error instanceof Error
        ? result.error.message
        : String(result.error)
    throw new Error(
      `Failed to read ${mappings.length} chainId(s) on ${network} (first: ` +
        `${mapping.chainId.toString()}): ${message}`
    )
  }

  return needingUpdate
}

async function buildTimelockScheduleBatchCalldata(params: {
  network: string
  timelockAddress: Address
  diamondAddress: Address
  mappings: IFraxChainIdMapping[]
}): Promise<Hex> {
  const { network, timelockAddress, diamondAddress, mappings } = params

  const payload = encodeSetFraxChainIdToEid(mappings)

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
    if (!isAddressASafeOwner(owners, safe.account.address))
      throw new Error(
        `Signer ${safe.account.address} is not an owner of Safe ${safeAddress} on ${network}`
      )

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

    consola.success(
      `[${network}] ✅ Proposed Safe tx ${safeTxHash} (nonce ${nextNonce})`
    )
  } finally {
    await mongoClient.close()
  }
}

const main = defineCommand({
  meta: {
    name: 'propose-frax-chainid-mappings',
    description:
      'Creates Safe proposals (timelock scheduleBatch) to update Frax chainId-to-LayerZero-EID mappings on all networks where FraxFacet is deployed',
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
    dryRun: {
      type: 'boolean',
      description:
        'Report the per-network diff and skip proposing (no signer key needed).',
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
    const mappings = loadFraxMappings()

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
    const privateKey = args.dryRun
      ? undefined
      : getPrivateKey(keyName, args.privateKey)

    const networksToCheck = args.network
      ? [args.network]
      : getAllActiveNetworks().map((n) => n.id)

    const eligibleNetworks: string[] = []
    for (const network of networksToCheck) {
      if (excludeSet.has(network.toLowerCase())) continue
      if (isTestnetNetwork(network)) continue

      const deployments = readDeploymentsFile(network, environment)
      if (!deployments) continue

      if (!isNonZeroAddressString(deployments.FraxFacet)) continue

      eligibleNetworks.push(network)
    }

    if (eligibleNetworks.length === 0) {
      consola.error(
        `No eligible networks found: FraxFacet is not present in any ${environment} deployment log. ` +
          `Nothing was proposed.`
      )
      process.exitCode = 1
      return
    }

    consola.info(
      `Found ${
        eligibleNetworks.length
      } network(s) with FraxFacet deployed: ${eligibleNetworks.join(', ')}`
    )
    consola.info(`Mappings in config: ${mappings.length}`)

    const results: Array<{ network: string; ok: boolean; error?: string }> = []

    for (const network of eligibleNetworks)
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

        const diamondAddress = getAddress(diamondRaw as Address)

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
          `[${network}] ${mappingsToUpdate.length}/${
            mappings.length
          } mapping(s) need update: ${mappingsToUpdate
            .map((m) => `${m.chainId.toString()}->${m.lzEid}`)
            .join(', ')}`
        )

        if (args.dryRun) {
          results.push({ network, ok: true })
          continue
        }

        // only needed to build the proposal, so it must not gate the dry-run diff
        if (!isNonZeroAddressString(timelockRaw))
          throw new Error(
            `Missing LiFiTimelockController deployment on ${network}`
          )

        const timelockAddress = getAddress(timelockRaw as Address)

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
