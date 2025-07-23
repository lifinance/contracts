/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 *
 * Implements a comprehensive selector resolution strategy:
 * 1. Check local diamond.json
 * 2. Check local known selectors mapping
 * 3. Check deployment logs for contract names
 * 4. Fall back to external API (openchain.xyz)
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import type { Hex } from 'viem'
import { toFunctionSelector, decodeFunctionData, parseAbi } from 'viem'

/**
 * Represents a decoded transaction with comprehensive metadata
 */
export interface IDecodedTransaction {
  functionName?: string
  selector: string
  args?: any[]
  contractName?: string
  decodedVia: 'diamond' | 'deployment' | 'known' | 'external' | 'unknown'
  nestedCall?: IDecodedTransaction
  rawData?: Hex
}

/**
 * Options for decoding transactions
 */
export interface IDecodeOptions {
  maxDepth?: number
  network?: string
}

/**
 * Known selectors mapping - loaded from config file
 */
let knownSelectors: Record<string, { name: string; abi?: string }> = {}

/**
 * Load known selectors from config file
 */
function loadKnownSelectors(): void {
  try {
    const projectRoot = process.cwd()
    const knownSelectorsPath = path.join(
      projectRoot,
      'config',
      'knownSelectors.json'
    )

    if (fs.existsSync(knownSelectorsPath)) {
      knownSelectors = JSON.parse(fs.readFileSync(knownSelectorsPath, 'utf8'))
      consola.debug(
        `Loaded ${Object.keys(knownSelectors).length} known selectors`
      )
    }
  } catch (error) {
    consola.debug(`Could not load known selectors: ${error}`)
  }
}

// Load known selectors on module initialization
loadKnownSelectors()

/**
 * Try to find function in diamond ABI
 */
async function tryDiamondABI(
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  try {
    const projectRoot = process.cwd()
    const diamondPath = path.join(projectRoot, 'diamond.json')

    if (!fs.existsSync(diamondPath)) return null

    const abiData = JSON.parse(fs.readFileSync(diamondPath, 'utf8'))
    if (!Array.isArray(abiData)) return null

    // Search for matching function selector in diamond ABI
    for (const abiItem of abiData)
      if (abiItem.type === 'function')
        try {
          const calculatedSelector = toFunctionSelector(abiItem)
          if (calculatedSelector === selector) {
            consola.debug(`Found in diamond ABI: ${abiItem.name}`)
            return {
              functionName: abiItem.name,
              contractName: 'Diamond',
              decodedVia: 'diamond',
            }
          }
        } catch (error) {
          // Skip invalid ABI items
          continue
        }
  } catch (error) {
    consola.debug(`Error reading diamond ABI: ${error}`)
  }

  return null
}

/**
 * Try to find function in deployment logs
 */
async function tryDeploymentLogs(
  selector: string,
  network?: string
): Promise<Partial<IDecodedTransaction> | null> {
  try {
    const projectRoot = process.cwd()
    const deploymentsDir = path.join(projectRoot, 'deployments')

    // If network is specified, check that specific file first
    const filesToCheck = network
      ? [
          `${network}.json`,
          `${network}.diamond.json`,
          `${network}.staging.json`,
        ]
      : fs.readdirSync(deploymentsDir).filter((f) => f.endsWith('.json'))

    for (const file of filesToCheck)
      try {
        const deploymentPath = path.join(deploymentsDir, file)
        if (!fs.existsSync(deploymentPath)) continue

        const deploymentData = JSON.parse(
          fs.readFileSync(deploymentPath, 'utf8')
        )

        // Check each deployed contract
        for (const [contractName, address] of Object.entries(deploymentData)) {
          if (typeof address !== 'string') continue

          // Try to find the contract's ABI
          const contractAbiPath = path.join(
            projectRoot,
            'out',
            `${contractName}.sol`,
            `${contractName}.json`
          )

          if (fs.existsSync(contractAbiPath)) {
            const contractData = JSON.parse(
              fs.readFileSync(contractAbiPath, 'utf8')
            )
            if (contractData.abi && Array.isArray(contractData.abi))
              for (const abiItem of contractData.abi)
                if (abiItem.type === 'function')
                  try {
                    const calculatedSelector = toFunctionSelector(abiItem)
                    if (calculatedSelector === selector) {
                      consola.debug(
                        `Found in deployment logs: ${abiItem.name} (${contractName})`
                      )
                      return {
                        functionName: abiItem.name,
                        contractName,
                        decodedVia: 'deployment',
                      }
                    }
                  } catch (error) {
                    continue
                  }
          }
        }
      } catch (error) {
        consola.debug(`Error reading deployment file ${file}: ${error}`)
      }
  } catch (error) {
    consola.debug(`Error reading deployment logs: ${error}`)
  }

  return null
}

/**
 * Try to find function in known selectors
 */
async function tryKnownSelectors(
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  // Ensure selectors are loaded
  if (Object.keys(knownSelectors).length === 0) loadKnownSelectors()

  if (knownSelectors[selector]) {
    consola.debug(`Found in known selectors: ${knownSelectors[selector].name}`)
    return {
      functionName: knownSelectors[selector].name,
      decodedVia: 'known',
    }
  }
  return null
}

/**
 * Try to find function using external API
 */
