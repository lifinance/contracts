#!/usr/bin/env bun

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

const CONTRACT_NAME = 'LiFiIntentEscrowFacetV2'

async function deployAndRegisterLiFiIntentEscrowFacetV2(options: {
  dryRun?: boolean
}) {
  consola.start(`TRON ${CONTRACT_NAME} Deployment & Registration`)

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

    const escrowConfig = await Bun.file('config/lifiintentescrow.json').json()
    const tronEscrowConfig = escrowConfig[networkName]

    if (!tronEscrowConfig)
      throw new Error(
        `No "${networkName}" configuration found in config/lifiintentescrow.json`
      )

    const inputSettlerTron = tronEscrowConfig.lifiEscrowInputSettler

    if (!inputSettlerTron)
      throw new Error(
        `lifiEscrowInputSettler not found for ${networkName} in config/lifiintentescrow.json`
      )

    const inputSettler = tronAddressToHex(tronWeb, inputSettlerTron)

    consola.info('\nLiFi Intent Escrow Configuration:')
    consola.info(`InputSettler: ${inputSettlerTron} (hex: ${inputSettler})`)

    const contracts = [CONTRACT_NAME]

    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    consola.info(`\nDeploying ${CONTRACT_NAME}...`)

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      network,
      CONTRACT_NAME,
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: CONTRACT_NAME,
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion(CONTRACT_NAME),
        status: 'existing',
      })
    } else
      try {
        const constructorArgs = [inputSettler]

        const result = await deployContractWithLogging(
          deployer,
          CONTRACT_NAME,
          constructorArgs,
          dryRun,
          network
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error(`Failed to deploy ${CONTRACT_NAME}:`, error.message)
        deploymentResults.push({
          contract: CONTRACT_NAME,
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        printDeploymentSummary(deploymentResults, dryRun)
        process.exit(1)
      }

    consola.info(`\nProposing ${CONTRACT_NAME} diamondCut to Safe...`)

    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    const selectors = await getFacetSelectors(CONTRACT_NAME)

    displayRegistrationInfo(
      CONTRACT_NAME,
      facetAddress,
      diamondAddress,
      selectors
    )

    if (!dryRun)
      await proposeDiamondCut({
        facetName: CONTRACT_NAME,
        facetAddressHex: tronAddressToHex(
          tronWeb,
          facetAddress
        ) as `0x${string}`,
        diamondAddress,
        network: network,
      })
    else
      consola.info(
        `Dry run - skipping diamondCut proposal for ${CONTRACT_NAME}`
      )

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
    name: 'deploy-and-register-lifi-intent-escrow-facet-v2',
    description: `Deploy and register ${CONTRACT_NAME} to Tron Diamond`,
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterLiFiIntentEscrowFacetV2({
      dryRun: args.dryRun,
    })
  },
})

runMain(main)
