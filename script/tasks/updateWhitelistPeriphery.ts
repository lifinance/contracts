#!/usr/bin/env node

// TODOS:
// - replace hardcoded periphery contracts with the ones from config/global.json.autoWhitelistPeripheryContracts (requires healthcheck update)
// - replace hardcoded selectors with json file/list
// -

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { utils } from 'ethers'

import networksConfig from '../../config/networks.json'
import type { INetworksObject } from '../common/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Configuration
const PERIPHERY_CONTRACTS = [
  'FeeCollector',
  'GasZipPeriphery',
  'TokenWrapper',
  'LiFiDEXAggregator',
  'Patcher',
  'LidoWrapper',
] as const

type PeripheryContract = (typeof PERIPHERY_CONTRACTS)[number]

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
  contracts: IContractData[]
}

interface IPeripheryData {
  [networkName: string]: IContractData[]
}

interface IWhitelistData {
  DEXS: unknown[]
  PERIPHERY: IPeripheryData
}

// Function selectors for each contract (pre-calculated for performance)
const CONTRACT_SELECTORS: Record<PeripheryContract, ISelectorData[]> = {
  FeeCollector: [
    {
      selector: '0xeedd56e1',
      signature: 'collectTokenFees(address,uint256,uint256,address)',
    },
    {
      selector: '0xe0cbc5f2',
      signature: 'collectNativeFees(uint256,uint256,address)',
    },
  ],
  GasZipPeriphery: [
    {
      selector: '0x1078c579',
      signature:
        'depositToGasZipERC20((address,uint256,bytes,address,address,uint256,uint256,uint256,bytes,bytes),(uint256[],address[],uint256,bytes32))',
    },
    {
      selector: '0xa7a4a271',
      signature:
        'depositToGasZipNative((uint256[],address[],uint256,bytes32),uint256)',
    },
  ],
  TokenWrapper: [
    { selector: '0xd0e30db0', signature: 'deposit()' },
    { selector: '0x3ccfd60b', signature: 'withdraw()' },
  ],
  LiFiDEXAggregator: [
    {
      selector: '0x2646478b',
      signature: 'processRoute(address,uint256,address,uint256,address,bytes)',
    },
  ],
  Patcher: [
    {
      selector: '0xefae576b',
      signature:
        'executeWithDynamicPatches(address,bytes,address,uint256,bytes,uint256[],bool)',
    },
    {
      selector: '0x922c8daa',
      signature:
        'depositAndExecuteWithDynamicPatches(address,address,bytes,address,uint256,bytes,uint256[],bool)',
    },
    {
      selector: '0xb7c52777',
      signature:
        'depositAndExecuteWithMultiplePatches(address,address[],bytes[],address,uint256,bytes,uint256[][],bool)',
    },
    {
      selector: '0x4d914979',
      signature:
        'executeWithMultiplePatches(address[],bytes[],address,uint256,bytes,uint256[][],bool)',
    },
  ],
  LidoWrapper: [
    { selector: '0x24dd6483', signature: 'wrapStETHToWstETH(uint256)' },
    { selector: '0xa816ca92', signature: 'unwrapWstETHToStETH(uint256)' },
  ],
}

// Validation functions
function isValidEthereumAddress(address: string): boolean {
  // Standard Ethereum address format
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return true
  // Tron address format (starts with T and is 34 characters)
  if (/^T[a-zA-Z0-9]{33}$/.test(address)) return true
  return false
}

function isValidSelector(selector: string): boolean {
  return /^0x[a-fA-F0-9]{8}$/.test(selector)
}

function validateSelector(selector: string, signature: string): boolean {
  try {
    const calculatedHash = utils.keccak256(Buffer.from(signature))
    const calculatedSelector = '0x' + calculatedHash.slice(2, 10)
    return calculatedSelector.toLowerCase() === selector.toLowerCase()
  } catch (error) {
    return false
  }
}

