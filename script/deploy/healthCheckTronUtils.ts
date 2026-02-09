// @ts-nocheck
import { spawn } from 'child_process'

import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  decodeFunctionResult,
  parseAbi,
  type Hex,
} from 'viem'

import { INITIAL_CALL_DELAY, RETRY_DELAY } from '../utils/delayConstants'
import { sleep } from '../utils/delay'
import { hexToTronAddress, retryWithRateLimit } from './tron/utils'

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

  // Execute with retry logic for rate limits using spawn to avoid shell issues
  const result = await retryWithRateLimit(
    () => {
      return new Promise<string>((resolve, reject) => {
        const child = spawn('bun', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        child.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('close', (code) => {
          if (code !== 0) {
            const error = new Error(
              `Command failed with exit code ${code}: ${stderr || stdout}`
            )
            ;(error as any).message = stderr || stdout || `Exit code ${code}`
            reject(error)
          } else {
            resolve(stdout)
          }
        })

        child.on('error', (error) => {
          reject(error)
        })
      })
    },
    3,
    RETRY_DELAY,
    (attempt, delay) => {
      consola.warn(
        `Rate limit detected (429). Retrying in ${
          delay / 1000
        }s... (attempt ${attempt}/3)`
      )
    },
    false
  )

  return result.trim()
}

/**
 * Get Tron wallet address from globalConfig, falling back to EVM format if Tron version doesn't exist
 */
export function getTronWallet(
  globalConfig: any,
  walletName: string
): string {
  const tronKey = `${walletName}Tron`
  return (globalConfig as any)[tronKey] || globalConfig[walletName]
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
  const result = await retryWithRateLimit(
    () =>
      tronWeb.transactionBuilder.triggerConstantContract(
        contractAddress,
        functionSignature,
        {},
        params,
        tronWeb.defaultAddress?.base58 || tronWeb.defaultAddress?.hex || ''
      ),
    3,
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
    abi: parseAbi([abiFunction]),
    functionName: functionSignature.split('(')[0],
    data: `0x${constantResult}`,
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
