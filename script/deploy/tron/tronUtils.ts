/**
 * Tron-specific deployment utilities: diamond JSON management,
 * health-check helpers (ownership, facet/whitelist verification), and on-chain cost helpers.
 * Generic deployment utilities (file I/O, environment, selectors) live in `../../utils/utils.ts`.
 */

import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import { decodeFunctionResult, parseAbi, type Abi, type Hex } from 'viem'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { sleep } from '../../utils/delay'
import { spawnAndCapture } from '../../utils/spawnAndCapture'
import {
  getContractAddress,
  getFacetSelectors,
  logDeployment,
  saveContractAddress,
  updateDiamondJson,
} from '../../utils/utils'
import {
  INITIAL_CALL_DELAY,
  MAX_RETRIES,
  RETRY_DELAY,
  ZERO_ADDRESS,
} from '../shared/constants'
import { getContractVersion } from '../shared/getContractVersion'
import { isRateLimitError } from '../shared/rateLimit'

import {
  DEFAULT_FEE_LIMIT_TRX,
  DIAMOND_CUT_ENERGY_MULTIPLIER,
  MIN_BALANCE_REGISTRATION,
  MIN_BALANCE_WARNING,
  TRON_ZERO_ADDRESS,
} from './constants'
import { estimateContractCallEnergy } from './helpers/estimateContractEnergy'
import { loadForgeArtifact } from './helpers/loadForgeArtifact'
import { getCurrentPrices } from './helpers/tronPricing'
import {
  getTronWebCodecFullHost,
  getTronWebCodecOnly,
} from './helpers/tronWebCodecOnly'
import { createTronWebReadOnly } from './helpers/tronWebFactory'
import {
  evmHexToTronBase58,
  tronAddressToHex,
  tryTronFacetLoupeAddressToBase58,
} from './tronAddressHelpers'
import type { IDiamondRegistrationResult } from './types'

/**
 * Prompt user to confirm they are aware they can rent energy (e.g. Zinergy.ag, 1 hr) to reduce TRON deployment costs.
 * Call before starting deployments when not in dry run. If user declines, exits the process.
 */
export async function promptEnergyRentalReminder(): Promise<void> {
  consola.info(
    'Tip: You can rent energy (e.g. from Zinergy.ag for 1 hour) to reduce TRX burn during deployment.'
  )
  const proceed = await consola.prompt('Continue with deployment?', {
    type: 'confirm',
    initial: true,
  })
  if (proceed !== true) {
    consola.info('Deployment cancelled.')
    process.exit(0)
  }
}

/**
 * Check if a contract is deployed on Tron
 * @param contract The contract name
 * @param deployedContracts The deployed contracts record
 * @param tronWeb The TronWeb instance
 * @returns Promise<boolean> indicating if the contract is deployed
 */
export async function checkIsDeployedTron(
  contract: string,
  deployedContracts: Record<string, string>,
  tronWeb: any
): Promise<boolean> {
  if (!deployedContracts[contract]) {
    consola.warn(
      `Contract "${contract}" not found in deployments file. Ensure deployments/tron.json (or .staging) contains this contract.`
    )
    return false
  }

  // For Tron, addresses in deployments are already in Tron format
  const tronAddress = deployedContracts[contract]

  // Add initial delay for Tron to avoid rate limits
  await sleep(INITIAL_CALL_DELAY)

  type GetContractResult = { contract_address?: string } | null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY)
    try {
      const contractInfo = (await tronWeb.trx.getContract(
        tronAddress
      )) as GetContractResult
      const address = contractInfo?.contract_address
      if (address) return true
      consola.warn(
        `Contract "${contract}" at ${tronAddress}: getContract returned no contract_address (contract may not exist on-chain).`
      )
      return false
    } catch (error: unknown) {
      const shouldRetry = isRateLimitError(error) && attempt < MAX_RETRIES
      if (!shouldRetry) {
        const msg = error instanceof Error ? error.message : String(error)
        consola.warn(
          `Contract "${contract}" at ${tronAddress}: getContract failed after retries. Reason: ${msg}`
        )
        return false
      }
    }
  }

  consola.warn(
    `Contract "${contract}" at ${tronAddress}: getContract failed after retries.`
  )
  return false
}

