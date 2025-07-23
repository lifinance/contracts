/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 *
 * Implements a comprehensive selector resolution strategy:
 * 1. Check local diamond.json
 * 2. Check critical selectors (diamondCut, schedule, etc.)
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
  abi?: string
}

/**
 * Options for decoding transactions
 */
export interface IDecodeOptions {
  maxDepth?: number
  network?: string
}

/**
 * Critical function selectors we need to decode
 */
export const CRITICAL_SELECTORS: Record<
  string,
  { name: string; abi?: string }
> = {
  '0x1f931c1c': {
    name: 'diamondCut',
    abi: 'function diamondCut((address,uint8,bytes4[])[],address,bytes)',
  },
  '0x01d5062a': {
    name: 'schedule',
    abi: 'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  },
  '0x7200b829': {
    name: 'confirmOwnershipTransfer',
    abi: 'function confirmOwnershipTransfer()',
  },
}

/**
 * Try to find function in diamond ABI
 */
async function tryDiamondABI(
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  try {
    const diamondPath = path.join(__dirname, '../../../diamond.json')

    if (fs.existsSync(diamondPath)) {
      const diamondData = JSON.parse(fs.readFileSync(diamondPath, 'utf8'))

      // Search through all contracts in diamond.json
      for (const [contractName, contractData] of Object.entries(
        diamondData.contracts || {}
      )) {
        const abi = (contractData as any).abi
        if (!abi) continue

        // Find function with matching selector
        const func = abi.find((item: any) => {
          if (item.type !== 'function') return false
          const funcSelector = toFunctionSelector(item)
          return funcSelector === selector
        })

        if (func) {
          consola.debug(`Found in diamond ABI: ${func.name} (${contractName})`)
          return {
            functionName: func.name,
            contractName,
            decodedVia: 'diamond',
          }
        }
      }
    }
  } catch (error) {
    consola.debug(`Error reading diamond.json: ${error}`)
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
    const deploymentsPath = path.join(__dirname, '../../../deployments')

    // If network is specified, check that specific file
    if (network) {
      const networkFiles = [
        `${network}.json`,
        `${network}.diamond.json`,
        `${network}.staging.json`,
        `${network}.diamond.staging.json`,
      ]

      for (const file of networkFiles) {
        const filePath = path.join(deploymentsPath, file)
        if (fs.existsSync(filePath)) {
          const result = await checkDeploymentFile(filePath, selector)
          if (result) return result
        }
      }
    } else {
      // Check all deployment files
      const files = fs
        .readdirSync(deploymentsPath)
        .filter((f) => f.endsWith('.json'))

      for (const file of files) {
        const filePath = path.join(deploymentsPath, file)
        const result = await checkDeploymentFile(filePath, selector)
        if (result) return result
      }
    }
  } catch (error) {
    consola.debug(`Error checking deployment logs: ${error}`)
  }

  return null
}

/**
 * Check a specific deployment file for the selector
 */
async function checkDeploymentFile(
  filePath: string,
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    // Search through all contracts
    for (const [contractName, contractData] of Object.entries(data)) {
      const abi = (contractData as any).abi
      if (!abi) continue

      // Find function with matching selector
      const func = abi.find((item: any) => {
        if (item.type !== 'function') return false
        const funcSelector = toFunctionSelector(item)
        return funcSelector === selector
      })

      if (func) {
        consola.debug(
          `Found in deployment logs: ${func.name} (${contractName})`
        )
        return {
          functionName: func.name,
          contractName,
          decodedVia: 'deployment',
        }
      }
    }
  } catch (error) {
    consola.debug(`Error reading deployment file ${filePath}: ${error}`)
  }

  return null
}

/**
 * Try to find function in critical selectors
 */
async function tryCriticalSelectors(
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  if (CRITICAL_SELECTORS[selector]) {
    consola.debug(
      `Found in critical selectors: ${CRITICAL_SELECTORS[selector].name}`
    )
    return {
      functionName: CRITICAL_SELECTORS[selector].name,
      abi: CRITICAL_SELECTORS[selector].abi,
      decodedVia: 'known',
    }
  }

  return null
}

/**
 * Try to resolve selector using external API
 */
