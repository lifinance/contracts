/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import { toFunctionSelector, type Hex } from 'viem'

import networksConfig from '../../../config/networks.json'

/**
 * Maps chainId to network name
 * @param chainId - Chain ID number
 * @returns Network name if found, null otherwise
 */
function getNetworkNameForChainId(chainId: number): string | null {
  const network = Object.entries(networksConfig).find(
    ([, info]) => info.chainId === chainId
  )
  return network ? network[0] : null
}

/**
 * Attempts to find and load a local ABI file for a given contract name
 * @param contractName - Name of the contract (e.g., "AcrossFacet")
 * @returns ABI object if found, null otherwise
 */
async function tryLoadLocalAbi(
  contractName: string
): Promise<{ abi: any[]; name?: string } | null> {
  try {
    // Use current working directory as project root (script is called from project root)
    const projectRoot = process.cwd()
    const abiPath = path.join(
      projectRoot,
      'out',
      `${contractName}.sol`,
      `${contractName}.json`
    )

    if (fs.existsSync(abiPath)) {
      const abiData = JSON.parse(fs.readFileSync(abiPath, 'utf8'))
      if (abiData.abi) {
        consola.info(`Found local ABI for ${contractName}`)
        return { abi: abiData.abi, name: contractName }
      }
    }

    return null
  } catch (error) {
    consola.warn(`Error loading local ABI for ${contractName}: ${error}`)
    return null
  }
}

/**
 * Finds contract name by address from deployment files for a specific network
 * @param address - Contract address to search for
 * @param network - Network name (e.g., 'mainnet', 'arbitrum', 'optimism')
 * @returns Contract name if found, null otherwise
 */
async function findContractNameByAddress(
  address: string,
  network: string
): Promise<string | null> {
  try {
    // Use current working directory as project root (script is called from project root)
    const projectRoot = process.cwd()
    const deploymentsDir = path.join(projectRoot, 'deployments')

    if (!fs.existsSync(deploymentsDir)) return null

    // Normalize address for comparison
    const normalizedAddress = address.toLowerCase()

    // Look for the specific network deployment file
    const deploymentFile = `${network}.json`
    const deploymentPath = path.join(deploymentsDir, deploymentFile)

    if (!fs.existsSync(deploymentPath)) {
      consola.warn(`Deployment file not found: ${deploymentFile}`)
      return null
    }

    try {
      const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

      // Search through all contract entries
      for (const [contractName, contractAddress] of Object.entries(
        deploymentData
      ))
        if (
          typeof contractAddress === 'string' &&
          contractAddress.toLowerCase() === normalizedAddress
        ) {
          consola.info(
            `Found contract ${contractName} at address ${address} in ${deploymentFile}`
          )
          return contractName
        }
    } catch (error) {
      consola.warn(`Error reading deployment file ${deploymentFile}: ${error}`)
      return null
    }

    return null
  } catch (error) {
    consola.warn(`Error searching for contract name by address: ${error}`)
    return null
  }
}

/**
 * Attempts to find a local ABI by contract address for a specific network
 * @param address - Contract address to search for
 * @param network - Network name (e.g., 'mainnet', 'arbitrum', 'optimism')
 * @returns ABI object if found, null otherwise
 */
async function findLocalAbiByAddress(
  address: string,
  network: string
): Promise<{ abi: any[]; name?: string } | null> {
  try {
    // First, find the contract name from deployment files
    const contractName = await findContractNameByAddress(address, network)
    if (!contractName) {
      consola.info(
        `No contract name found for address ${address} in ${network} deployment file`
      )
      return null
    }

    // Now try to load the ABI for this contract
    const abiResult = await tryLoadLocalAbi(contractName)
    if (abiResult) {
      consola.info(
        `Found local ABI for ${contractName} at address ${address} on ${network}`
      )
      return abiResult
    }

    consola.warn(
      `Contract ${contractName} found for address ${address} on ${network}, but no local ABI available`
    )
    return null
  } catch (error) {
    consola.warn(`Error finding local ABI by address: ${error}`)
    return null
  }
}

/**
 * Attempts to find a local ABI by function selector
 * @param selector - Function selector (e.g., "0x12345678")
 * @returns Function signature and contract name if found, null otherwise
 */