/**
 * Wait between deployments using TronGrid RPC calls
 * Uses lightweight RPC calls (getNowBlock) to wait, which naturally respects rate limits
 * @param seconds Number of seconds to wait
 * @param verbose Whether to log the wait message
 * @param tronWeb Optional TronWeb instance (if not provided, will create a minimal one)
 * @param fullHost Optional Tron RPC URL (if not provided, will use default)
 * @param headers Optional headers for API key authentication
 */
export async function waitBetweenDeployments(
  seconds: number,
  verbose = false,
  tronWeb?: any,
  fullHost?: string,
  headers?: Record<string, string>
): Promise<void> {
  if (seconds <= 0) return

  if (verbose) {
    consola.debug(
      `Waiting ${seconds} second(s) using TronGrid RPC calls to avoid rate limits...`
    )
  }

  // Calculate number of RPC calls to make (one per second)
  const numCalls = Math.ceil(seconds)
  const delayPerCall = Math.max(1000, Math.floor((seconds * 1000) / numCalls))

  // Use provided TronWeb or create a minimal one for RPC calls
  let rpcTronWeb = tronWeb
  if (!rpcTronWeb && fullHost) {
    rpcTronWeb = createTronWebReadOnly({
      rpcUrl: fullHost,
      headers,
    })
  } else if (!rpcTronWeb) {
    rpcTronWeb = createTronWebReadOnly({
      rpcUrl: getTronWebCodecFullHost(),
      verbose,
    })
  }

  // Make lightweight RPC calls to wait (getNowBlock is a lightweight call)
  for (let i = 0; i < numCalls; i++) {
    try {
      // Use getNowBlock as a lightweight RPC call to wait
      // This naturally respects rate limits and provides actual network interaction
      await rpcTronWeb.trx.getNowBlock()

      if (i < numCalls - 1) {
        // Wait between calls (except for the last one)
        await sleep(delayPerCall)
      }
    } catch (error) {
      // If RPC call fails, fall back to simple timeout
      if (verbose) {
        consola.debug(
          `RPC call failed during wait, using timeout fallback: ${error}`
        )
      }
      await sleep(delayPerCall)
    }
  }
}

/**
 * Deploy a contract with standard error handling and logging
 */
export async function deployContractWithLogging(
  deployer: any, // TronContractDeployer
  contractName: string,
  constructorArgs: any[] = [],
  dryRun = false,
  network: SupportedChain = 'tron'
): Promise<IDeploymentResult> {
  try {
    const artifact = await loadForgeArtifact(contractName)
    const version = await getContractVersion(contractName)

    consola.info(`Deploying ${contractName} v${version}...`)

    if (constructorArgs.length > 0)
      consola.info(`Constructor arguments:`, constructorArgs)

    const result = await deployer.deployContract(artifact, constructorArgs)

    consola.success(`${contractName} deployed to: ${result.contractAddress}`)
    consola.info(`Transaction: ${result.transactionId}`)
    consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

    // Log deployment (skip in dry run)
    if (!dryRun) {
      // Encode constructor args
      const constructorArgsHex =
        constructorArgs.length > 0
          ? await encodeConstructorArgs(constructorArgs)
          : '0x'

      await logDeployment(
        contractName,
        network,
        result.contractAddress,
        version,
        constructorArgsHex,
        false
      )

      await saveContractAddress(network, contractName, result.contractAddress)
    }

    return {
      contract: contractName,
      address: result.contractAddress,
      txId: result.transactionId,
      cost: result.actualCost.trxCost,
      version,
      status: 'success',
    }
  } catch (error: any) {
    consola.error(`Failed to deploy ${contractName}:`, error.message)
    throw error
  }
}

