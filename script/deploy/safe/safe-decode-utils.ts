/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 */

import consola from 'consola'
import { Abi, Hex, parseAbi, toFunctionSelector } from 'viem'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Attempts to find and load a local ABI file for a given contract name
 * @param contractName - Name of the contract (e.g., "AcrossFacet")
 * @returns ABI object if found, null otherwise
 */
async function tryLoadLocalAbi(
  contractName: string
): Promise<{ abi: any[]; name?: string } | null> {
  try {
    // Go up three levels from script/deploy/safe to project root
    const projectRoot = path.join(process.cwd(), '..', '..', '..')
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
 * Attempts to find a local ABI by searching through all contract files
 * @param address - Contract address to search for
 * @returns ABI object if found, null otherwise
 */
async function findLocalAbiByAddress(
  address: string
): Promise<{ abi: any[]; name?: string } | null> {
  try {
    // Go up three levels from script/deploy/safe to project root
    const projectRoot = path.join(process.cwd(), '..', '..', '..')
    const outDir = path.join(projectRoot, 'out')
    if (!fs.existsSync(outDir)) {
      return null
    }

    // Get all .sol directories
    const solDirs = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && dirent.name.endsWith('.sol'))
      .map((dirent) => dirent.name)

    for (const solDir of solDirs) {
      const contractName = solDir.replace('.sol', '')
      const jsonFiles = fs
        .readdirSync(path.join(outDir, solDir), { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
        .map((dirent) => dirent.name)

      for (const jsonFile of jsonFiles) {
        const jsonPath = path.join(outDir, solDir, jsonFile)
        try {
          const abiData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
          if (abiData.abi) {
            // For now, we'll return the first valid ABI we find
            // In a more sophisticated implementation, we could try to match by bytecode or other means
            const contractNameFromFile = jsonFile.replace('.json', '')
            consola.info(`Found potential local ABI: ${contractNameFromFile}`)
            return { abi: abiData.abi, name: contractNameFromFile }
          }
        } catch (error) {
          // Skip invalid JSON files
          continue
        }
      }
    }

    return null
  } catch (error) {
    consola.warn(`Error searching for local ABI: ${error}`)
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
    // Go up three levels from script/deploy/safe to project root
    const projectRoot = path.join(process.cwd(), '..', '..', '..')
    const outDir = path.join(projectRoot, 'out')
    if (!fs.existsSync(outDir)) {
      return null
    }

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
          if (abiData.abi) {
            // Search for matching function selector in ABI
            for (const abiItem of abiData.abi) {
              if (abiItem.type === 'function') {
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
              }
            }
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
      let resData = await findLocalAbiByAddress(facetAddress)

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

        for (const selector of selectors) {
          try {
            // Find matching function in ABI
            const matchingFunction = resData.abi.find((abiItem: any) => {
              if (abiItem.type !== 'function') return false
              const calculatedSelector = toFunctionSelector(abiItem)
              return calculatedSelector === selector
            })

            if (matchingFunction) {
              consola.info(
                `Function: \u001b[34m${matchingFunction.name}\u001b[0m [${selector}]`
              )
            } else {
              consola.warn(`Unknown function [${selector}]`)
            }
          } catch (error) {
            consola.warn(`Failed to decode selector: ${selector}`)
          }
        }
      } else {
        consola.info(`Could not fetch ABI for facet ${facetAddress}`)
      }
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
      const fullAbiString = `function ${functionName}`
      const abiInterface = parseAbi([fullAbiString])

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
