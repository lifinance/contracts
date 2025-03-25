/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 */

import consola from 'consola'
import { Abi, Hex, parseAbi, toFunctionSelector } from 'viem'

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
        `Fetching ABI for Facet Address: \u001b[34m${facetAddress}\u001b[0m`
      )
      const url = `https://anyabi.xyz/api/get-abi/${chainId}/${facetAddress}`
      const response = await fetch(url)
      const resData = await response.json()
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