/**
 * Encode constructor arguments to hex
 */
export async function encodeConstructorArgs(args: any[]): Promise<string> {
  // Return empty hex for no arguments
  if (args.length === 0) return '0x'

  try {
    const tronWeb = getTronWebCodecOnly()

    // Determine types based on argument values
    const types: string[] = args.map((arg) => {
      if (typeof arg === 'string') {
        // Check if it's an address (starts with T or 0x)
        if (arg.startsWith('T') || arg.startsWith('0x')) return 'address'

        return 'string'
      } else if (typeof arg === 'number' || typeof arg === 'bigint')
        return 'uint256'
      else if (typeof arg === 'boolean') return 'bool'
      else if (Array.isArray(arg)) {
        // For arrays, try to determine the element type
        if (arg.length > 0 && typeof arg[0] === 'string') return 'string[]'

        return 'uint256[]'
      }
      return 'bytes'
    })

    // Use TronWeb's ABI encoder
    return tronWeb.utils.abi.encodeParams(types, args)
  } catch (error) {
    consola.warn('Failed to encode constructor args, using fallback:', error)
    // Fallback to simple hex encoding
    return (
      '0x' +
      args
        .map((arg) => {
          if (typeof arg === 'string' && arg.startsWith('0x'))
            return arg.slice(2)

          return Buffer.from(String(arg)).toString('hex')
        })
        .join('')
    )
  }
}

/**
 * Estimate energy for diamondCut transaction
 */
export async function estimateDiamondCutEnergy(
  tronWeb: any,
  diamondAddress: string,
  facetCuts: any[],
  fullHost: string
): Promise<number> {
  consola.info('Estimating energy for diamondCut...')

  const encodedParams = tronWeb.utils.abi
    .encodeParams(
      ['(address,uint8,bytes4[])[]', 'address', 'bytes'],
      [facetCuts, ZERO_ADDRESS, '0x']
    )
    .replace(/^0x/, '')

  return estimateContractCallEnergy({
    fullHost,
    tronWeb,
    contractAddressBase58: diamondAddress,
    functionSelector: 'diamondCut((address,uint8,bytes4[])[],address,bytes)',
    parameterHex: encodedParams,
    safetyMargin: DIAMOND_CUT_ENERGY_MULTIPLIER,
  })
}

/**
 * Register a facet to the diamond
 */
