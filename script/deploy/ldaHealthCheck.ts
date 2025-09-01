#!/usr/bin/env node

import { execSync } from 'child_process'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

const errors: string[] = []

// Helper function to get RPC URL from networks.json
const getRpcUrl = (
  network: string,
  networksConfig: Record<string, { rpcUrl?: string }>
): string => {
  return networksConfig[network.toLowerCase()]?.rpcUrl || ''
}

// Helper function to check if contract is deployed using cast
const checkIsDeployedWithCast = async (
  contractName: string,
  deployedContracts: Record<string, string>,
  rpcUrl: string
): Promise<boolean> => {
  if (!deployedContracts[contractName]) return false

  try {
    const address = deployedContracts[contractName]
    const result = execSync(`cast code ${address} --rpc-url "${rpcUrl}"`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()

    // If the result is '0x' or empty, contract is not deployed
    return result !== '0x' && result !== ''
  } catch (error) {
    return false
  }
}

const main = defineCommand({
  meta: {
    name: 'LDA Diamond Health Check',
    description: 'Check that the LDA diamond is configured correctly',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
  },
  async run({ args }) {
    const { network } = args

    // Skip tronshasta testnet but allow tron mainnet
    if (network.toLowerCase() === 'tronshasta') {
      consola.info('Health checks are not implemented for Tron Shasta testnet.')
      consola.info('Skipping all tests.')
      process.exit(0)
    }

    // Determine if we're working with Tron mainnet
    const isTron = network.toLowerCase() === 'tron'

    if (isTron) {
      consola.info('LDA health checks for Tron are not yet implemented.')
      consola.info('Skipping all tests.')
      process.exit(0)
    }

    // Load LDA-specific deployments (production only)
    const ldaDeploymentFile = `../../deployments/${network.toLowerCase()}.lda.production.json`
    let ldaDeployedContracts: Record<string, string>

    try {
      const { default: contracts } = await import(ldaDeploymentFile)
      ldaDeployedContracts = contracts
    } catch (error) {
      consola.error(`Failed to load LDA deployment file: ${ldaDeploymentFile}`)
      consola.error(
        'Please ensure LDA contracts are deployed to production first.'
      )
      process.exit(1)
    }

    // Load main deployment file for shared infrastructure (like LiFiTimelockController)
    const mainDeploymentFile = `../../deployments/${network.toLowerCase()}.json`
    let mainDeployedContracts: Record<string, string> = {}

    try {
      const { default: contracts } = await import(mainDeploymentFile)
      mainDeployedContracts = contracts
    } catch (error) {
      consola.warn(`Failed to load main deployment file: ${mainDeploymentFile}`)
      consola.warn('Some shared infrastructure checks will be skipped.')
    }

    // Note: We keep LDA and main contracts separate for clarity

    // Load global config for LDA core facets
    const globalConfig = await import('../../config/global.json')
    const networksConfigModule = await import('../../config/networks.json')
    const networksConfig = networksConfigModule.default

    // Get LDA core facets from global config
    const ldaCoreFacets = globalConfig.ldaCoreFacets || []

    // Get RPC URL
    const rpcUrl = getRpcUrl(network, networksConfig)
    if (!rpcUrl) {
      consola.error(`No RPC URL found for network: ${network}`)
      process.exit(1)
    }

    consola.info('Running LDA Diamond post deployment checks...\n')

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check LDA Diamond Contract               │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking LDADiamond Contract...')
    const diamondDeployed = await checkIsDeployedWithCast(
      'LDADiamond',
      ldaDeployedContracts,
      rpcUrl
    )

    if (!diamondDeployed) {
      logError('LDADiamond not deployed')
      finish()
    } else consola.success('LDADiamond deployed')

    const diamondAddress = ldaDeployedContracts['LDADiamond']

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                    Check LDA core facets                │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking LDA Core Facets...')
    for (const facet of ldaCoreFacets) {
      const isDeployed = await checkIsDeployedWithCast(
        facet,
        ldaDeployedContracts,
        rpcUrl
      )

      if (!isDeployed) {
        logError(`LDA Facet ${facet} not deployed`)
        continue
      }
      consola.success(`LDA Facet ${facet} deployed`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │         Check that LDA facets are registered            │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking LDA facets registered in diamond...')

    let registeredFacets: string[] = []
    try {
      // Use cast to call facets() function
      const rawString = execSync(
        `cast call "${diamondAddress}" "facets() returns ((address,bytes4[])[])" --rpc-url "${rpcUrl}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      )

      const jsonCompatibleString = rawString
        .replace(/\(/g, '[')
        .replace(/\)/g, ']')
        .replace(/0x[0-9a-fA-F]+/g, '"$&"')

      const onChainFacets = JSON.parse(jsonCompatibleString)

      if (Array.isArray(onChainFacets)) {
        const configFacetsByAddress = Object.fromEntries(
          Object.entries(ldaDeployedContracts).map(([name, address]) => {
            return [address.toLowerCase(), name]
          })
        )

        registeredFacets = onChainFacets
          .map(([address]) => configFacetsByAddress[address.toLowerCase()])
          .filter(Boolean) as string[]
      }
    } catch (error) {
      consola.warn(
        'Unable to call facets() - skipping facet registration check'
      )
      consola.warn('Error:', (error as Error).message)
    }

    for (const facet of ldaCoreFacets)
      if (!registeredFacets.includes(facet))
        logError(
          `LDA Facet ${facet} not registered in Diamond or possibly unverified`
        )
      else consola.success(`LDA Facet ${facet} registered in Diamond`)

    // Basic ownership check using cast
    try {
      consola.box('Checking LDA Diamond ownership...')
      const owner = execSync(
        `cast call "${diamondAddress}" "owner() returns (address)" --rpc-url "${rpcUrl}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim()

      consola.info(`LDADiamond current owner: ${owner}`)

      // Check if timelock is deployed and compare (timelock is in main deployments, not LDA deployments)
      const timelockAddress = mainDeployedContracts['LiFiTimelockController']
      if (timelockAddress) {
        consola.info(`Found LiFiTimelockController at: ${timelockAddress}`)
        if (owner.toLowerCase() === timelockAddress.toLowerCase())
          consola.success('LDADiamond is owned by LiFiTimelockController')
        else
          logError(`LDADiamond owner is ${owner}, expected ${timelockAddress}`)
      } else {
        consola.error(
          'LiFiTimelockController not found in main deployments, so LDA diamond ownership cannot be verified'
        )
        consola.info(
          'Note: LiFiTimelockController should be deployed as shared infrastructure before LDA deployment'
        )
      }
    } catch (error) {
      logError(
        `Failed to check LDADiamond ownership: ${(error as Error).message}`
      )
    }

    finish()
  },
})

const logError = (msg: string) => {
  consola.error(msg)
  errors.push(msg)
}

const finish = () => {
  // this line ensures that all logs are actually written before the script ends
  process.stdout.write('', () => process.stdout.end())
  if (errors.length) {
    consola.error(`${errors.length} Errors found in LDA Diamond deployment`)
    process.exit(1)
  } else {
    consola.success('LDA Diamond deployment checks passed')
    process.exit(0)
  }
}

runMain(main)
