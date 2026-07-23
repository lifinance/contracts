#!/usr/bin/env bun

/**
 * Deploys LayerSwapFacet to the Tron Diamond and proposes its diamondCut to the
 * Tron Safe. Use this instead of the generic core-facet deploy because
 * LayerSwapFacet takes constructor arguments (the LayerSwap Depository address
 * and the backend signer), which the core-facet loop does not supply.
 */

import {
  MIN_BALANCE_WARNING,
  TronContractDeployer,
  createTronWeb,
  tronAddressToHex,
  type ITronDeploymentConfig,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import {
  getEnvVar,
  getRPCEnvVarName,
  getEnvironment,
  getContractAddress,
  checkExistingDeployment,
  confirmDeployment,
  printDeploymentSummary,
  displayNetworkInfo,
  displayRegistrationInfo,
  getFacetSelectors,
} from '../../utils/utils'
import { getContractVersion } from '../shared/getContractVersion'
import { proposeDiamondCut } from '../shared/propose-diamond-cut'

import { deployContractWithLogging, validateBalance } from './tronUtils'

/**
 * Deploy and register LayerSwapFacet to Tron.
 *
 * @param options - `dryRun` estimates and prints the plan without deploying or
 *        creating a Safe proposal.
 * @throws If required config (depository, backend signer, diamond address) is
 *         missing, or the deploy/propose step fails.
 */
async function deployAndRegisterLayerSwapFacet(options: { dryRun?: boolean }) {
  consola.start('TRON LayerSwapFacet Deployment & Registration')

  const environment = getEnvironment()

  const dryRun = options.dryRun ?? false
  let verbose = true

  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {
    // Use default value
  }

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

    const layerSwapConfig = await Bun.file('config/layerswap.json').json()
    const depositoryRaw = layerSwapConfig.layerSwapDepository?.[networkName]

    if (!depositoryRaw)
      throw new Error(
        `LayerSwap depository not found for '${networkName}' in config/layerswap.json`
      )

    const globalConfig = await Bun.file('config/global.json').json()
    const envKey =
      environment === EnvironmentEnum.production ? 'production' : 'staging'
    const backendSignerRaw = globalConfig.backendSigner?.[envKey]

    if (!backendSignerRaw)
      throw new Error(
        `backendSigner not found for '${envKey}' in config/global.json`
      )

    const depository = tronAddressToHex(tronWeb, depositoryRaw)
    const backendSigner = tronAddressToHex(tronWeb, backendSignerRaw)

    consola.info('\nLayerSwap Configuration:')
    consola.info(`Depository: ${depositoryRaw} (hex: ${depository})`)
    consola.info(`Backend Signer: ${backendSignerRaw} (hex: ${backendSigner})`)

    const contracts = ['LayerSwapFacet']

    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    consola.info('\nDeploying LayerSwapFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      network,
      'LayerSwapFacet',
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'LayerSwapFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('LayerSwapFacet'),
        status: 'existing',
      })
    } else
      try {
        const constructorArgs = [depository, backendSigner]

        const result = await deployContractWithLogging(
          deployer,
          'LayerSwapFacet',
          constructorArgs,
          dryRun,
          network
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy LayerSwapFacet:', error.message)
        deploymentResults.push({
          contract: 'LayerSwapFacet',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        printDeploymentSummary(deploymentResults, dryRun)
        process.exit(1)
      }

    consola.info('\nProposing LayerSwapFacet diamondCut to Safe...')

    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    const selectors = await getFacetSelectors('LayerSwapFacet')

    displayRegistrationInfo(
      'LayerSwapFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    if (!dryRun)
      await proposeDiamondCut({
        facetName: 'LayerSwapFacet',
        facetAddressHex: tronAddressToHex(
          tronWeb,
          facetAddress
        ) as `0x${string}`,
        diamondAddress,
        network: network,
      })
    else
      consola.info('Dry run - skipping diamondCut proposal for LayerSwapFacet')

    printDeploymentSummary(deploymentResults, dryRun)

    consola.success(
      dryRun
        ? '\nDry run completed successfully! (no Safe tx created)'
        : '\nDeployment and proposal completed successfully!'
    )
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    if (error.stack) consola.error(error.stack)
    process.exit(1)
  }
}

const main = defineCommand({
  meta: {
    name: 'deploy-and-register-layerswap-facet',
    description: 'Deploy and register LayerSwapFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterLayerSwapFacet({
      dryRun: args.dryRun,
    })
  },
})

runMain(main)