export async function registerFacetToDiamond(
  facetName: string,
  facetAddress: string,
  tronWeb: any,
  fullHost: string,
  dryRun = false,
  networkOrDiamondAddress: SupportedChain | string = 'tron'
): Promise<IDiamondRegistrationResult> {
  try {
    // Determine if we received a network name or a diamond address
    let diamondAddress: string
    let network: SupportedChain

    // Check if it's a Tron address (starts with T) or hex address
    if (
      networkOrDiamondAddress.startsWith('T') ||
      networkOrDiamondAddress.startsWith('0x')
    ) {
      diamondAddress = networkOrDiamondAddress
      // Default to 'tron' for network when diamond address is provided directly
      network = 'tron'
    } else {
      // It's a network name
      network = networkOrDiamondAddress as SupportedChain
      const loadedAddress = await getContractAddress(network, 'LiFiDiamond')
      if (!loadedAddress)
        throw new Error(`LiFiDiamond not found in deployments for ${network}`)
      diamondAddress = loadedAddress
    }

    consola.info(`Registering ${facetName} to LiFiDiamond: ${diamondAddress}`)

    // Load ABIs
    const diamondCutABI = await loadForgeArtifact('DiamondCutFacet')
    const diamondLoupeABI = await loadForgeArtifact('DiamondLoupeFacet')
    const combinedABI = [...diamondCutABI.abi, ...diamondLoupeABI.abi]
    const diamond = tronWeb.contract(combinedABI, diamondAddress)

    // Get function selectors
    const selectors = await getFacetSelectors(facetName)
    consola.info(`Found ${selectors.length} function selectors`)

    if (dryRun) {
      consola.info('Dry run mode - not executing registration')
      return { success: true }
    }

    const facetAddressHex = tronAddressToHex(tronWeb, facetAddress)

    // Check each selector and group by action needed
    const selectorsToAdd = []
    const selectorsToReplace = []
    let alreadyRegisteredCount = 0

    for (const selector of selectors)
      try {
        const currentFacetAddressRaw = await diamond
          .facetAddress(selector)
          .call()
        const currentFacetAddress = String(currentFacetAddressRaw)

        const isZeroAddress =
          !currentFacetAddress ||
          currentFacetAddress === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' ||
          currentFacetAddress ===
            '0x0000000000000000000000000000000000000000' ||
          currentFacetAddress === TRON_ZERO_ADDRESS ||
          currentFacetAddress === ZERO_ADDRESS

        if (isZeroAddress) selectorsToAdd.push(selector)
        else {
          const currentHex = tronWeb.address
            .toHex(currentFacetAddress)
            .toLowerCase()
          const targetHex = tronWeb.address.toHex(facetAddress).toLowerCase()

          if (currentHex === targetHex) alreadyRegisteredCount++
          else {
            selectorsToReplace.push(selector)
            consola.debug(
              `Selector ${selector} currently on ${currentFacetAddress}, will replace with ${facetAddress}`
            )
          }
        }
      } catch (error) {
        consola.debug(
          `Could not check selector ${selector}, assuming ADD needed`
        )
        selectorsToAdd.push(selector)
      }

    // Build facetCuts array based on what's needed
    const facetCuts = []

    if (selectorsToAdd.length > 0) {
      facetCuts.push([facetAddressHex, 0, selectorsToAdd]) // 0 = Add
      consola.info(`Will ADD ${selectorsToAdd.length} new selectors`)
    }

    if (selectorsToReplace.length > 0) {
      facetCuts.push([facetAddressHex, 1, selectorsToReplace]) // 1 = Replace
      consola.info(
        `Will REPLACE ${selectorsToReplace.length} existing selectors`
      )
    }

    if (alreadyRegisteredCount > 0)
      consola.info(
        `${alreadyRegisteredCount} selectors already registered to this facet`
      )

    // If nothing to do, exit early
    if (facetCuts.length === 0) {
      consola.success(`${facetName} is already fully registered!`)
      return { success: true }
    }

    // Estimate energy
    const estimatedEnergy = await estimateDiamondCutEnergy(
      tronWeb,
      diamondAddress,
      facetCuts,
      fullHost
    )
    // Get current energy price from the network
    const { energyPrice } = await getCurrentPrices(tronWeb)
    const estimatedCost = estimatedEnergy * energyPrice
    consola.info(`Estimated registration cost: ${estimatedCost.toFixed(4)} TRX`)

    // Check balance
    const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
    const balanceTRX = balance / 1000000
    if (balanceTRX < MIN_BALANCE_REGISTRATION)
      throw new Error(
        `Insufficient balance. Have: ${balanceTRX} TRX, Need: at least ${MIN_BALANCE_REGISTRATION} TRX`
      )

    // Execute diamondCut
    consola.info(`Executing diamondCut...`)
    const feeLimitInSun = DEFAULT_FEE_LIMIT_TRX * 1000000 // Convert to SUN

    const tx = await diamond.diamondCut(facetCuts, ZERO_ADDRESS, '0x').send({
      feeLimit: feeLimitInSun,
      shouldPollResponse: true,
    })

    consola.success(`Registration transaction successful: ${tx}`)

    // Verify registration
    const verified = await verifyFacetRegistration(
      diamond,
      facetAddress,
      facetName,
      tronWeb
    )
    if (!verified)
      throw new Error(
        `${facetName} not found in registered facets after registration`
      )

    // Update diamond.json
    await updateDiamondJson(facetAddress, facetName, undefined, network)

    return { success: true, transactionId: tx }
  } catch (error: any) {
    consola.error(`Registration failed:`, error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Verify facet registration after diamondCut
 */
export async function verifyFacetRegistration(
  diamond: any,
  facetAddress: string,
  facetName: string,
  tronWeb: any
): Promise<boolean> {
  consola.info('Verifying registration...')

  const facetsResponse = await diamond.facets().call()
  const facets = Array.isArray(facetsResponse[0])
    ? facetsResponse[0]
    : facetsResponse

  for (const facet of facets) {
    const facetBase58 = tryTronFacetLoupeAddressToBase58(tronWeb, facet[0])
    if (facetBase58 === facetAddress) {
      consola.success(
        `${facetName} registered successfully with ${facet[1].length} functions`
      )
      return true
    }
  }

  return false
}

/**
 * Validate network balance before deployment
 */
export async function validateBalance(
  tronWeb: any,
  requiredTrx: number,
  operation = 'deployment'
): Promise<void> {
  const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
  const balanceTrx = tronWeb.fromSun(balance)

  if (balanceTrx < requiredTrx)
    throw new Error(
      `Insufficient balance for ${operation}: ${balanceTrx} TRX available, ${requiredTrx} TRX required`
    )

  if (balanceTrx < MIN_BALANCE_WARNING)
    consola.warn(`Low balance detected: ${balanceTrx} TRX`)
}

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

  await sleep(INITIAL_CALL_DELAY)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      consola.warn(
        `Rate limit (429). Retrying in ${
          RETRY_DELAY / 1000
        }s... (attempt ${attempt}/${MAX_RETRIES})`
      )
      await sleep(RETRY_DELAY)
    }
    try {
      return await spawnAndCapture('bun', args)
    } catch (error: unknown) {
      const shouldRetry = isRateLimitError(error) && attempt < MAX_RETRIES
      if (!shouldRetry) throw error
    }
  }

  throw new Error('Max retries exceeded')
}