async function findLocalAbiBySelector(
  selector: string
): Promise<{ functionName: string; contractName: string } | null> {
  try {
    // Use current working directory as project root (script is called from project root)
    const projectRoot = process.cwd()
    const outDir = path.join(projectRoot, 'out')
    if (!fs.existsSync(outDir)) return null

    // Get all .sol directories
    const solDirs = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name.endsWith('.sol'))
      .map((dirent) => dirent.name)

    for (const solDir of solDirs) {
      const jsonFiles = fs
        .readdirSync(path.join(outDir, solDir), { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
        .map((dirent) => dirent.name)

      for (const jsonFile of jsonFiles) {
        const jsonPath = path.join(outDir, solDir, jsonFile)
        try {
          const abiData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
          if (abiData.abi)
            // Search for matching function selector in ABI
            for (const abiItem of abiData.abi)
              if (abiItem.type === 'function')
                try {
                  const calculatedSelector = toFunctionSelector(abiItem)
                  if (calculatedSelector === selector) {
                    const contractNameFromFile = jsonFile.replace('.json', '')
                    consola.info(
                      `Found function in local ABI: ${abiItem.name} in ${contractNameFromFile}`
                    )
                    return {
                      functionName: abiItem.name,
                      contractName: contractNameFromFile,
                    }
                  }
                } catch (error) {
                  // Skip invalid ABI items
                  continue
                }
        } catch (error) {
          // Skip invalid JSON files
          continue
        }
      }
    }

    return null
  } catch (error) {
    consola.warn(`Error searching for local ABI by selector: ${error}`)
    return null
  }
}

/**
 * Decodes a diamond cut transaction and displays its details
 * @param diamondCutData - Decoded diamond cut data
 * @param chainId - Chain ID
 */
export async function decodeDiamondCut(diamondCutData: any, chainId: number) {
  const actionMap: Record<number, string> = {
    0: 'Add',
    1: 'Replace',
    2: 'Remove',
  }
  consola.info('Diamond Cut Details:')
  consola.info('-'.repeat(80))
  // diamondCutData.args[0] contains an array of modifications.
  const modifications = diamondCutData.args[0]
  for (const mod of modifications) {
    // Each mod is [facetAddress, action, selectors]
    const [facetAddress, actionValue, selectors] = mod
    try {
      consola.info(
        `Looking up ABI for Facet Address: \u001b[34m${facetAddress}\u001b[0m`
      )

      // First try to find local ABI
      const networkName = getNetworkNameForChainId(chainId)
      let resData = null

      if (networkName)
        resData = await findLocalAbiByAddress(facetAddress, networkName)
      else
        consola.warn(`Unknown chainId: ${chainId}, skipping local ABI lookup`)

      // If no local ABI found, fallback to external API
      if (!resData) {
        consola.info('No local ABI found, fetching from anyabi.xyz...')
        const url = `https://anyabi.xyz/api/get-abi/${chainId}/${facetAddress}`
        const response = await fetch(url)
        resData = await response.json()
      }

      consola.info(`Action: ${actionMap[actionValue] ?? actionValue}`)
      if (resData && resData.abi) {
        consola.info(
          `Contract Name: \u001b[34m${resData.name || 'unknown'}\u001b[0m`
        )

        for (const selector of selectors)
          try {
            // Find matching function in ABI
            const matchingFunction = resData.abi.find((abiItem: any) => {
              if (abiItem.type !== 'function') return false
              const calculatedSelector = toFunctionSelector(abiItem)
              return calculatedSelector === selector
            })

            if (matchingFunction)
              consola.info(
                `Function: \u001b[34m${matchingFunction.name}\u001b[0m [${selector}]`
              )
            else consola.warn(`Unknown function [${selector}]`)
          } catch (error) {
            consola.warn(`Failed to decode selector: ${selector}`)
          }
      } else consola.info(`Could not fetch ABI for facet ${facetAddress}`)
    } catch (error) {
      consola.error(`Error fetching ABI for ${facetAddress}:`, error)
    }
    consola.info('-'.repeat(80))
  }
  // Also log the initialization parameters (2nd and 3rd arguments of diamondCut)
  consola.info(`Init Address: ${diamondCutData.args[1]}`)
  consola.info(`Init Calldata: ${diamondCutData.args[2]}`)
}

/**
 * Decodes a transaction's function call
 * @param data - Transaction data
 * @returns Decoded function name and data if available
 */
export async function decodeTransactionData(data: Hex): Promise<{
  functionName?: string
  decodedData?: any
}> {
  if (!data || data === '0x') return {}

  try {
    const selector = data.substring(0, 10)

    // First try to find function in local ABIs
    const localResult = await findLocalAbiBySelector(selector)
    if (localResult) {
      consola.info(`Using local ABI for function: ${localResult.functionName}`)
      return {
        functionName: localResult.functionName,
        decodedData: {
          functionName: localResult.functionName,
          contractName: localResult.contractName,
        },
      }
    }

    // Fallback to external API
    consola.info('No local ABI found, fetching from openchain.xyz...')
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`
    const response = await fetch(url)
    const responseData = await response.json()

    if (
      responseData.ok &&
      responseData.result &&
      responseData.result.function &&
      responseData.result.function[selector]
    ) {
      const functionName = responseData.result.function[selector][0].name

      try {
        const decodedData = {
          functionName,
          args: responseData.result.function[selector][0].args,
        }

        return {
          functionName,
          decodedData,
        }
      } catch (error) {
        consola.warn(`Could not decode function data: ${error}`)
        return { functionName }
      }
    }

    return {}
  } catch (error) {
    consola.warn(`Error decoding transaction data: ${error}`)
    return {}
  }
}
