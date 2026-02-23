import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  decodeFunctionResult,
  parseAbi,
  type Abi,
  type Hex,
} from 'viem'

import { sleep } from '../utils/delay'
import { spawnAndCapture } from '../utils/spawnAndCapture'

import { INITIAL_CALL_DELAY, MAX_RETRIES, RETRY_DELAY } from './shared/constants'
import { retryWithRateLimit } from './shared/rateLimit'
import { hexToTronAddress } from './tron/utils'

/**
 * Call Tron contract function using troncast
 */
export async function callTronContract(
  contractAddress: string,
  functionSignature: string,
  params: string[],
  returnType: string,
  rpcUrl: string
): Promise<string> {
  // Build troncast command arguments
  // Use spawn-style arguments to avoid shell interpretation issues with commas
  const args = [
    'run',
    'troncast',
    'call',
    contractAddress,
    `${functionSignature} returns (${returnType})`,
    ...(params.length > 0 ? [params.join(',')] : []),
    '--rpc-url',
    rpcUrl,
  ]

  // Add initial delay for Tron to avoid rate limits
  await sleep(INITIAL_CALL_DELAY)

  // Execute with retry logic for rate limits
  const result = await retryWithRateLimit(
    () => spawnAndCapture('bun', args),
    MAX_RETRIES,
    RETRY_DELAY,
    (attempt: number, delay: number) => {
      consola.warn(
        `Rate limit detected (429). Retrying in ${
          delay / 1000
        }s... (attempt ${attempt}/${MAX_RETRIES})`
      )
    },
    false
  )

  return result
}

/**
 * Get Tron wallet address from globalConfig, falling back to EVM format if Tron version doesn't exist
 */
export function getTronWallet(
  globalConfig: Record<string, unknown>,
  walletName: string
): string {
  const tronKey = `${walletName}Tron`
  const tronValue = globalConfig[tronKey]
  const fallbackValue = globalConfig[walletName]
  
  if (typeof tronValue === 'string') return tronValue
  if (typeof fallbackValue === 'string') return fallbackValue
  
  throw new Error(`Wallet '${walletName}' not found in config`)
}

/**
 * Convert address to Tron format if it's in EVM format (0x...)
 */
export function ensureTronAddress(
  address: string,
  tronWeb: TronWeb
): string {
  if (address.startsWith('0x')) {
    return hexToTronAddress(address, tronWeb)
  }
  return address
}

/**
 * Parse address result from callTronContract output
 */
export function parseTronAddressOutput(output: string): string {
  return output.trim().replace(/^["']|["']$/g, '')
}

/**
 * Normalize selector to Hex format (ensure 0x prefix)
 */
export function normalizeSelector(selector: string): Hex {
  return selector.startsWith('0x') ? (selector as Hex) : (`0x${selector}` as Hex)
}

/**
 * Call Tron contract function using TronWeb and decode boolean result
 */
export async function callTronContractBoolean(
  tronWeb: TronWeb,
  contractAddress: string,
  functionSignature: string,
  params: Array<{ type: string; value: string }>,
  abiFunction: string
): Promise<boolean> {
  // Add initial delay for Tron to avoid rate limits
  await sleep(INITIAL_CALL_DELAY)

  const result = await retryWithRateLimit(
    () =>
      tronWeb.transactionBuilder.triggerConstantContract(
        contractAddress,
        functionSignature,
        {},
        params,
        tronWeb.defaultAddress?.base58 || tronWeb.defaultAddress?.hex || ''
      ),
    MAX_RETRIES,
    RETRY_DELAY
  )

  // Check if call was successful
  if (!result?.result?.result) {
    const errorMsg = result?.constant_result?.[0]
      ? tronWeb.toUtf8(result.constant_result[0])
      : 'Unknown error'
    throw new Error(`Call failed: ${errorMsg}`)
  }

  // Decode boolean result using viem's decodeFunctionResult
  const constantResult = result.constant_result?.[0]
  if (!constantResult) {
    throw new Error('No result returned from contract call')
  }

  const decodedResult = decodeFunctionResult({
    abi: parseAbi([abiFunction]) as Abi,
    functionName: functionSignature.split('(')[0],
    data: `0x${constantResult}` as Hex,
  })

  return decodedResult === true
}

/**
 * Parse a string representation of a nested array (e.g. troncast output) into [array, endIndex].
 * Used when JSON.parse fails on getAllContractSelectorPairs-style output.
 */
export function parseTroncastNestedArray(
  str: string,
  start: number
): [unknown[], number] {
  const result: unknown[] = []
  let i = start + 1
  let current = ''
  while (i < str.length) {
    const char = str[i]
    if (char === '[') {
      if (current.trim()) {
        result.push(current.trim())
        current = ''
      }
      const [nested, newPos] = parseTroncastNestedArray(str, i)
      result.push(nested)
      i = newPos
    } else if (char === ']') {
      if (current.trim()) result.push(current.trim())
      return [result, i + 1]
    } else if (char === ' ' || char === '\n' || char === '\t') {
      if (current.trim()) {
        result.push(current.trim())
        current = ''
      }
      i++
    } else {
      current += char
      i++
    }
  }
  return [result, i]
}

/**
 * Check ownership of a Tron contract
 * @param name - Contract name
 * @param expectedOwner - Expected owner address
 * @param deployedContracts - Record of deployed contract addresses
 * @param rpcUrl - RPC URL for Tron network
 * @param tronWeb - TronWeb instance
 * @param logError - Function to log errors
 */
export async function checkOwnershipTron(
  name: string,
  expectedOwner: string,
  deployedContracts: Record<string, string>,
  rpcUrl: string,
  tronWeb: TronWeb,
  logError: (msg: string) => void
): Promise<void> {
  if (deployedContracts[name]) {
    try {
      const contractAddress = deployedContracts[name]
      const ownerOutput = await callTronContract(
        contractAddress,
        'owner()',
        [],
        'address',
        rpcUrl
      )

      const ownerAddress = parseTronAddressOutput(ownerOutput)
      
      // Convert expectedOwner to Tron format if it's in EVM format (0x...)
      // This handles cases where getTronWallet falls back to EVM address
      const expectedOwnerTron = ensureTronAddress(expectedOwner, tronWeb)
      const expectedOwnerLower = expectedOwnerTron.toLowerCase()
      const actualOwnerLower = ownerAddress.toLowerCase()

      if (actualOwnerLower !== expectedOwnerLower) {
        logError(
          `${name} owner is ${ownerAddress}, expected ${expectedOwnerTron}`
        )
      } else {
        consola.success(`${name} owner is correct`)
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logError(`Failed to check ${name} ownership: ${errorMessage}`)
    }
  }
}

