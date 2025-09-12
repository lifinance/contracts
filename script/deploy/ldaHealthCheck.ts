#!/usr/bin/env node

// LiFi DEX Aggregator (LDA) diamond health check script
// - validates LDA diamond contract deployment
// - checks availability of LDA core facets (shared with regular LiFi Diamond)
// - verifies all facets are properly registered in the diamond
// - validates diamond ownership (multisig for production, deployer for staging)

import { execSync } from 'child_process'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { SupportedChain } from '../common/types'
import { getRpcUrl } from '../demoScripts/utils/demoScriptHelpers'

const errors: string[] = []

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
    environment: {
      type: 'string',
      description: 'Environment to check (staging or production)',
      default: 'production',
    },
  },
  async run({ args }) {
    const { network, environment } = args

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

    // Validate environment
    if (environment !== 'staging' && environment !== 'production') {
      consola.error(
        `Invalid environment: ${environment}. Must be 'staging' or 'production'.`
      )
      process.exit(1)
    }

    // Load deployment file (contains LiFiDEXAggregatorDiamond address and shared infrastructure)
    let deployedContracts: Record<string, string> = {}
    const productionDeploymentFile = `../../deployments/${network.toLowerCase()}.json`

    if (environment === 'staging') {
      const stagingFile = `../../deployments/${network.toLowerCase()}.staging.json`
      consola.info(`Loading staging deployment file: ${stagingFile}`)
      try {
        const { default: contracts } = await import(stagingFile, {
          with: { type: 'json' },
        })
        deployedContracts = contracts
        consola.info(
          `Successfully loaded ${
            Object.keys(contracts).length
          } contracts from staging file`
        )
      } catch (error) {
        consola.error(`Failed to load staging deployment file: ${stagingFile}`)
        consola.error(`Error: ${error}`)
        consola.error(
          'Cannot proceed with staging environment without staging deployment file.'
        )
        process.exit(1)
      }
    }
    // Production - use production deployment file
    else {
      consola.info(
        `Loading production deployment file: ${productionDeploymentFile}`
      )
      try {
        const { default: contracts } = await import(productionDeploymentFile, {
          with: { type: 'json' },
        })
        deployedContracts = contracts
        consola.info(
          `Successfully loaded ${
            Object.keys(contracts).length
          } contracts from production file`
        )
      } catch (error) {
        consola.error(
          `Failed to load production deployment file: ${productionDeploymentFile}`
        )
        consola.error(`Error: ${error}`)
        consola.error('Cannot verify LDA diamond and core facets availability.')
        process.exit(1)
      }
    }

    // Load LDA-specific facet information
    const ldaDeploymentFile =
      environment === 'production'
        ? `../../deployments/${network.toLowerCase()}.diamond.lda.json`
        : `../../deployments/${network.toLowerCase()}.diamond.lda.${environment}.json`
    let ldaFacetInfo: Record<
      string,
      { Facets?: Record<string, { Name?: string; Version?: string }> }
    > = {}

    try {
      const { default: ldaData } = await import(ldaDeploymentFile, {
        with: { type: 'json' },
      })
      ldaFacetInfo = ldaData
    } catch (error) {
      consola.error(`Failed to load LDA facet file: ${ldaDeploymentFile}`)
      consola.error(
        `Please ensure LDA diamond logs are updated after deployment.`
      )
      process.exit(1)
    }

    // Load global config for LDA core facets
    const globalConfig = await import('../../config/global.json', {
      with: { type: 'json' },
    })
    const networksConfigModule = await import('../../config/networks.json', {
      with: { type: 'json' },
    })
    const networksConfig = networksConfigModule.default

    // Get LDA core facets from global config
    const ldaCoreFacets = globalConfig.ldaCoreFacets || []

    // Get RPC URL
    const rpcUrl = getRpcUrl(network as SupportedChain)
    if (!rpcUrl) {
      consola.error(`No RPC URL found for network: ${network}`)
      process.exit(1)
    }

    consola.info(
      `Running LDA Diamond post deployment checks for ${environment}...\n`
    )

    //          ╭─────────────────────────────────────────────────────────╮
    //          │    Check LDA diamond contract full deployment           │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking LDA diamond contract full deployment...')

    const diamondAddress = deployedContracts['LiFiDEXAggregatorDiamond']
    consola.info(
      `Looking for LiFiDEXAggregatorDiamond at address: ${diamondAddress}`
    )
    consola.info(
      `Available contracts in deployedContracts: ${Object.keys(
        deployedContracts
      )
        .filter((k) => k.includes('LiFi'))
        .join(', ')}`
    )

    const diamondDeployed = await checkIsDeployedWithCast(
      'LiFiDEXAggregatorDiamond',
      deployedContracts,
      rpcUrl
    )

    if (!diamondDeployed) {
      logError('LiFiDEXAggregatorDiamond not deployed')
      finish()
    } else consola.success('LiFiDEXAggregatorDiamond deployed')

    //          ╭─────────────────────────────────────────────────────────╮
    //          │              Check LDA core facets availability         │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking LDA Core Facets Availability...')
    consola.info(
      'LDA core facets are shared with regular LiFi Diamond and stored in regular deployment file'
    )

    for (const facet of ldaCoreFacets) {
      // Check if core facet is deployed in regular deployment file (shared with LiFi Diamond)
      const isDeployed = await checkIsDeployedWithCast(
        facet,
        deployedContracts,
        rpcUrl
      )

      if (!isDeployed) {
        logError(
          `LDA Core Facet ${facet} not found in regular deployment file - please deploy regular LiFi Diamond first`
        )
        continue
      }
      consola.success(`LDA Core Facet ${facet} available in regular deployment`)
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
        // Create mapping from addresses to facet names
        // For core facets, use addresses from production deployment file
        // For non-core facets, use addresses from LDA deployment file
        const configFacetsByAddress: Record<string, string> = {}

        // Add core facets from production deployment file
        for (const facet of ldaCoreFacets) {
          const address = deployedContracts[facet]
          if (address) configFacetsByAddress[address.toLowerCase()] = facet
        }

        // Add non-core facets from LDA facet info file
        const diamondFacets =
          ldaFacetInfo['LiFiDEXAggregatorDiamond']?.Facets || {}
        Object.entries(diamondFacets).forEach(([address, facetData]) => {
          const facetName = facetData.Name
          if (facetName && !ldaCoreFacets.includes(facetName))
            configFacetsByAddress[address.toLowerCase()] = facetName
        })

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

    // Check core facets registration
    for (const facet of ldaCoreFacets)
      if (!registeredFacets.includes(facet))
        logError(`LDA Core Facet ${facet} not registered in Diamond`)
      else consola.success(`LDA Core Facet ${facet} registered in Diamond`)

    // Check non-core facets registration
    const diamondFacets = ldaFacetInfo['LiFiDEXAggregatorDiamond']?.Facets || {}
    const nonCoreFacets = Object.values(diamondFacets)
      .map((facetData) => facetData.Name)
      .filter(
        (name): name is string =>
          name !== undefined && !ldaCoreFacets.includes(name)
      )

    for (const facet of nonCoreFacets)
      if (!registeredFacets.includes(facet))
        logError(`LDA Non-Core Facet ${facet} not registered in Diamond`)
      else consola.success(`LDA Non-Core Facet ${facet} registered in Diamond`)

    //          ╭─────────────────────────────────────────────────────────╮
    //          │              Check LDA Diamond ownership                 │
    //          ╰─────────────────────────────────────────────────────────╯

    if (environment === 'production') {
      consola.box('Checking LDA Diamond ownership...')

      try {
        const owner = execSync(
          `cast call "${diamondAddress}" "owner() returns (address)" --rpc-url "${rpcUrl}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        ).trim()

        consola.info(`LiFiDEXAggregatorDiamond current owner: ${owner}`)

        // Get expected multisig address from networks.json
        const expectedMultisigAddress =
          networksConfig[network.toLowerCase() as SupportedChain]?.safeAddress

        if (!expectedMultisigAddress) {
          logError(
            `No multisig address (safeAddress) found in networks.json for network ${network}`
          )
        } else {
          consola.info(
            `Expected multisig address from networks.json: ${expectedMultisigAddress}`
          )

          if (owner.toLowerCase() === expectedMultisigAddress.toLowerCase()) {
            consola.success(
              `✅ LiFiDEXAggregatorDiamond is correctly owned by multisig: ${expectedMultisigAddress}`
            )
          } else {
            logError(
              `❌ LiFiDEXAggregatorDiamond ownership mismatch! Current owner: ${owner}, Expected multisig: ${expectedMultisigAddress}`
            )
          }
        }
      } catch (error) {
        logError(
          `Failed to check LiFiDEXAggregatorDiamond ownership: ${
            (error as Error).message
          }`
        )
      }
    } else {
      consola.info(
        '⏭️  Skipping LDA Diamond ownership check for staging environment'
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
