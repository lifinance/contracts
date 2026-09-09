/**
 * Tron-specific deployment utilities: deployment recording,
 * health-check helpers (ownership, facet/whitelist verification), and on-chain cost helpers.
 * Generic deployment utilities (file I/O, environment, selectors) live in `../../utils/utils.ts`.
 */

import {
  DEFAULT_SAFETY_MARGIN,
  MIN_BALANCE_WARNING,
  createTronWebReadOnly,
  estimateContractCallEnergy,
  evmHexToTronBase58,
  getTronWebCodecFullHostForNetwork,
  getTronWebCodecOnlyForNetwork,
  loadForgeArtifact,
  tronAddressToHex,
  tryTronFacetLoupeAddressToBase58,
} from '@lifi/tron-devkit'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import { decodeFunctionResult, parseAbi, type Abi, type Hex } from 'viem'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { sleep } from '../../utils/delay'
import { spawnAndCapture } from '../../utils/spawnAndCapture'
import { logDeployment, saveContractAddress } from '../../utils/utils'
import {
  INITIAL_CALL_DELAY,
  MAX_RETRIES,
  RETRY_DELAY,
  ZERO_ADDRESS,
} from '../shared/constants'
import { getContractVersion } from '../shared/getContractVersion'
import { isRateLimitError } from '../shared/rateLimit'