// Process a single network
async function processNetwork(networkName: string): Promise<INetworkResult> {
  const deploymentFile = path.join(
    __dirname,
    '../../deployments',
    `${networkName}.json`
  )

  try {
    // Check if deployment file exists
    if (!fs.existsSync(deploymentFile)) {
      consola.warn(
        `Deployment file not found for ${networkName}: ${deploymentFile}`
      )
      return { networkName, contracts: [] }
    }

    // Read deployment file
    const deploymentData = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'))
    const networkContracts: IContractData[] = []

    // Process each periphery contract
    for (const contractName of PERIPHERY_CONTRACTS)
      if (deploymentData[contractName]) {
        const address = deploymentData[contractName]

        // Validate address
        if (!isValidEthereumAddress(address))
          throw new Error(
            `Invalid address for ${contractName} on ${networkName}: ${address}`
          )

        // Get selectors for this contract
        const selectors = CONTRACT_SELECTORS[contractName]
        if (!selectors)
          throw new Error(`No selectors defined for contract: ${contractName}`)

        // Validate all selectors
        for (const selectorData of selectors) {
          if (!isValidSelector(selectorData.selector))
            throw new Error(
              `Invalid selector for ${contractName}: ${selectorData.selector}`
            )
          if (!validateSelector(selectorData.selector, selectorData.signature))
            throw new Error(
              `Selector mismatch for ${contractName}: ${selectorData.selector} != ${selectorData.signature}`
            )
        }

        networkContracts.push({
          name: contractName,
          address: address,
          selectors: [...selectors], // Copy to avoid mutation
        })
      } else
        consola.warn(`Contract ${contractName} not found on ${networkName}`)

    return { networkName, contracts: networkContracts }
  } catch (error) {
    throw new Error(
      `Failed to process network ${networkName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

// Sort networks (mainnet first, then alphabetical)
function sortNetworks(networks: string[]): string[] {
  return networks.sort((a, b) => {
    if (a === 'mainnet') return -1
    if (b === 'mainnet') return 1
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
      'Update the periphery section of whitelist.json with deployed contracts',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Show what would be updated without making changes',
      default: false,
    },
  },
  async run({ args }) {
    const startTime = Date.now()

    try {
      consola.info('Starting periphery section update...')

      // Load networks.json
      const networksData: INetworksObject = networksConfig
      const networkNames = Object.keys(networksData)

      // Load whitelist.json
      const whitelistPath = path.join(
        __dirname,
        '../../config',
        'whitelist.json'
      )
      if (!fs.existsSync(whitelistPath))
        throw new Error(`Whitelist file not found: ${whitelistPath}`)
      const whitelistData: IWhitelistData = JSON.parse(
        fs.readFileSync(whitelistPath, 'utf8')
      )

      // Validate whitelist structure
      if (!whitelistData.DEXS || !Array.isArray(whitelistData.DEXS))
        throw new Error(
          'Invalid whitelist.json structure: DEXS section missing or invalid'
        )

      consola.info(`Processing ${networkNames.length} networks in parallel...`)

      // Process all networks in parallel
      const networkResults = await Promise.all(
        networkNames.map((networkName) => processNetwork(networkName))
      )

      // Filter out networks with no contracts
      const networksWithContracts = networkResults.filter(
        (result) => result.contracts.length > 0
      )

      if (networksWithContracts.length === 0)
        throw new Error('No periphery contracts found on any network')

      consola.info(
        `Found periphery contracts on ${networksWithContracts.length} networks`
      )

      // Sort networks
      const sortedNetworkNames = sortNetworks(
        networksWithContracts.map((r) => r.networkName)
      )

      // Build periphery data with proper sorting
      const peripheryData: IPeripheryData = {}
      for (const networkName of sortedNetworkNames) {
        const result = networkResults.find((r) => r.networkName === networkName)
        if (result && result.contracts.length > 0)
          peripheryData[networkName] = sortSelectors(result.contracts)
      }

      // Update whitelist data
      whitelistData.PERIPHERY = peripheryData

      if (args.dryRun) {
        consola.info('DRY RUN - Would update the following:')
        consola.info(`Networks: ${Object.keys(peripheryData).length}`)

        const totalContracts = Object.values(peripheryData).reduce(
          (sum, contracts) => sum + contracts.length,
          0
        )
        consola.info(`Total contracts: ${totalContracts}`)

        // Show contract distribution
        const contractCounts: Record<string, number> = {}
        Object.values(peripheryData).forEach((contracts) => {
          contracts.forEach((contract) => {
            contractCounts[contract.name] =
              (contractCounts[contract.name] || 0) + 1
          })
        })

        consola.info('Contract distribution:')
        Object.entries(contractCounts)
          .sort(([, a], [, b]) => b - a)
          .forEach(([contract, count]) => {
            consola.info(`  ${contract}: ${count} networks`)
          })

        return
      }

      // Write to temporary file first
      const tempPath = path.join(
        __dirname,
        '../../config',
        'whitelist.tmp.json'
      )
      fs.writeFileSync(tempPath, JSON.stringify(whitelistData, null, 2))

      // Validate the temporary file
      const tempData: IWhitelistData = JSON.parse(
        fs.readFileSync(tempPath, 'utf8')
      )
      if (!tempData.PERIPHERY || typeof tempData.PERIPHERY !== 'object')
        throw new Error('Generated periphery data is invalid')

      // Atomic replacement
      fs.renameSync(tempPath, whitelistPath)

      const endTime = Date.now()
      const duration = ((endTime - startTime) / 1000).toFixed(2)

      consola.success(`Periphery section updated successfully in ${duration}s`)
      consola.success(`Updated ${Object.keys(peripheryData).length} networks`)

      // Summary statistics
      const totalContracts = Object.values(peripheryData).reduce(
        (sum, contracts) => sum + contracts.length,
        0
      )
      consola.info(`Total contracts: ${totalContracts}`)

      // Show contract distribution
      const contractCounts: Record<string, number> = {}
      Object.values(peripheryData).forEach((contracts) => {
        contracts.forEach((contract) => {
          contractCounts[contract.name] =
            (contractCounts[contract.name] || 0) + 1
        })
      })

      consola.info('Contract distribution:')
      Object.entries(contractCounts)
        .sort(([, a], [, b]) => b - a)
        .forEach(([contract, count]) => {
          consola.info(`  ${contract}: ${count} networks`)
        })
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))

      // Cleanup temporary files
      const tempPath = path.join(
        __dirname,
        '../../config',
        'whitelist.tmp.json'
      )
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
        consola.info('Cleaned up temporary file')
      }

      process.exit(1)
    }
  },
})

// Run the script
runMain(main)
