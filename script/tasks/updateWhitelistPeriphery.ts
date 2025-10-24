#!/usr/bin/env node

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { utils } from 'ethers'

import globalConfig from '../../config/global.json'
import networksConfig from '../../config/networks.json'
import type { INetworksObject } from '../common/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Configuration - get contracts from global.json
const PERIPHERY_CONTRACTS = Object.keys(
  globalConfig.whitelistPeripheryFunctions
) as PeripheryContract[]

type PeripheryContract = keyof typeof globalConfig.whitelistPeripheryFunctions

interface ISelectorData {
  selector: string
  signature: string
}

interface IContractData {
  name: PeripheryContract
  address: string
  selectors: ISelectorData[]
}

interface INetworkResult {
  networkName: string
  production: IContractData[]
  staging: IContractData[]
}

interface IPeripheryData {
  [networkName: string]: IContractData[]
}

interface IWhitelistData {
  DEXS: unknown[]
  PERIPHERY: IPeripheryData
}

// Function selectors loaded from global.json
const CONTRACT_SELECTORS: Record<PeripheryContract, ISelectorData[]> =
  globalConfig.whitelistPeripheryFunctions

// Validation functions
function isValidEthereumAddress(address: string): boolean {
  // Standard Ethereum address format
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return true
  }
  // Tron address format (starts with T and is 34 characters)
  if (/^T[a-zA-Z0-9]{33}$/.test(address)) {
    return true
  }
  return false
}

function isValidSelector(selector: string): boolean {
  return /^0x[a-fA-F0-9]{8}$/.test(selector)
}

function validateSelector(selector: string, signature: string): boolean {
  try {
    const calculatedHash = utils.keccak256(utils.toUtf8Bytes(signature))
    const calculatedSelector = '0x' + calculatedHash.slice(2, 10)
    return calculatedSelector.toLowerCase() === selector.toLowerCase()
  } catch (error) {
    return false
  }
}