async function tryExternalAPI(
  selector: string
): Promise<Partial<IDecodedTransaction> | null> {
  try {
    consola.debug(`Trying external API for selector ${selector}`)
    const response = await fetch(
      `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`
    )

    if (response.ok) {
      const data = await response.json()
      if (data.result?.function?.[selector]?.[0]?.name) {
        const functionName = data.result.function[selector][0].name
        consola.debug(`Found via external API: ${functionName}`)
        return {
          functionName: functionName.split('(')[0], // Extract just the function name
          decodedVia: 'external',
        }
      }
    }
  } catch (error) {
    consola.debug(`External API lookup failed: ${error}`)
  }

  return null
}

/**
 * Main function to decode transaction data
 * @param data - The transaction data to decode
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
    () => tryCriticalSelectors(selector),
    () => tryDeploymentLogs(selector, options?.network),
    () => tryExternalAPI(selector),
  ]

  let result: IDecodedTransaction = {
    selector,
    decodedVia: 'unknown',
    rawData: data,
  }

  // Try each strategy until one succeeds
  for (const strategy of strategies) {
    const decoded = await strategy()
    if (decoded) {
      result = { ...result, ...decoded } as IDecodedTransaction
      break
    }
  }

  // Try to decode function arguments if we found the function
  if (result.functionName)
    try {
      // Check if we have an ABI for this function
      if (CRITICAL_SELECTORS[selector]?.abi) {
        consola.debug(`Decoding args with known ABI for ${selector}`)
        const abi = CRITICAL_SELECTORS[selector].abi
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

  // Try to decode nested calls if applicable
  if (result.args && options?.maxDepth !== 0) {
    const nestedData = extractNestedCallData(result)
    if (nestedData)
      result.nestedCall = await decodeNestedCall(
        nestedData,
        1,
        options?.maxDepth
      )
  }

  return result
}

/**
 * Decode a nested call with depth limiting
 * @param data - The nested call data
 * @param currentDepth - Current recursion depth
 * @param maxDepth - Maximum recursion depth (default 3)
 * @returns Decoded nested transaction
 */
export async function decodeNestedCall(
  data: Hex,
  currentDepth = 1,
  maxDepth = 3
): Promise<IDecodedTransaction> {
  if (currentDepth > maxDepth)
    return {
      selector: data.substring(0, 10) as Hex,
      decodedVia: 'unknown',
      rawData: data,
    }

  const decoded = await decodeTransactionData(data, {
    maxDepth: maxDepth - currentDepth,
  })

  // Check for further nested calls
  if (decoded.args && currentDepth < maxDepth) {
    const nestedData = extractNestedCallData(decoded)
    if (nestedData)
      decoded.nestedCall = await decodeNestedCall(
        nestedData,
        currentDepth + 1,
        maxDepth
      )
  }

  return decoded
}

/**
 * Extract nested call data from decoded transaction
 * Handles various patterns like timelock schedule, multicall, etc.
 */
function extractNestedCallData(decoded: IDecodedTransaction): Hex | null {
  if (!decoded.args || !decoded.functionName) return null

  // Handle timelock schedule pattern
  if (decoded.functionName === 'schedule' && decoded.args.length >= 3) {
    // In schedule(target, value, data, ...), data is at index 2
    const data = decoded.args[2]
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 10)
      return data as Hex
  }

  // Handle multicall pattern
  if (decoded.functionName === 'multicall' && Array.isArray(decoded.args[0])) {
    // Return first call for now
    const firstCall = decoded.args[0][0]
    if (typeof firstCall === 'string' && firstCall.startsWith('0x'))
      return firstCall as Hex
  }

  // Generic pattern: look for hex data in args
  try {
    for (const arg of decoded.args) {
      // Check if arg looks like call data
      if (typeof arg === 'string' && arg.startsWith('0x') && arg.length > 10) {
        // Try to parse it as a selector
        const potentialSelector = arg.substring(0, 10)
        // Basic validation: should be hex
        if (/^0x[a-fA-F0-9]{8}$/.test(potentialSelector)) return arg as Hex
      }
      // Check nested arrays (common in multicall patterns)
      if (Array.isArray(arg))
        for (const item of arg)
          if (
            typeof item === 'object' &&
            item !== null &&
            'data' in item &&
            typeof item.data === 'string'
          )
            return item.data as Hex
          else if (
            typeof item === 'string' &&
            item.startsWith('0x') &&
            item.length > 10
          )
            return item as Hex
    }
  } catch (error) {
    consola.debug(`Error extracting nested call data: ${error}`)
  }

  return null
}