async function tryExternalAPI(
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  try {
    consola.debug('Fetching from openchain.xyz...')
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`
    const response = await fetch(url)
    const responseData = await response.json()

    if (
      responseData.ok &&
      responseData.result &&
      responseData.result.function &&
      responseData.result.function[selector]
    ) {
      const functionData = responseData.result.function[selector][0]
      consola.debug(`Found in external API: ${functionData.name}`)
      return {
        functionName: functionData.name,
        decodedVia: 'external',
      }
    }
  } catch (error) {
    consola.debug(`Error fetching from external API: ${error}`)
  }

  return null
}

/**
 * Decodes a transaction's function call using comprehensive selector resolution
 * @param data - Transaction data
 * @param options - Decoding options
 * @returns Decoded transaction information
 */
export async function decodeTransactionData(
  data: Hex,
  options?: IDecodeOptions
): Promise<IDecodedTransaction> {
  if (!data || data === '0x')
    return {
      selector: '0x',
      decodedVia: 'unknown',
      rawData: data,
    }

  const selector = data.substring(0, 10) as Hex

  // Try resolution strategies in order
  const strategies = [
    () => tryDiamondABI(selector),
    () => tryKnownSelectors(selector),
    () => tryDeploymentLogs(selector, options?.network),
    () => tryExternalAPI(selector),
  ]

  let result: IDecodedTransaction = {
    selector,
    decodedVia: 'unknown',
    rawData: data,
  }

  for (const strategy of strategies) {
    const strategyResult = await strategy()
    if (strategyResult && strategyResult.functionName) {
      result = { ...result, ...strategyResult } as IDecodedTransaction
      break
    }
  }

  // Try to decode arguments if we found the function
  if (result.functionName)
    try {
      // First try known selectors ABI
      if (knownSelectors[selector]?.abi) {
        consola.debug(`Decoding args with known ABI for ${selector}`)
        const abi = knownSelectors[selector].abi
        if (!abi) throw new Error('ABI not found')
        const abiInterface = parseAbi([abi])
        const decoded = decodeFunctionData({
          abi: abiInterface,
          data,
        })
        result.args = decoded.args as any[]
        consola.debug(`Decoded ${result.args?.length || 0} args`)
      }
      // Try to construct a basic function signature and decode
      // This works for standard function signatures
      else
        try {
          const fullAbiString = `function ${result.functionName}`
          const abiInterface = parseAbi([fullAbiString])
          const decoded = decodeFunctionData({
            abi: abiInterface,
            data,
          })
          result.args = decoded.args as any[]
        } catch {
          // If that fails, we can't decode the args
          consola.debug(`Could not decode args for ${result.functionName}`)
        }
    } catch (error) {
      consola.debug(`Could not decode function arguments: ${error}`)
    }

  // Check for nested calls if this is a known wrapper function
  if (
    result.functionName &&
    ['schedule', 'scheduleBatch', 'execute', 'executeBatch'].includes(
      result.functionName
    ) &&
    options?.maxDepth !== 0
  ) {
    const nestedData = await extractNestedCallData(result, data)
    if (nestedData)
      result.nestedCall = await decodeNestedCall(
        nestedData,
        1,
        options?.maxDepth || 5,
        options
      )
  }

  return result
}

/**
 * Extract nested call data from known wrapper functions
 */
async function extractNestedCallData(
  decoded: IDecodedTransaction,
  originalData: Hex
): Promise<Hex | null> {
  try {
    if (!decoded.functionName) return null

    // Handle timelock schedule function
    if (decoded.functionName === 'schedule' && decoded.args) {
      // schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)
      const data = decoded.args[2]
      if (data && data !== '0x') return data as Hex
    }

    // Try to decode based on known function signatures
    const selectorAbi = decoded.selector
      ? knownSelectors[decoded.selector]?.abi
      : undefined
    if (selectorAbi) {
      const abiInterface = parseAbi([selectorAbi])
      const decodedData = decodeFunctionData({
        abi: abiInterface,
        data: originalData,
      })

      // Look for common data parameter names
      const dataParamNames = ['data', 'callData', '_data', '_callData']
      for (const paramName of dataParamNames)
        if (decodedData.args && paramName in decodedData.args) {
          const data = (decodedData.args as any)[paramName]
          if (data && data !== '0x') return data as Hex
        }

      // Check by index for common patterns
      if (decodedData.args && Array.isArray(decodedData.args)) {
        // For schedule-like functions, data is usually at index 2
        if (decoded.functionName.includes('schedule') && decodedData.args[2])
          return decodedData.args[2] as Hex

        // For execute-like functions, data might be at different positions
        if (decoded.functionName.includes('execute'))
          for (const arg of decodedData.args)
            if (
              typeof arg === 'string' &&
              arg.startsWith('0x') &&
              arg.length > 10
            )
              return arg as Hex
      }
    }
  } catch (error) {
    consola.debug(`Error extracting nested call data: ${error}`)
  }

  return null
}

/**
 * Recursively decode nested calls
 * @param data - Transaction data to decode
 * @param currentDepth - Current recursion depth
 * @param maxDepth - Maximum recursion depth
 * @param options - Decoding options
 * @returns Decoded transaction information
 */
export async function decodeNestedCall(
  data: Hex,
  currentDepth = 0,
  maxDepth = 5,
  options?: IDecodeOptions
): Promise<IDecodedTransaction> {
  if (currentDepth >= maxDepth) {
    consola.debug(`Max recursion depth (${maxDepth}) reached`)
    return {
      selector: data.substring(0, 10) as Hex,
      decodedVia: 'unknown',
      rawData: data,
    }
  }

  const decoded = await decodeTransactionData(data, {
    ...options,
    maxDepth: maxDepth - currentDepth,
  })

  return decoded
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use decodeTransactionData with proper return type handling
 */
export async function decodeTransactionDataLegacy(data: Hex): Promise<{
  functionName?: string
  decodedData?: any
}> {
  const result = await decodeTransactionData(data)
  return {
    functionName: result.functionName,
    decodedData: result.functionName
      ? {
          functionName: result.functionName,
          contractName: result.contractName || 'Unknown',
          args: result.args,
        }
      : undefined,
  }
}