import { assertTronToolchainOrThrow } from './assertTronToolchain'
import {
  assertRecordedArgsMatchAbi,
  constructorInputTypes,
  encodeConstructorArgs as encodeWithTypes,
  type AbiParamEncoder,
} from './constructor-args'

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
      rpcUrl: getTronWebCodecFullHostForNetwork('tron'),
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
    // Ahead of the artifact load so a drifted toolchain is reported as such, rather than as
    // a stale or missing artifact. The same call also guards every deploy site from inside
    // assertTronDeploymentRecordable; it runs the checker once per process either way.
    assertTronToolchainOrThrow()

    const artifact = await loadForgeArtifact(contractName)
    const version = await getContractVersion(contractName)

    consola.info(`Deploying ${contractName} v${version}...`)

    if (constructorArgs.length > 0)
      consola.info(`Constructor arguments:`, constructorArgs)

    assertTronDeploymentRecordable(
      artifact,
      constructorArgs,
      contractName,
      network
    )

    const result = await deployer.deployContract(artifact, constructorArgs)

    consola.success(`${contractName} deployed to: ${result.contractAddress}`)
    consola.info(`Transaction: ${result.transactionId}`)
    consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

    // Log deployment (skip in dry run)
    if (!dryRun) {
      // The address is saved first: the contract is already on chain, and a
      // recording failure that loses its address costs a duplicate deployment.
      await saveContractAddress(network, contractName, result.contractAddress)

      await recordTronDeployment({
        contractName,
        network,
        address: result.contractAddress,
        version,
        artifact,
        constructorArgs,
        verified: false,
      })
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
/** TronWeb's ABI encoder for one network; it accepts base58 addresses, viem's does not. */
const tronAbiEncoder =
  (network: SupportedChain): AbiParamEncoder =>
  (types, values) =>
    getTronWebCodecOnlyForNetwork(network).utils.abi.encodeParams(
      types,
      values as any[]
    )

/**
 * Checks that a deployment will be recordable and that its artifact came from the pinned
 * toolchain, before anything is broadcast.
 *
 * Call this immediately before deploying. Everything it checks is pure — the
 * artifact's ABI and the values — so failing here costs nothing, while the same
 * failure after `deployer.deployContract` leaves a contract on chain that
 * cannot be recorded, and TRX already spent.
 *
 * The toolchain pre-flight lives here because every Tron deploy site calls this immediately
 * before its `deployer.deployContract`, so a new deploy site cannot reach a chain without
 * passing it. It costs one checker run per process, not one per contract.
 *
 * @param artifact - The Forge artifact about to be deployed.
 * @param constructorArgs - Exactly the values the constructor will receive.
 * @param contractName - Named in every message.
 * @param network - Network whose codec will encode the values.
 * @throws When the local forge does not match the pin, the ABI is unreadable, the arity
 * disagrees, or the values cannot be encoded.
 */
export function assertTronDeploymentRecordable(
  artifact: { abi?: unknown },
  constructorArgs: readonly unknown[],
  contractName: string,
  network: SupportedChain
): void {
  assertTronToolchainOrThrow()

  const types = constructorInputTypes(artifact?.abi, contractName)
  const encoded = encodeWithTypes(
    tronAbiEncoder(network),
    constructorArgs,
    types,
    contractName
  )
  assertRecordedArgsMatchAbi(contractName, encoded, types)
}

/**
 * Records a Tron deployment with its constructor arguments encoded from the ABI.
 *
 * Use this rather than calling `logDeployment` directly: it is the only place
 * that decides what the `constructorArgs` field holds, so a call site cannot
 * hand the log a string of its own.
 *
 * @param params.artifact - The Forge artifact the contract was deployed from.
 * @param params.constructorArgs - Exactly the values passed to the constructor.
 * @throws When the arguments cannot be encoded from the ABI. Callers must save
 * the deployed address BEFORE calling this: the contract is already on chain by
 * then, and losing its address costs a duplicate deployment.
 */
export async function recordTronDeployment(params: {
  contractName: string
  network: SupportedChain
  address: string
  version: string
  artifact: { abi?: unknown }
  constructorArgs: readonly unknown[]
  verified: boolean
}): Promise<void> {
  const { contractName, network, address, version, artifact } = params
  // Parsed once: an encode and an assert reading the ABI separately could
  // disagree about what the contract takes.
  const types = constructorInputTypes(artifact?.abi, contractName)
  const encoded = encodeWithTypes(
    tronAbiEncoder(network),
    params.constructorArgs,
    types,
    contractName
  )
  assertRecordedArgsMatchAbi(contractName, encoded, types)

  await logDeployment(
    contractName,
    network,
    address,
    version,
    encoded,
    params.verified
  )
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
    // The margin belongs on the figure the guard compares; the headroom belongs
    // in DIAMOND_CUT_FEE_LIMIT_SUN. Putting a 10x multiplier here too made the
    // guard refuse at a tenth of the true threshold — a 6,000,000-energy cut
    // costs 720 TRX against a 5000 TRX limit and was refused.
    safetyMargin: DEFAULT_SAFETY_MARGIN,
  })
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
  // callTronContract prepends TronWeb's diagnostic lines ("\u2699 Initializing TronWeb...",
  // "\u2699 Calling <fn> on <addr>", ...) to the actual return value, so the address is the
  // LAST meaningful line, not the whole blob. Trimming the blob leaves it starting with the
  // first diagnostic line, which then fails every "is this a T... address" test and reads as
  // an unregistered/absent contract. Take the last non-empty, non-diagnostic line instead.
  const lines = output
    .split('\n')
    .map((line) => line.trim().replace(/^["']|["']$/g, ''))
    .filter((line) => line.length > 0 && !line.startsWith('\u2699'))
  return lines[lines.length - 1] ?? ''
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
 * Parse a troncast array / nested-array return value (e.g. getAllContractSelectorPairs's
 * `address[],bytes4[][]`) into a JS array.
 *
 * `callTronContract` prepends the troncast command echo (`$ bun run …`) and TronWeb's
 * `⚙`-prefixed diagnostic lines to the actual return value — and one of those diagnostics
 * ("⚙ Formatted params: []") itself contains a `[`. So the payload cannot be read by trimming
 * the blob and taking the first bracket: the echo + diagnostic lines must be stripped first
 * (the same assumption `parseTronAddressOutput` fixes for single-address returns), then the
 * bracketed payload that remains is parsed.
 *
 * @throws if no bracketed payload is present after stripping diagnostics.
 */
export function parseTroncastArrayOutput(output: string): unknown[] {
  const payload = output
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('⚙') && // TronWeb diagnostic lines
        !line.startsWith('$') // troncast command echo
    )
    .join(' ')
    .trim()

  const arrayStart = payload.indexOf('[')
  if (arrayStart === -1) throw new Error('Expected array format')

  const [parsed] = parseTroncastNestedArray(payload, arrayStart)
  return parsed
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
