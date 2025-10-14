#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import type { SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import {
  getEnvVar,
  getPrivateKeyForEnvironment,
} from '../../demoScripts/utils/demoScriptHelpers'
import { getRPCEnvVarName } from '../../utils/network'

import { TronContractDeployer } from './TronContractDeployer'
import { MIN_BALANCE_WARNING } from './constants'
import type { ITronDeploymentConfig, IDeploymentResult } from './types'
import {
  getContractVersion,
  getEnvironment,
  getContractAddress,
  checkExistingDeployment,
  deployContractWithLogging,
  registerFacetToDiamond,
  confirmDeployment,
  printDeploymentSummary,
  validateBalance,
  displayNetworkInfo,
  displayRegistrationInfo,
  getFacetSelectors,
  tronAddressToHex,
} from './utils'

async function deployAndRegisterEcoFacet(options: { dryRun?: boolean }) {
  consola.start('TRON EcoFacet Deployment & Registration')

  const environment = await getEnvironment()

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

    displayNetworkInfo(networkInfo, environment, network)

    const tronWeb = new TronWeb({
      fullHost: rpcUrl,
      privateKey,
    })

    await validateBalance(tronWeb, MIN_BALANCE_WARNING)

    const ecoConfig = await Bun.file('config/eco.json').json()
    const tronEcoConfig = ecoConfig.tron

    if (!tronEcoConfig)
      throw new Error('Tron configuration not found in config/eco.json')

    const portalTron = tronEcoConfig.portal

    if (!portalTron)
      throw new Error('Eco portal not found for tron in config/eco.json')

    const portal = tronAddressToHex(portalTron, tronWeb)

    consola.info('\nEco Configuration:')
    consola.info(`Portal: ${portalTron} (hex: ${portal})`)

    const contracts = ['EcoFacet']

    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    consola.info('\nDeploying EcoFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      network,
      'EcoFacet',
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'EcoFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('EcoFacet'),
        status: 'existing',
      })
    } else
      try {
        const constructorArgs = [portal]

        const result = await deployContractWithLogging(
          deployer,
          'EcoFacet',
          constructorArgs,
          dryRun,
          network
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy EcoFacet:', error.message)
        deploymentResults.push({
          contract: 'EcoFacet',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        printDeploymentSummary(deploymentResults, dryRun)
        process.exit(1)
      }

    consola.info('\nRegistering EcoFacet to Diamond...')

    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    const selectors = await getFacetSelectors('EcoFacet')

    displayRegistrationInfo('EcoFacet', facetAddress, diamondAddress, selectors)

    const registrationResult = await registerFacetToDiamond(
      'EcoFacet',
      facetAddress,
      tronWeb,
      rpcUrl,
      dryRun,
      network
    )

    if (registrationResult.success) {
      consola.success('EcoFacet registered successfully!')
      if (registrationResult.transactionId)
        consola.info(`Transaction: ${registrationResult.transactionId}`)
    } else {
      consola.error('Failed to register EcoFacet:', registrationResult.error)
      process.exit(1)
    }

    printDeploymentSummary(deploymentResults, dryRun)

    consola.success('\nDeployment and registration completed successfully!')
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    if (error.stack) consola.error(error.stack)
    process.exit(1)
  }
}

const main = defineCommand({
  meta: {
    name: 'deploy-and-register-eco-facet',
    description: 'Deploy and register EcoFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterEcoFacet({
      dryRun: args.dryRun,
    })
  },
})

runMain(main)
