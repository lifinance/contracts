#!/usr/bin/env -S bunx tsx

import { readFile } from 'node:fs/promises'

import {
  MIN_BALANCE_WARNING,
  TronContractDeployer,
  createTronWeb,
  getTronRPCConfig,
  tronAddressToHex,
  type ITronDeploymentConfig,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import { redactUrls } from '../../utils/redactUrls'
import {
  getEnvVar,
  saveDiamondDeployment,
  getEnvironment,
  checkExistingDeployment,
  confirmDeployment,
  findContractAddress,
  printDeploymentSummary,
  displayNetworkInfo,
  updateDiamondJsonBatch,
} from '../../utils/utils'
import { flagIsOn, readBooleanFlag } from '../safe/cli-flags'
import { getContractVersion } from '../shared/getContractVersion'
import { getCoreFacets } from '../shared/globalContractLists'

import { buildForgeArtifactsOrThrow } from './assertTronToolchain'
import {
  assertDiamondConstructorShape,
  resolveCoreFacetConstructorArgs,
  DIAMOND_CONSTRUCTOR_PARAMS,
  type DiamondConstructorArgs,
} from './helpers/coreFacetConstructorArgs'
import {
  planUnnamedDiamond,
  selectCoreContracts,
} from './helpers/coreFacetSelection'
import {
  deployContractWithLogging,
  tronExistingDeploymentMode,
  validateBalance,
  waitBetweenDeployments,
} from './tronUtils.js'
import type { TDiamondPlan } from './types'

/**
 * Decides what the run does with LiFiDiamond: a named diamond is reused or redeployed like
 * any other contract; an unnamed one is never replaced.
 */
async function planDiamond(
  network: SupportedChain,
  named: boolean,
  onlyGiven: boolean,
  tronWeb: TronWeb
): Promise<TDiamondPlan> {
  const diamondName = 'LiFiDiamond'
  if (named) {
    const existing = await checkExistingDeployment(
      network,
      diamondName,
      tronExistingDeploymentMode(false, diamondName, tronWeb)
    )
    return existing.exists && existing.address && !existing.shouldRedeploy
      ? { action: 'reuse', address: existing.address }
      : { action: 'deploy' }
  }

  const recorded = await findContractAddress(network, diamondName)
  const plan = planUnnamedDiamond({
    onlyGiven,
    recordedAddress:
      recorded && !recorded.fromOtherNetwork ? recorded.address : null,
  })
  if (plan.action === 'reuse')
    consola.info(
      `${diamondName}: reusing ${plan.address} (redeployed only when --only names it)`
    )
  if (plan.action === 'deploy')
    consola.info(
      `${diamondName}: deploying (no address recorded for ${network})`
    )
  return plan
}

/**
 * Deploy core facets implementation
 */
async function deployCoreFacetsImpl(options: {
  dryRun: boolean
  verbose: boolean
  delaySeconds: number
  skipConfirmation: boolean
  onlyContracts: string[] | undefined
}) {
  consola.start('TRON Core Facets Deployment')
  const diamondName = 'LiFiDiamond'
  const { facets: coreFacets, diamondNamed } = selectCoreContracts(
    getCoreFacets({ exclude: ['GasZipFacet'] }),
    options.onlyContracts
  )
  buildForgeArtifactsOrThrow()

  const environment = getEnvironment()

  // Load networks configuration once
  const networksConfig = JSON.parse(
    await readFile('config/networks.json', 'utf8')
  )

  // Get network configuration from networks.json
  // Use tronshasta for staging/testnet, tron for production
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

  const tronConfig = networksConfig[networkName]
  if (!tronConfig) {
    consola.error(`Network configuration not found for: ${networkName}`)
    consola.error(
      `Please ensure "${networkName}" network is configured in config/networks.json`
    )
    process.exit(1)
  }

  const network = networkName as SupportedChain // Use network name, not RPC URL

  // Get RPC URL and API key configuration (automatically handles TronGrid API key)
  const { rpcUrl, headers } = getTronRPCConfig(networkName, options.verbose)

  consola.info(`RPC URL: ${redactUrls(rpcUrl)}`)

  // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = getPrivateKeyForEnvironment(environment)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    consola.error(errorMessage)
    consola.error(
      `Please ensure ${
        environment === EnvironmentEnum.production
          ? 'PRIVATE_KEY_PRODUCTION'
          : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: rpcUrl,
    tvmNetworkKey: networkName as TronTvmNetworkName,
    privateKey,
    verbose: options.verbose,
    dryRun: options.dryRun,
    maxRetries: 3,
    confirmationTimeout: 120000,
    headers,
  }

  const deployer = new TronContractDeployer(config)

  // Get network info
  const networkInfo = await deployer.getNetworkInfo()
  displayNetworkInfo(networkInfo, environment, rpcUrl)

  const tronWeb = createTronWeb({
    rpcUrl,
    networkKey: networkName as TronTvmNetworkName,
    privateKey,
    headers,
    verbose: options.verbose,
  })

  // Validate balance
  await validateBalance(tronWeb, MIN_BALANCE_WARNING)

  confirmDeployment(
    environment,
    network,
    [
      ...coreFacets,
      ...(diamondNamed || !options.onlyContracts ? [diamondName] : []),
    ],
    { skipConfirmation: options.skipConfirmation, dryRun: options.dryRun }
  )

  // Now check for existing deployments (sequentially to avoid event listener warnings)
  consola.info(`\nCore facets to deploy: ${coreFacets.length}`)
  coreFacets.forEach((facet, i) => {
    consola.info(`  ${i + 1}. ${facet}`)
  })

  const existingDeployments: {
    exists: boolean
    address: string | null
    shouldRedeploy: boolean
  }[] = []
  for (const facet of coreFacets) {
    const deployment = await checkExistingDeployment(
      network,
      facet,
      tronExistingDeploymentMode(false, facet, tronWeb)
    )
    existingDeployments.push(deployment)
  }

  const reused = (d: (typeof existingDeployments)[number]) =>
    d.exists && d.address !== null && !d.shouldRedeploy
  if (existingDeployments.some(reused)) {
    consola.info('\nReusing existing deployments:')
    existingDeployments.forEach((d, index) => {
      if (reused(d)) consola.info(`  ✓ ${coreFacets[index]}: ${d.address}`)
    })
  }
  // Resolved before the first deployment, and only for facets that will be
  // deployed: a facet whose arguments cannot be built stops the run while
  // nothing has been spent
  const constructorArgsByFacet = await resolveCoreFacetConstructorArgs(
    coreFacets.filter((_, index) => {
      const existing = existingDeployments[index]
      return !(existing?.exists && existing.address && !existing.shouldRedeploy)
    }),
    network,
    networksConfig
  )

  const diamondPlan = await planDiamond(
    network,
    diamondNamed,
    options.onlyContracts !== undefined,
    tronWeb
  )
  // The diamond is deployed after every facet, so a mismatch in its constructor
  // surfaces only once they have all been paid for.
  if (diamondPlan.action === 'deploy')
    await assertDiamondConstructorShape(
      diamondName,
      network,
      DIAMOND_CONSTRUCTOR_PARAMS.length
    )

  // Deploy facets
  const deploymentResults: IDeploymentResult[] = []
  const facetAddresses: Record<string, { address: string; version: string }> =
    {}

  for (let i = 0; i < coreFacets.length; i++) {
    const facet = coreFacets[i]
    if (!facet) continue

    const existing = existingDeployments[i]

    // Check if already deployed and not requesting redeploy
    if (existing?.exists && existing.address && !existing.shouldRedeploy) {
      consola.info(`\n⏭️  Skipping ${facet} (already deployed)`)
      const version = await getContractVersion(facet)
      deploymentResults.push({
        contract: facet,
        address: existing.address,
        version,
        txId: '',
        cost: 0,
        status: 'existing',
      })
      facetAddresses[facet] = {
        address: existing.address,
        version,
      }
      continue
    }
    consola.info(`\n📦 Deploying ${facet}...`)

    try {
      const constructorArgs = constructorArgsByFacet.get(facet)
      if (!constructorArgs)
        throw new Error(`No constructor arguments resolved for ${facet}`)

      // Deploy the facet
      const result = await deployContractWithLogging(
        deployer,
        facet,
        constructorArgs,
        options.dryRun,
        network
      )

      deploymentResults.push(result)

      // Add delay between deployments to avoid rate limiting
      await waitBetweenDeployments(options.delaySeconds, options.verbose)

      if (result.status === 'success' && result.address)
        facetAddresses[facet] = {
          address: result.address,
          version: result.version,
        }
      // Note: deployContractWithLogging already handles saving addresses and logging
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(`Failed to deploy ${facet}: ${errorMessage}`)
      deploymentResults.push({
        contract: facet,
        address: '',
        version: '',
        txId: '',
        cost: 0,
        status: 'failed',
      })

      // Add delay even after failures to avoid rate limiting
      await waitBetweenDeployments(options.delaySeconds, options.verbose)
    }
  }

  if (diamondPlan.action === 'skip')
    consola.info(
      `\n⏭️  Skipping ${diamondName} (not named in --only and none recorded for ${network})`
    )
  else if (diamondPlan.action === 'reuse') {
    consola.info(`\n⏭️  Skipping ${diamondName} (already deployed)`)
    const version = await getContractVersion(diamondName)
    deploymentResults.push({
      contract: diamondName,
      address: diamondPlan.address,
      version,
      txId: '',
      cost: 0,
      status: 'existing',
    })
  } else
    try {
      consola.info(`\n💎 Deploying ${diamondName}...`)
      // Get owner address (deployer address)
      const ownerAddress = networkInfo.address
      const ownerHex = tronAddressToHex(tronWeb, ownerAddress)

      const diamondCutFacet = facetAddresses['DiamondCutFacet']
      if (!diamondCutFacet)
        throw new Error(
          `${diamondName} takes the DiamondCutFacet address, but DiamondCutFacet has no address in this run — its deployment failed, or --only did not name it. The diamond cannot be assembled without it.`
        )

      const diamondCutFacetHex = tronAddressToHex(
        tronWeb,
        diamondCutFacet.address
      )

      consola.info(`Using owner address: ${ownerAddress} (hex: ${ownerHex})`)
      consola.info(
        `Using DiamondCutFacet: ${diamondCutFacet.address} (hex: ${diamondCutFacetHex})`
      )

      // Keyed by the same const the pre-flight probe counts, so adding a
      // parameter there fails to compile until it is supplied here too.
      const diamondArgs: DiamondConstructorArgs = {
        owner: ownerHex,
        diamondCutFacet: diamondCutFacetHex,
      }

      // Deploy the Diamond
      const result = await deployContractWithLogging(
        deployer,
        diamondName,
        DIAMOND_CONSTRUCTOR_PARAMS.map((param) => diamondArgs[param]),
        options.dryRun,
        network
      )

      deploymentResults.push(result)

      if (result.status === 'success' && result.address)
        if (!options.dryRun) {
          // Note: deployContractWithLogging already handles saving addresses and logging
          // Save diamond-specific deployment info
          await saveDiamondDeployment(network, result.address, facetAddresses)

          // Update diamond JSON files
          const facetEntries = Object.entries(facetAddresses).map(
            ([name, data]) => ({
              name,
              address: data.address,
              version: data.version,
            })
          )
          await updateDiamondJsonBatch(facetEntries, network)
        }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(`Failed to deploy ${diamondName}: ${errorMessage}`)
      deploymentResults.push({
        contract: diamondName,
        address: '',
        version: '',
        txId: '',
        cost: 0,
        status: 'failed',
      })
    }

  // If diamond already existed, still update the diamond JSON with facet addresses
  if (diamondPlan.action === 'reuse' && !options.dryRun) {
    // Update diamond JSON files
    const facetEntries = Object.entries(facetAddresses).map(([name, data]) => ({
      name,
      address: data.address,
      version: data.version,
    }))
    await updateDiamondJsonBatch(facetEntries, network)
  }

  // Use new utility for summary
  printDeploymentSummary(deploymentResults, options.dryRun)

  // Exit with appropriate code
  const hasFailures = deploymentResults.some((r) => r.status === 'failed')
  process.exit(hasFailures ? 1 : 0)
}

const deployCommand = defineCommand({
  meta: {
    name: 'deploy-core-facets',
    description: 'Deploy core facets to Tron network',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Simulate deployment without executing',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      default: true,
    },
    delaySeconds: {
      type: 'string',
      description: 'Number of seconds to wait between deployments (default: 5)',
    },
    skipConfirmation: {
      type: 'boolean',
      description:
        'Confirm a production deploy up front; production refuses to broadcast without it',
    },
    only: {
      type: 'string',
      description:
        'Comma-separated core facets to deploy (e.g. DiamondLoupeFacet). A recorded LiFiDiamond is kept unless named here (with DiamondCutFacet); a named one is reused when its code matches this build.',
    },
  },
  async run({ args }) {
    try {
      // Also check environment variables for backward compatibility
      let dryRun = flagIsOn(args.dryRun)
      let verbose = args.verbose

      try {
        if (!dryRun) dryRun = getEnvVar('DRY_RUN') === 'true'
      } catch {
        // Use default value
      }

      try {
        if (!verbose) verbose = getEnvVar('VERBOSE') !== 'false'
      } catch {
        // Use default value
      }

      // Parse delaySeconds from string to number
      let delaySeconds = 5 // default
      try {
        // First try command line argument
        if (args.delaySeconds !== undefined) {
          const parsed = parseInt(String(args.delaySeconds), 10)
          if (!isNaN(parsed) && parsed >= 0) {
            delaySeconds = parsed
          } else {
            consola.warn(
              `Invalid delaySeconds value: "${args.delaySeconds}", using default: 5`
            )
          }
        }
      } catch {
        // Use default value
      }

      await deployCoreFacetsImpl({
        dryRun,
        verbose,
        delaySeconds,
        skipConfirmation: readBooleanFlag(process.argv, {
          camel: 'skipConfirmation',
          kebab: 'skip-confirmation',
        }),
        onlyContracts: args.only
          ?.split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      })
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined
      consola.error('Deployment failed:', errorMessage)
      if (errorStack) consola.error(errorStack)
      process.exit(1)
    }
  },
})

// Run the command
runMain(deployCommand)
