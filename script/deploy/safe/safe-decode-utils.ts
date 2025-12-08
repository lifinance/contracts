/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 *
 * Note: Main functionality has been moved to safe-utils.ts
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import type { Hex } from 'viem'
import { toFunctionSelector } from 'viem'

/**
 * Decodes a transaction's function call using diamond ABI
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

    // First try to find function in diamond ABI
    try {
      const projectRoot = process.cwd()
      const diamondPath = path.join(projectRoot, 'diamond.json')

      if (fs.existsSync(diamondPath)) {
        const abiData = JSON.parse(fs.readFileSync(diamondPath, 'utf8'))
        if (Array.isArray(abiData))
          // Search for matching function selector in diamond ABI
          for (const abiItem of abiData)
            if (abiItem.type === 'function')
              try {
                const calculatedSelector = toFunctionSelector(abiItem)
                if (calculatedSelector === selector) {
                  consola.info(
                    `Using diamond ABI for function: ${abiItem.name}`
                  )
                  return {
                    functionName: abiItem.name,
                    decodedData: {
                      functionName: abiItem.name,
                      contractName: 'Diamond',
                    },
                  }
                }
              } catch (error) {
                // Skip invalid ABI items
                continue
              }
      }
    } catch (error) {
      consola.warn(`Error reading diamond ABI: ${error}`)
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