// Process a single network (both production and staging)
async function processNetwork(networkName: string): Promise<INetworkResult> {
  const deploymentsDir = path.join(__dirname, '../../deployments')

  // Define file paths for both environments
  const productionFile = path.join(deploymentsDir, `${networkName}.json`)
  const stagingFile = path.join(deploymentsDir, `${networkName}.staging.json`)

  let production: IContractData[] = []
  let staging: IContractData[] = []

  // Process production deployment
  if (fs.existsSync(productionFile)) {
    try {
      production = await processDeploymentFile(
        productionFile,
        networkName,
        'production'
      )
    } catch (error) {
      throw new Error(
        `Failed to process production deployment for ${networkName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  } else {
    consola.warn(
      `Production deployment file not found for ${networkName}: ${productionFile}`
    )
  }

  // Process staging deployment
  if (fs.existsSync(stagingFile)) {
    try {
      staging = await processDeploymentFile(stagingFile, networkName, 'staging')
    } catch (error) {
      throw new Error(
        `Failed to process staging deployment for ${networkName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  } else {
    consola.warn(
      `Staging deployment file not found for ${networkName}: ${stagingFile}`
    )
  }

  return { networkName, production, staging }
}

// Process a single deployment file
async function processDeploymentFile(
  filePath: string,
  networkName: string,
  environment: 'production' | 'staging'
): Promise<IContractData[]> {
  try {
    // Read deployment file
    const deploymentData = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const networkContracts: IContractData[] = []

    // Process each periphery contract
    for (const contractName of PERIPHERY_CONTRACTS) {
      if (deploymentData[contractName]) {
        const address = deploymentData[contractName]

        // Validate address
        if (!isValidEthereumAddress(address)) {
          throw new Error(
            `Invalid address for ${contractName} on ${networkName} (${environment}): ${address}`
          )
        }

        // Get selectors for this contract
        const selectors = CONTRACT_SELECTORS[contractName]
        if (!selectors) {
          throw new Error(`No selectors defined for contract: ${contractName}`)
        }

        // Validate all selectors
        for (const selectorData of selectors) {
          if (!isValidSelector(selectorData.selector)) {
            throw new Error(
              `Invalid selector for ${contractName}: ${selectorData.selector}`
            )
          }
          if (
            !validateSelector(selectorData.selector, selectorData.signature)
          ) {
            throw new Error(
              `Selector mismatch for ${contractName}: ${selectorData.selector} != ${selectorData.signature}`
            )
          }
        }

        networkContracts.push({
          name: contractName,
          address: address,
          selectors: [...selectors], // Copy to avoid mutation
        })
      } else {
        consola.warn(
          `Contract ${contractName} not found on ${networkName} (${environment})`
        )
      }
    }

    return networkContracts
  } catch (error) {
    throw new Error(
      `Failed to process ${environment} deployment file ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

// Sort networks (mainnet first, then alphabetical)
function sortNetworks(networks: string[]): string[] {
  return networks.sort((a, b) => {
    if (a === 'mainnet') {
      return -1
    }
    if (b === 'mainnet') {
      return 1
    }
    return a.localeCompare(b)
  })
}

// Sort selectors within each contract
function sortSelectors(contracts: IContractData[]): IContractData[] {
  return contracts.map((contract) => ({
    ...contract,
    selectors: contract.selectors.sort((a, b) =>
      a.selector.localeCompare(b.selector)
    ),
  }))
}

const main = defineCommand({
  meta: {
    name: 'update-periphery',
    description:
      'Update the periphery sections of whitelist.json (production) and whitelist.staging.json (staging) with deployed contracts',
  },
  args: {
    environment: {
      type: 'string',
      description:
        'Environment to update: "production", "staging", or "both" (default: "both")',
      default: 'both',
    },
    dryRun: {
      type: 'boolean',
      description: 'Show what would be updated without making changes',
      default: false,
    },
  },
  async run({ args }) {
    const startTime = Date.now()

    try {
      // Validate environment argument
      const environment = (args.environment as string)?.toLowerCase() || 'both'
      if (
        environment !== 'production' &&
        environment !== 'staging' &&
        environment !== 'both'
      ) {
        throw new Error(
          `Invalid environment: "${args.environment}". Must be "production", "staging", or "both"`
        )
      }

      const isProduction =
        environment === 'production' || environment === 'both'
      const isStaging = environment === 'staging' || environment === 'both'

      consola.info(
        `Starting periphery section update for environment: ${environment}...`
      )

      // Load networks.json
      const networksData: INetworksObject = networksConfig
      const networkNames = Object.keys(networksData)

      // Load whitelist.json (production)
      const whitelistPath = path.join(
        __dirname,
        '../../config',
        'whitelist.json'
      )
      // Load whitelist.json (production) - needed for production update or staging DEXS
      if (!fs.existsSync(whitelistPath)) {
        throw new Error(`Whitelist file not found: ${whitelistPath}`)
      }
      const whitelistData: IWhitelistData = JSON.parse(
        fs.readFileSync(whitelistPath, 'utf8')
      )

      // Validate production whitelist structure
      if (!whitelistData.DEXS || !Array.isArray(whitelistData.DEXS)) {
        throw new Error(
          'Invalid whitelist.json structure: DEXS section missing or invalid'
        )
      }

      // Load whitelist.staging.json (staging)
      // For staging: always pull DEXS from production, create/update PERIPHERY from script
      const whitelistStagingPath = path.join(
        __dirname,
        '../../config',
        'whitelist.staging.json'
      )
      let whitelistStagingData: IWhitelistData | null = null
      if (isStaging) {
        if (fs.existsSync(whitelistStagingPath)) {
          // Load existing staging file but will replace DEXS with production DEXS
          whitelistStagingData = JSON.parse(
            fs.readFileSync(whitelistStagingPath, 'utf8')
          )
        } else {
          // Create new staging whitelist structure
          whitelistStagingData = {
            DEXS: [],
            PERIPHERY: {},
          }
        }
        // Always pull DEXS from production for staging environment
        if (whitelistStagingData) {
          whitelistStagingData.DEXS = [...whitelistData.DEXS]

          // Validate whitelist structure
          if (
            !whitelistStagingData.DEXS ||
            !Array.isArray(whitelistStagingData.DEXS)
          ) {
            throw new Error(
              'Invalid whitelist.staging.json structure: DEXS section missing or invalid'
            )
          }
        }
      }

      consola.info(`Processing ${networkNames.length} networks in parallel...`)

      // Process all networks in parallel
      const networkResults = await Promise.all(
        networkNames.map((networkName) => processNetwork(networkName))
      )

      // Filter out networks with no contracts in the requested environment(s)
      const networksWithContracts = networkResults.filter((result) => {
        if (isProduction && result.production.length > 0) {
          return true
        }
        if (isStaging && result.staging.length > 0) {
          return true
        }
        return false
      })

      if (networksWithContracts.length === 0) {
        throw new Error('No periphery contracts found on any network')
      }

      consola.info(
        `Found periphery contracts on ${networksWithContracts.length} networks`
      )

      // Sort networks
      const sortedNetworkNames = sortNetworks(
        networksWithContracts.map((r) => r.networkName)
      )

      // Build periphery data with proper sorting - separate production and staging
      const productionPeripheryData: IPeripheryData = {}
      const stagingPeripheryData: IPeripheryData = {}

      for (const networkName of sortedNetworkNames) {
        const result = networkResults.find((r) => r.networkName === networkName)
        if (result) {
          if (isProduction && result.production.length > 0) {
            productionPeripheryData[networkName] = sortSelectors(
              result.production
            )
          }
          if (isStaging && result.staging.length > 0) {
            stagingPeripheryData[networkName] = sortSelectors(result.staging)
          }
        }
      }

      // Update whitelist data for the requested environment
      if (isProduction) {
        whitelistData.PERIPHERY = productionPeripheryData
      }
      if (isStaging && whitelistStagingData) {
        whitelistStagingData.PERIPHERY = stagingPeripheryData
      }

      if (args.dryRun) {
        consola.info('DRY RUN - Would update the following:')
        if (isProduction) {
          consola.info(
            `Production networks: ${
              Object.keys(productionPeripheryData).length
            }`
          )
        }
        if (isStaging) {
          consola.info(
            `Staging networks: ${Object.keys(stagingPeripheryData).length}`
          )
        }

        if (isProduction) {
          const totalProductionContracts = Object.values(
            productionPeripheryData
          ).reduce((sum, contracts) => sum + contracts.length, 0)
          consola.info(
            `Total production contracts: ${totalProductionContracts}`
          )

          const productionContractCounts: Record<string, number> = {}
          Object.values(productionPeripheryData).forEach((contracts) => {
            contracts.forEach((contract) => {
              productionContractCounts[contract.name] =
                (productionContractCounts[contract.name] || 0) + 1
            })
          })

          consola.info('Production contract distribution:')
          Object.entries(productionContractCounts)
            .sort(([, a], [, b]) => b - a)
            .forEach(([contract, count]) => {
              consola.info(`  ${contract}: ${count} networks`)
            })
        }

        if (isStaging) {
          const totalStagingContracts = Object.values(
            stagingPeripheryData
          ).reduce((sum, contracts) => sum + contracts.length, 0)
          consola.info(`Total staging contracts: ${totalStagingContracts}`)

          const stagingContractCounts: Record<string, number> = {}
          Object.values(stagingPeripheryData).forEach((contracts) => {
            contracts.forEach((contract) => {
              stagingContractCounts[contract.name] =
                (stagingContractCounts[contract.name] || 0) + 1
            })
          })

          consola.info('Staging contract distribution:')
          Object.entries(stagingContractCounts)
            .sort(([, a], [, b]) => b - a)
            .forEach(([contract, count]) => {
              consola.info(`  ${contract}: ${count} networks`)
            })
        }

        return
      }

      // Write production whitelist if requested
      if (isProduction && whitelistData) {
        const tempProductionPath = path.join(
          __dirname,
          '../../config',
          'whitelist.tmp.json'
        )
        fs.writeFileSync(
          tempProductionPath,
          JSON.stringify(whitelistData, null, 2)
        )

        // Validate the temporary production file
        const tempProductionData: IWhitelistData = JSON.parse(
          fs.readFileSync(tempProductionPath, 'utf8')
        )
        if (
          !tempProductionData.PERIPHERY ||
          typeof tempProductionData.PERIPHERY !== 'object'
        ) {
          throw new Error('Generated production periphery data is invalid')
        }

        // Atomic replacement for production
        fs.renameSync(tempProductionPath, whitelistPath)
      }

      // Write staging whitelist if requested
      if (isStaging) {
        if (!whitelistStagingData) {
          throw new Error('whitelistStagingData is null or undefined')
        }

        const whitelistStagingPath = path.join(
          __dirname,
          '../../config',
          'whitelist.staging.json'
        )
        const tempStagingPath = path.join(
          __dirname,
          '../../config',
          'whitelist.staging.tmp.json'
        )

        // Ensure PERIPHERY exists even if empty
        if (!whitelistStagingData.PERIPHERY) {
          whitelistStagingData.PERIPHERY = {}
        }

        consola.info(
          `Writing staging whitelist to temporary file: ${tempStagingPath}`
        )
        fs.writeFileSync(
          tempStagingPath,
          JSON.stringify(whitelistStagingData, null, 2)
        )

        // Validate the temporary staging file
        const tempStagingData: IWhitelistData = JSON.parse(
          fs.readFileSync(tempStagingPath, 'utf8')
        )
        if (
          tempStagingData.PERIPHERY === null ||
          tempStagingData.PERIPHERY === undefined ||
          typeof tempStagingData.PERIPHERY !== 'object'
        ) {
          throw new Error('Generated staging periphery data is invalid')
        }

        // Atomic replacement for staging
        consola.info(`Moving temporary file to: ${whitelistStagingPath}`)
        fs.renameSync(tempStagingPath, whitelistStagingPath)
        consola.success(`Staging whitelist written to: ${whitelistStagingPath}`)
      }

      const endTime = Date.now()
      const duration = ((endTime - startTime) / 1000).toFixed(2)

      consola.success(`Periphery sections updated successfully in ${duration}s`)

      if (isProduction) {
        consola.success(
          `Updated production: ${
            Object.keys(productionPeripheryData).length
          } networks`
        )

        const totalProductionContracts = Object.values(
          productionPeripheryData
        ).reduce((sum, contracts) => sum + contracts.length, 0)
        consola.info(`Total production contracts: ${totalProductionContracts}`)

        const productionContractCounts: Record<string, number> = {}
        Object.values(productionPeripheryData).forEach((contracts) => {
          contracts.forEach((contract) => {
            productionContractCounts[contract.name] =
              (productionContractCounts[contract.name] || 0) + 1
          })
        })

        consola.info('Production contract distribution:')
        Object.entries(productionContractCounts)
          .sort(([, a], [, b]) => b - a)
          .forEach(([contract, count]) => {
            consola.info(`  ${contract}: ${count} networks`)
          })
      }

      if (isStaging) {
        consola.success(
          `Updated staging: ${
            Object.keys(stagingPeripheryData).length
          } networks`
        )

        const totalStagingContracts = Object.values(
          stagingPeripheryData
        ).reduce((sum, contracts) => sum + contracts.length, 0)
        consola.info(`Total staging contracts: ${totalStagingContracts}`)

        const stagingContractCounts: Record<string, number> = {}
        Object.values(stagingPeripheryData).forEach((contracts) => {
          contracts.forEach((contract) => {
            stagingContractCounts[contract.name] =
              (stagingContractCounts[contract.name] || 0) + 1
          })
        })

        consola.info('Staging contract distribution:')
        Object.entries(stagingContractCounts)
          .sort(([, a], [, b]) => b - a)
          .forEach(([contract, count]) => {
            consola.info(`  ${contract}: ${count} networks`)
          })
      }
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))

      // Cleanup temporary files
      const tempProductionPath = path.join(
        __dirname,
        '../../config',
        'whitelist.tmp.json'
      )
      const tempStagingPath = path.join(
        __dirname,
        '../../config',
        'whitelist.staging.tmp.json'
      )

      if (fs.existsSync(tempProductionPath)) {
        fs.unlinkSync(tempProductionPath)
        consola.info('Cleaned up temporary production file')
      }

      if (fs.existsSync(tempStagingPath)) {
        fs.unlinkSync(tempStagingPath)
        consola.info('Cleaned up temporary staging file')
      }

      process.exit(1)
    }
  },
})

// Run the script
runMain(main)