/**
 * Get Tron wallet address from globalConfig.tronWallets, falling back to EVM format if Tron version doesn't exist
 */
export function getTronWallet(
  globalConfig: Record<string, unknown>,
  walletName: string
): string {
  const tronConfig = globalConfig.tronWallets as
    | Record<string, unknown>
    | undefined
  const tronValue = tronConfig?.[walletName]
  const fallbackValue = globalConfig[walletName]

  if (typeof tronValue === 'string') return tronValue
  if (typeof fallbackValue === 'string') return fallbackValue

  throw new Error(`Wallet '${walletName}' not found in config`)
}

/**
 * Convert address to Tron format if it's in EVM format (0x...)
 */
export function ensureTronAddress(address: string, tronWeb: TronWeb): string {
  if (address.startsWith('0x')) {
    return evmHexToTronBase58(tronWeb, address)
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
  return selector.startsWith('0x')
    ? (selector as Hex)
    : (`0x${selector}` as Hex)
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY)
    try {
      const result = await tronWeb.transactionBuilder.triggerConstantContract(
        contractAddress,
        functionSignature,
        {},
        params,
        tronWeb.defaultAddress?.base58 || tronWeb.defaultAddress?.hex || ''
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
    } catch (error: unknown) {
      const shouldRetry = isRateLimitError(error) && attempt < MAX_RETRIES
      if (!shouldRetry) throw error
    }
  }

  throw new Error('Max retries exceeded')
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
      const expectedOwnerHex = tronAddressToHex(tronWeb, expectedOwnerTron)
      const actualOwnerHex = tronAddressToHex(tronWeb, ownerAddress)

      if (actualOwnerHex !== expectedOwnerHex) {
        logError(
          `${name} owner is ${ownerAddress}, expected ${expectedOwnerTron}`
        )
      } else {
        consola.success(`${name} owner is correct`)
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logError(`Failed to check ${name} ownership: ${errorMessage}`)
    }
  }
}
