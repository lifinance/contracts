import { spawn } from 'child_process'
import type { Buffer } from 'buffer'

import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  decodeFunctionResult,
  parseAbi,
  type Abi,
  type Hex,
} from 'viem'

import type {
  GetExpectedPairsFunction,
  IWhitelistConfig,
} from '../common/types'
import { INITIAL_CALL_DELAY, INTER_CALL_DELAY, RETRY_DELAY } from './tron/constants'
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

        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        child.on('close', (code: number | null) => {
          if (code !== 0) {
            const error = new Error(
              `Command failed with exit code ${code}: ${stderr || stdout}`
            )
            ;(error as Error & { message: string }).message = stderr || stdout || `Exit code ${code}`
            reject(error)
          } else {
            resolve(stdout)
          }
        })

        child.on('error', (error: Error) => {
          reject(error)
        })
      })
    },
    3,
    RETRY_DELAY,
    (attempt: number, delay: number) => {
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
      await sleep(INTER_CALL_DELAY)
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

/**
 * Check whitelist integrity for Tron network using troncast and TronWeb
 * @param network - Network name
 * @param deployedContracts - Record of deployed contract addresses
 * @param environment - Environment (staging/production)
 * @param whitelistConfig - Whitelist configuration
 * @param diamondAddress - Diamond contract address
 * @param rpcUrl - RPC URL for Tron network
 * @param tronWeb - TronWeb instance
 * @param logError - Function to log errors
 * @param getExpectedPairs - Function to get expected pairs from config
 */
export async function checkWhitelistIntegrityTron(
  network: string,
  deployedContracts: Record<string, string>,
  environment: string,
  whitelistConfig: IWhitelistConfig,
  diamondAddress: string,
  rpcUrl: string,
  tronWeb: TronWeb,
  logError: (msg: string) => void,
  getExpectedPairs: GetExpectedPairsFunction
): Promise<void> {
  consola.box('Checking Whitelist Integrity (Config vs. On-Chain State)...')

  // Get expected pairs from config
  const expectedPairs = await getExpectedPairs(
    network,
    deployedContracts,
    environment,
    whitelistConfig,
    true // isTron = true
  )

  if (expectedPairs.length === 0) {
    consola.warn('No expected pairs in config. Skipping all checks.')
    return
  }

  // --- 1. Preparation ---
  consola.info('Preparing expected data sets from config...')
  const uniqueContracts = new Set(
    expectedPairs.map((p) => p.contract.toLowerCase())
  )
  const uniqueSelectors = new Set(
    expectedPairs.map((p) => p.selector.toLowerCase())
  )
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${uniqueContracts.size} unique contracts, and ${uniqueSelectors.size} unique selectors.`
  )

  try {
    // Get on-chain data using getAllContractSelectorPairs
    consola.start('Fetching on-chain whitelist data...')
    const onChainDataOutput = await callTronContract(
      diamondAddress,
      'getAllContractSelectorPairs()',
      [],
      'address[],bytes4[][]',
      rpcUrl
    )

    // Parse the output - troncast returns nested arrays: [[addresses...] [[selectors...]]]
    // Try JSON.parse first, fallback to simple parsing
    let parsed: unknown[]
    try {
      parsed = JSON.parse(onChainDataOutput.trim())
    } catch {
      // If JSON.parse fails, use simple recursive parser (same approach as checkWhitelistSyncStatusPerNetwork.ts)
      const trimmed = onChainDataOutput.trim()
      if (!trimmed.startsWith('[')) {
        throw new Error('Expected array format')
      }
      const [parsedArray] = parseTroncastNestedArray(trimmed, 0)
      parsed = parsedArray as unknown[]
    }

    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error('Unexpected troncast output format: expected nested arrays')
    }

    const addresses = (parsed[0] as unknown[]) || []
    const selectorsArrays = (parsed[1] as unknown[]) || []

    if (!Array.isArray(addresses) || !Array.isArray(selectorsArrays)) {
      throw new Error('Unexpected troncast output format: expected arrays')
    }

    // Build sets for quick lookup
    // For Tron, addresses are base58 and should be compared in lowercase for consistency
    const onChainPairSet = new Set<string>()
    for (let i = 0; i < addresses.length; i++) {
      const contract = String(addresses[i]).toLowerCase()
      const selectors = (selectorsArrays[i] as unknown[]) || []
      if (Array.isArray(selectors)) {
        for (const selector of selectors) {
          const selectorLower = String(selector).toLowerCase()
          onChainPairSet.add(`${contract}:${selectorLower}`)
        }
      }
    }

    consola.info(
      `On-chain has ${addresses.length} contracts with ${onChainPairSet.size} total pairs.`
    )

    // Check each expected pair using isContractSelectorWhitelisted
    // Use TronWeb directly to avoid troncast parsing issues with address+bytes4 parameters
    consola.start('Step 1/2: Checking Config vs. On-Chain Functions...')
    let granularFails = 0

    for (const expectedPair of expectedPairs) {
      try {
        // Add delay to avoid rate limits
        await sleep(INTER_CALL_DELAY)

        // Use TronWeb directly instead of troncast to avoid parameter parsing issues
        // expectedPair.contract is already in original base58 format (not lowercase) for Tron
        const isWhitelisted = await callTronContractBoolean(
          tronWeb,
          diamondAddress,
          'isContractSelectorWhitelisted(address,bytes4)',
          [
            { type: 'address', value: expectedPair.contract },
            { type: 'bytes4', value: expectedPair.selector },
          ],
          'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)'
        )

        if (!isWhitelisted) {
          logError(
            `Source of Truth FAILED: ${expectedPair.contract} / ${expectedPair.selector} is 'false'.`
          )
          granularFails++
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logError(
          `Failed to check ${expectedPair.contract}/${expectedPair.selector}: ${errorMessage}`
        )
        granularFails++
      }
    }

    if (granularFails === 0) {
      consola.success(
        'Source of Truth (isContractSelectorWhitelisted) is synced.'
      )
    }

    // Check Config vs. Getter Arrays
    consola.start('Step 2/2: Checking Config vs. Getter Arrays...')

    // Build expected pair set for comparison (use lowercase for addresses to match onChainPairSet)
    const expectedPairSet = new Set<string>()
    for (const pair of expectedPairs) {
      expectedPairSet.add(
        `${pair.contract.toLowerCase()}:${pair.selector.toLowerCase()}`
      )
    }

    // Check for missing pairs (in config but not on-chain)
    const missingPairsList: string[] = []
    for (const expectedPair of expectedPairs) {
      const key = `${expectedPair.contract.toLowerCase()}:${expectedPair.selector.toLowerCase()}`
      if (!onChainPairSet.has(key)) {
        missingPairsList.push(key)
      }
    }

    // Check for stale pairs (on-chain but not in config)
    const stalePairsList: string[] = []
    for (const onChainPair of onChainPairSet) {
      if (!expectedPairSet.has(onChainPair)) {
        stalePairsList.push(onChainPair)
      }
    }

    if (missingPairsList.length === 0 && stalePairsList.length === 0) {
      consola.success(
        `Pair Array (getAllContractSelectorPairs) is synced. (${onChainPairSet.size} pairs)`
      )
    } else {
      if (missingPairsList.length > 0) {
        logError(
          `Pair Array is missing ${missingPairsList.length} pairs from config:`
        )
        missingPairsList.slice(0, 10).forEach((pair) => {
          const [contract, selector] = pair.split(':')
          logError(`  Missing: ${contract} / ${selector}`)
        })
        if (missingPairsList.length > 10) {
          logError(`  ... and ${missingPairsList.length - 10} more`)
        }
        consola.warn(
          `\n💡 To fix missing pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist ${network} ${environment}`
        )
      }
      if (stalePairsList.length > 0) {
        logError(
          `Pair Array has ${stalePairsList.length} stale pairs not in config:`
        )
        stalePairsList.slice(0, 10).forEach((pair) => {
          const [contract, selector] = pair.split(':')
          logError(`  Stale: ${contract} / ${selector}`)
        })
        if (stalePairsList.length > 10) {
          logError(`  ... and ${stalePairsList.length - 10} more`)
        }
        consola.warn(
          `\n💡 To fix stale pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist ${network} ${environment}`
        )
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logError(`Failed during whitelist integrity checks: ${errorMessage}`)
  }
}
