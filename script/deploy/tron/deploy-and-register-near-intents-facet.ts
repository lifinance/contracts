#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import {
  getEnvVar,
  getPrivateKeyForEnvironment,
} from '../../demoScripts/utils/demoScriptHelpers'
import {
  getRPCEnvVarName,
  getEnvironment,
  getContractAddress,
  checkExistingDeployment,
  confirmDeployment,
  printDeploymentSummary,
  displayNetworkInfo,
  displayRegistrationInfo,
  getFacetSelectors,
  proposeDiamondCut,
} from '../../utils/utils'
import { getContractVersion } from '../shared/getContractVersion'

import { TronContractDeployer } from './TronContractDeployer'
import { MIN_BALANCE_WARNING } from './constants'
import { createTronWeb } from './helpers/tronWebFactory'
import { tronAddressToHex } from './tronAddressHelpers'
import { deployContractWithLogging, validateBalance } from './tronUtils'
import type { ITronDeploymentConfig, TronTvmNetworkName } from './types'

async function deployAndRegisterNEARIntentsFacet(options: {
  dryRun?: boolean
}) {
  consola.start('TRON NEARIntentsFacet Deployment & Registration')

  const environment = getEnvironment()

  const dryRun = options.dryRun ?? false
  let verbose = true

  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {}

  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

  const network = networkName as SupportedChain

  const envVarName = getRPCEnvVarName(network)
  const rpcUrl = getEnvVar(envVarName)

  let privateKey: string
  try {
    privateKey = getPrivateKeyForEnvironment(environment)
  } catch (error: any) {
    consola.error(error.message)
    consola.error(
      `Please ensure ${
        environment === EnvironmentEnum.production
          ? 'PRIVATE_KEY_PRODUCTION'
          : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  const config: ITronDeploymentConfig = {
    fullHost: rpcUrl,
    tvmNetworkKey: networkName as TronTvmNetworkName,
    privateKey,
    verbose,
    dryRun,
    safetyMargin: 1.5,
    maxRetries: 3,
    confirmationTimeout: 120000,
  }

  const deployer = new TronContractDeployer(config)

  try {
    const networkInfo = await deployer.getNetworkInfo()

    displayNetworkInfo(networkInfo, environment, rpcUrl)

    const tronWeb = createTronWeb({
      rpcUrl,
      networkKey: networkName as TronTvmNetworkName,
      privateKey,
    })

    await validateBalance(tronWeb, MIN_BALANCE_WARNING)

    const nearIntentsConfig = await Bun.file('config/nearintents.json').json()
    const envKey =
      environment === EnvironmentEnum.production ? 'production' : 'staging'
    const networkConfig = nearIntentsConfig[envKey]

    if (!networkConfig)
      throw new Error(
        `Configuration for '${envKey}' not found in config/nearintents.json`
      )

    const backendSigner = networkConfig.backendSigner

    if (!backendSigner)
      throw new Error(
        `backendSigner not found for '${envKey}' in config/nearintents.json`
      )

    consola.info('\nNEARIntents Configuration:')
    consola.info(`Backend Signer: ${backendSigner}`)

    const contracts = ['NEARIntentsFacet']

    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    consola.info('\nDeploying NEARIntentsFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      network,
      'NEARIntentsFacet',
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'NEARIntentsFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('NEARIntentsFacet'),
        status: 'existing',
      })
    } else
      try {
        const constructorArgs = [backendSigner]

        const result = await deployContractWithLogging(
          deployer,
          'NEARIntentsFacet',
          constructorArgs,
          dryRun,
          network
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy NEARIntentsFacet:', error.message)
        deploymentResults.push({
          contract: 'NEARIntentsFacet',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        printDeploymentSummary(deploymentResults, dryRun)
        process.exit(1)
      }

    consola.info('\nProposing NEARIntentsFacet diamondCut to Safe...')

    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    const selectors = await getFacetSelectors('NEARIntentsFacet')

    displayRegistrationInfo(
      'NEARIntentsFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    await proposeDiamondCut({
      facetName: 'NEARIntentsFacet',
      facetAddressHex: tronAddressToHex(tronWeb, facetAddress) as `0x${string}`,
      diamondAddress,
      network: network,
      dryRun,
    })

    printDeploymentSummary(deploymentResults, dryRun)

    consola.success('\nDeployment and proposal completed successfully!')
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    if (error.stack) consola.error(error.stack)
    process.exit(1)
  }
}

const main = defineCommand({
  meta: {
    name: 'deploy-and-register-near-intents-facet',
    description: 'Deploy and register NEARIntentsFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterNEARIntentsFacet({
      dryRun: args.dryRun,
    })
  },
})

runMain(main)
