import { randomBytes } from 'crypto'
import { readFile } from 'fs/promises'

import { consola } from 'consola'
import { config } from 'dotenv'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  getContract,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import acrossV4SwapConfig from '../../config/acrossV4Swap.json'
import networks from '../../config/networks.json'
import arbitrumProductionDeployments from '../../deployments/arbitrum.json'
import arbitrumStagingDeployments from '../../deployments/arbitrum.staging.json'
import acrossV4SwapFacetArtifact from '../../out/AcrossV4SwapFacet.sol/AcrossV4SwapFacet.json'
import { EnvironmentEnum, type SupportedChain } from '../common/types'

import {
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_OPT,
  ADDRESS_WETH_ARB,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getConfigElement,
  setupEnvironment,
} from './utils/demoScriptHelpers'

// Import deployment files for FeeCollector addresses

config()

// ==========================================================================================================
// CLI FLAGS
// ==========================================================================================================
// --collect-fee: Enable fee collection via FeeCollector before bridging
const COLLECT_FEE = process.argv.includes('--collect-fee')
// --print-calldata: Print diamond calldata and exit without sending
const PRINT_CALLDATA = process.argv.includes('--print-calldata')
// --help: Print usage
const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h')

type Mode =
  | 'spokePool'
  | 'spokePoolPeriphery'
  | 'sponsoredOft'
  | 'sponsoredCctp'

const parseArgValue = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

const parseBigIntArg = (flag: string): bigint | undefined => {
  const v = parseArgValue(flag)
  if (!v) return undefined
  if (!/^\d+$/.test(v)) throw new Error(`Invalid ${flag} value: '${v}'`)
  return BigInt(v)
}

const assertHex = (value: string, label: string): `0x${string}` => {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`Invalid ${label}`)
  return value as `0x${string}`
}

const stripSelector = (calldata: `0x${string}`): `0x${string}` => {
  // 4 bytes selector = 8 hex chars, plus "0x" => slice 10
  if (calldata.length < 10)
    throw new Error('Calldata too short to have selector')
  return `0x${calldata.slice(10)}` as `0x${string}`
}

const parseMode = (): Mode => {
  const raw = (parseArgValue('--mode') ?? 'spokePoolPeriphery').trim()
  if (
    raw === 'spokePool' ||
    raw === 'spokePoolPeriphery' ||
    raw === 'sponsoredOft' ||
    raw === 'sponsoredCctp'
  )
    return raw
  throw new Error(
    `Invalid --mode '${raw}'. Expected one of: spokePool | spokePoolPeriphery | sponsoredOft | sponsoredCctp`
  )
}

const MODE: Mode = SHOW_HELP ? 'spokePoolPeriphery' : parseMode()

// FeeCollector ABI for encoding collectTokenFees call
const FEE_COLLECTOR_ABI = parseAbi([
  'function collectTokenFees(address tokenAddress, uint256 integratorFee, uint256 lifiFee, address integratorAddress)',
])

// ==========================================================================================================
// ACROSS V4 SWAP FACET DEMO SCRIPT
// ==========================================================================================================
// How to run (examples):
// - SpokePoolPeriphery (Across Swap API swapAndBridge):
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePoolPeriphery`
// - SpokePool (Across Swap API deposit):
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePool`
// - Sponsored OFT (quote+sig required):
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode sponsoredOft --quoteJson ./quote.json --signatureHex 0x... --sendingAssetId 0x... [--msgValueWei 0]`
// - Sponsored CCTP (quote+sig required):
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode sponsoredCctp --quoteJson ./quote.json --signatureHex 0x...`
// - Dry-run (prints calldata only):
//   add `--print-calldata`
//
// Important:
// - The facet expects `AcrossV4SwapFacetData.callData` WITHOUT the function selector.
// - Destination calls must be disabled (`BridgeData.hasDestinationCall = false`).
// ==========================================================================================================

/// TYPES

interface IBridgeData {
  transactionId: Hex
  bridge: string
  integrator: string
  referrer: Address
  sendingAssetId: Address
  receiver: Address
  minAmount: bigint
  destinationChainId: number
  hasSourceSwaps: boolean
  hasDestinationCall: boolean
}

interface ISwapData {
  callTo: Address
  approveTo: Address
  sendingAssetId: Address
  receivingAssetId: Address
  fromAmount: bigint
  callData: Hex
  requiresDeposit: boolean
}

interface IAcrossV4SwapFacetData {
  swapApiTarget: 0 | 1 | 2 | 3
  callData: Hex
}

// Actual API response structure (based on empirical testing)
interface IAcrossSwapApiResponse {
  crossSwapType:
    | 'bridgeableToAny'
    | 'anyToBridgeable'
    | 'anyToAny'
    | 'bridgeableToBridgeable'
  amountType: string
  steps: {
    originSwap?: {
      inputAmount: string
      expectedOutputAmount: string
      minOutputAmount: string
      tokenIn: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      tokenOut: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      provider: string
      swapTxn: {
        to: string
        data: string
        value: string
      }
    }
    bridge: {
      inputAmount: string
      outputAmount: string
      tokenIn: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      tokenOut: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      fees: {
        amount: string
        pct: string
      }
      provider: string
    }
    destinationSwap?: unknown
  }
  inputToken: {
    address: string
    symbol: string
    decimals: number
    chainId: number
  }
  outputToken: {
    address: string
    symbol: string
    decimals: number
    chainId: number
  }
  fees: {
    total: { amount: string; pct: string }
  }
  depositTxn?: {
    to: string
    data: string
    value: string
  }
  swapTxn?: {
    to: string
    data: string
    value: string
  }
  // These are used when there's an origin swap (swapAndBridge call to periphery)
  swapTx?: {
    to: string
    data: string
    value: string
  }
}

interface IAcrossSwapApiRequest {
  originChainId: number
  destinationChainId: number
  inputToken: string
  outputToken: string
  amount: string
  recipient: string
  depositor: string // Should be the contract calling SpokePoolPeriphery (e.g., LiFi Diamond)
  refundAddress?: string
  refundOnOrigin?: boolean
  slippageTolerance?: number // e.g., 1 for 1%
  skipOriginTxEstimation?: boolean // Skip simulation - required when depositor is a contract
}

/// HELPER FUNCTIONS
const logDebug = (msg: string) => {
  consola.debug(msg)
}

/**
 * Fetches a swap quote from the Across Swap API
 * This API provides ready-to-execute router calldata for the SpokePoolPeriphery
 */
const getAcrossSwapQuote = async (
  request: IAcrossSwapApiRequest
): Promise<IAcrossSwapApiResponse> => {
  const baseUrl = 'https://app.across.to/api/swap/approval'

  const params = new URLSearchParams({
    originChainId: request.originChainId.toString(),
    destinationChainId: request.destinationChainId.toString(),
    inputToken: request.inputToken,
    outputToken: request.outputToken,
    amount: request.amount,
    recipient: request.recipient,
    depositor: request.depositor,
    refundOnOrigin: (request.refundOnOrigin ?? true).toString(),
    slippageTolerance: (request.slippageTolerance || 1).toString(), // 1 for 1%
    // Skip origin tx estimation since the depositor (Diamond) won't have tokens at quote time
    skipOriginTxEstimation: (request.skipOriginTxEstimation ?? true).toString(),
  })

  if (request.refundAddress) {
    params.append('refundAddress', request.refundAddress)
  }

  const fullUrl = `${baseUrl}?${params.toString()}`
  consola.info(`  API URL: ${fullUrl}`)

  const response = await fetch(fullUrl)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Across Swap API error (${response.status}): ${errorText}`)
  }

  const data: IAcrossSwapApiResponse = await response.json()
  logDebug(`Across Swap API response: ${JSON.stringify(data, null, 2)}`)

  return data
}

// ABI for decoding SpokePoolPeriphery.swapAndBridge calldata
const swapAndBridgeAbi = parseAbi([
  'function swapAndBridge((( uint256 amount, address recipient) submissionFees, (address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce) swapAndDepositData)',
])

// ABI parameter definitions for sponsored quote callData:
// The facet expects `callData` = abi.encode(quote, signature) (no selector).
const SPONSORED_OFT_QUOTE_PARAM = {
  type: 'tuple',
  components: [
    {
      name: 'signedParams',
      type: 'tuple',
      components: [
        { name: 'srcEid', type: 'uint32' },
        { name: 'dstEid', type: 'uint32' },
        { name: 'destinationHandler', type: 'bytes32' },
        { name: 'amountLD', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
        { name: 'maxBpsToSponsor', type: 'uint256' },
        { name: 'finalRecipient', type: 'bytes32' },
        { name: 'finalToken', type: 'bytes32' },
        { name: 'lzReceiveGasLimit', type: 'uint256' },
        { name: 'lzComposeGasLimit', type: 'uint256' },
        { name: 'executionMode', type: 'uint8' },
        { name: 'actionData', type: 'bytes' },
      ],
    },
    {
      name: 'unsignedParams',
      type: 'tuple',
      components: [
        { name: 'refundRecipient', type: 'address' },
        { name: 'maxUserSlippageBps', type: 'uint256' },
      ],
    },
  ],
} as const

const SPONSORED_CCTP_QUOTE_PARAM = {
  type: 'tuple',
  components: [
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'burnToken', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'maxBpsToSponsor', type: 'uint256' },
    { name: 'maxUserSlippageBps', type: 'uint256' },
    { name: 'finalRecipient', type: 'bytes32' },
    { name: 'finalToken', type: 'bytes32' },
    { name: 'executionMode', type: 'uint8' },
    { name: 'actionData', type: 'bytes' },
  ],
} as const

const bytes32ToEvmAddress = (b32: `0x${string}`): `0x${string}` => {
  // bytes32(uint256(uint160(addr))) => addr in last 20 bytes
  if (b32.length !== 66) throw new Error('Invalid bytes32 length')
  return getAddress(`0x${b32.slice(26)}`) as `0x${string}`
}

const chainIdToCctpDomainId = (chainId: number): number => {
  // Must mirror `AcrossV4SwapFacet._chainIdToCctpDomainId`
  switch (chainId) {
    case 1:
      return 0
    case 43114:
      return 1
    case 10:
      return 2
    case 42161:
      return 3
    case 8453:
      return 6
    case 137:
      return 7
    case 130:
      return 10
    case 59144:
      return 11
    case 81224:
      return 12
    case 146:
      return 13
    case 480:
      return 14
    case 1329:
      return 16
    case 50:
      return 18
    case 999:
    case 1337:
      return 19
    case 57073:
      return 21
    case 98866:
      return 22
    default:
      throw new Error(
        `Unsupported destinationChainId for sponsoredCctp: ${chainId}`
      )
  }
}

/**
 * Decodes the swapAndBridge calldata to extract swap parameters
 */
const decodeSwapAndBridgeCalldata = (
  calldata: string
): {
  swapToken: string
  exchange: string
  transferType: number
  routerCalldata: string
  minExpectedInputTokenAmount: string
  depositData: {
    inputToken: string
    outputToken: string
    outputAmount: string
    depositor: string
    recipient: string
    destinationChainId: bigint
    exclusiveRelayer: string
    quoteTimestamp: number
    fillDeadline: number
    exclusivityParameter: number
    message: string
  }
} => {
  // The calldata is for SpokePoolPeriphery.swapAndBridge(SwapAndDepositData)
  const decoded = decodeFunctionData({
    abi: swapAndBridgeAbi,
    data: calldata as `0x${string}`,
  })

  if (!decoded.args) {
    throw new Error('Failed to decode swapAndBridge calldata')
  }

  const swapData = decoded.args[0] as unknown as {
    swapToken: string
    exchange: string
    transferType: number
    routerCalldata: string
    minExpectedInputTokenAmount: bigint
    depositData: {
      inputToken: string
      outputToken: string
      outputAmount: bigint
      depositor: string
      recipient: string
      destinationChainId: bigint
      exclusiveRelayer: string
      quoteTimestamp: number
      fillDeadline: number
      exclusivityParameter: number
      message: string
    }
  }

  return {
    swapToken: swapData.swapToken,
    exchange: swapData.exchange,
    transferType: swapData.transferType,
    routerCalldata: swapData.routerCalldata,
    minExpectedInputTokenAmount:
      swapData.minExpectedInputTokenAmount.toString(),
    depositData: {
      inputToken: swapData.depositData.inputToken,
      outputToken: swapData.depositData.outputToken,
      outputAmount: swapData.depositData.outputAmount.toString(),
      depositor: swapData.depositData.depositor,
      recipient: swapData.depositData.recipient,
      destinationChainId: swapData.depositData.destinationChainId,
      exclusiveRelayer: swapData.depositData.exclusiveRelayer,
      quoteTimestamp: swapData.depositData.quoteTimestamp,
      fillDeadline: swapData.depositData.fillDeadline,
      exclusivityParameter: swapData.depositData.exclusivityParameter,
      message: swapData.depositData.message,
    },
  }
}

// ########################################## CONFIGURE SCRIPT HERE ##########################################
// Chain configuration - use SupportedChain type from helpers
const SRC_CHAIN: SupportedChain = 'arbitrum'
const DST_CHAIN: SupportedChain = 'optimism'

// Get chain IDs from networks config
const fromChainId = networks[SRC_CHAIN].chainId
const toChainId = networks[DST_CHAIN].chainId

const MODE_DEFAULTS: Record<
  Mode,
  {
    inputToken?: string
    outputToken?: string
    fromAmount?: bigint
    amountDecimals?: number
    swapApiTarget: 0 | 1 | 2 | 3
    configKey:
      | 'spokePool'
      | 'spokePoolPeriphery'
      | 'sponsoredOftSrcPeriphery'
      | 'sponsoredCctpSrcPeriphery'
  }
> = {
  // Across Swap API -> SpokePoolPeriphery.swapAndBridge(SwapAndDepositData)
  spokePoolPeriphery: {
    inputToken: ADDRESS_WETH_ARB,
    outputToken: ADDRESS_USDC_OPT,
    fromAmount: 300000000000000n, // 0.0003 WETH
    amountDecimals: 18,
    swapApiTarget: 1,
    configKey: 'spokePoolPeriphery',
  },
  // Across Swap API -> SpokePool.deposit(...)
  spokePool: {
    inputToken: ADDRESS_USDC_ARB,
    outputToken: ADDRESS_USDC_OPT,
    fromAmount: 6000000n, // 6 USDC (6 decimals)
    amountDecimals: 6,
    swapApiTarget: 0,
    configKey: 'spokePool',
  },
  // User-supplied quote+signature
  sponsoredOft: {
    swapApiTarget: 2,
    configKey: 'sponsoredOftSrcPeriphery',
  },
  // User-supplied quote+signature
  sponsoredCctp: {
    swapApiTarget: 3,
    configKey: 'sponsoredCctpSrcPeriphery',
  },
}

const INPUT_TOKEN = MODE_DEFAULTS[MODE].inputToken
const OUTPUT_TOKEN = MODE_DEFAULTS[MODE].outputToken
const fromAmount = MODE_DEFAULTS[MODE].fromAmount
const AMOUNT_DECIMALS = MODE_DEFAULTS[MODE].amountDecimals

// Environment: staging or production
const ENVIRONMENT = EnvironmentEnum.staging

// Fee collection configuration (only used when --collect-fee flag is passed)
// Fees are split between integrator and LiFi protocol
const INTEGRATOR_FEE = parseUnits('0.0001', 18) // 0.0001 WETH
const LIFI_FEE = parseUnits('0.00005', 18) // 0.00005 WETH

// Get FeeCollector address based on environment
const getFeeCollectorAddress = (environment: EnvironmentEnum): string => {
  if (environment === EnvironmentEnum.staging) {
    return arbitrumStagingDeployments.FeeCollector
  }
  return arbitrumProductionDeployments.FeeCollector
}

// Get config elements using helper
const SPOKE_POOL_PERIPHERY = getConfigElement(
  acrossV4SwapConfig,
  SRC_CHAIN,
  'spokePoolPeriphery'
)
const SPOKE_POOL = getConfigElement(acrossV4SwapConfig, SRC_CHAIN, 'spokePool')
const SPONSORED_OFT_SRC_PERIPHERY = getConfigElement(
  acrossV4SwapConfig,
  SRC_CHAIN,
  'sponsoredOftSrcPeriphery'
)
const SPONSORED_CCTP_SRC_PERIPHERY = getConfigElement(
  acrossV4SwapConfig,
  SRC_CHAIN,
  'sponsoredCctpSrcPeriphery'
)

// Get explorer URL from networks config
const EXPLORER_BASE_URL = `${networks[SRC_CHAIN].explorerUrl}/tx/`
// ############################################################################################################

async function main() {
  if (SHOW_HELP) {
    console.log(`
AcrossV4SwapFacet demo script

Usage:
  bun run script/demoScripts/demoAcrossV4Swap.ts --mode <spokePool|spokePoolPeriphery|sponsoredOft|sponsoredCctp> [--collect-fee] [--print-calldata]

Sponsored modes (provide one of):
  --callDataHex <0x...>         (selector-less abi.encode(quote, signature))
  --fullCalldataHex <0x...>     (full periphery calldata; selector stripped automatically)
  --quoteJson <path> --signatureHex <0x...>

Sponsored OFT requires:
  --sendingAssetId <0x...>      (ERC20 to approve + deposit into Diamond)
Optional:
  --msgValueWei <wei>           (only for sponsoredOft; payable value forwarded to Across periphery)

Dry-run:
  --print-calldata prints the diamond calldata and exits without sending.
`)
    process.exit(0)
  }

  consola.info('==========================================')
  consola.info('  Across V4 Swap Facet Demo Script')
  consola.info('==========================================\n')

  const ACROSS_V4_SWAP_FACET_ABI = acrossV4SwapFacetArtifact.abi as Abi

  const {
    publicClient,
    walletClient,
    walletAccount,
    lifiDiamondContract,
    lifiDiamondAddress,
  } = await setupEnvironment(SRC_CHAIN, ACROSS_V4_SWAP_FACET_ABI, ENVIRONMENT)

  if (!lifiDiamondContract || !lifiDiamondAddress) {
    throw new Error('Missing Diamond contract/address from setupEnvironment()')
  }

  const walletAddress = getAddress(walletAccount.address)

  const targetConfigKey = MODE_DEFAULTS[MODE].configKey
  const targetAddress =
    targetConfigKey === 'spokePoolPeriphery'
      ? SPOKE_POOL_PERIPHERY
      : targetConfigKey === 'spokePool'
      ? SPOKE_POOL
      : targetConfigKey === 'sponsoredOftSrcPeriphery'
      ? SPONSORED_OFT_SRC_PERIPHERY
      : SPONSORED_CCTP_SRC_PERIPHERY

  consola.info(`Wallet address: ${walletAddress}`)
  consola.info(`Diamond address: ${lifiDiamondAddress}`)
  consola.info(`Mode: ${MODE}`)
  consola.info(
    `Target contract from config (${targetConfigKey}): ${targetAddress}`
  )
  consola.info('')

  consola.info('Route Details:')
  consola.info(`  Source Chain: ${SRC_CHAIN} (Chain ID: ${fromChainId})`)
  consola.info(`  Destination Chain: ${DST_CHAIN} (Chain ID: ${toChainId})`)
  if (MODE === 'spokePool' || MODE === 'spokePoolPeriphery') {
    consola.info(`  Input Token: ${INPUT_TOKEN}`)
    consola.info(`  Output Token: ${OUTPUT_TOKEN}`)
    consola.info(
      `  Amount: ${formatUnits(
        fromAmount as bigint,
        AMOUNT_DECIMALS as number
      )}`
    )
  } else {
    consola.info('  Input/Output/Amount: derived from supplied sponsored quote')
  }
  consola.info('')

  // ============================================================================================
  // Build AcrossV4SwapFacetData.callData for selected mode
  // ============================================================================================
  let callDataNoSelector: Hex
  let bridgeDataSendingAssetId: Address
  let bridgeDataMinAmount: bigint
  let msgValueWei = 0n

  if (MODE === 'spokePoolPeriphery' || MODE === 'spokePool') {
    if (!INPUT_TOKEN || !OUTPUT_TOKEN || fromAmount === undefined) {
      throw new Error(
        'Missing mode defaults (inputToken/outputToken/fromAmount)'
      )
    }

    consola.info('Step 1: Fetching quote from Across Swap API...')

    const swapApiRequest: IAcrossSwapApiRequest = {
      originChainId: fromChainId,
      destinationChainId: toChainId,
      inputToken: INPUT_TOKEN,
      outputToken: OUTPUT_TOKEN,
      amount: fromAmount.toString(),
      recipient: walletAddress,
      depositor: walletAddress,
      refundAddress: walletAddress,
      refundOnOrigin: true,
      slippageTolerance: 1,
      skipOriginTxEstimation: true,
    }

    const swapQuote = await getAcrossSwapQuote(swapApiRequest)
    consola.info('Quote received!')
    consola.info(`  Cross Swap Type: ${swapQuote.crossSwapType}`)
    consola.info('')

    if (MODE === 'spokePoolPeriphery') {
      const swapTx = swapQuote.swapTx
      if (!swapTx)
        throw new Error(
          'Across Swap API did not return swapTx (expected for spokePoolPeriphery mode)'
        )

      consola.info('Step 2: Decoding swapAndBridge calldata...')
      const decoded = decodeSwapAndBridgeCalldata(swapTx.data)
      consola.info(`  swapTx.to: ${swapTx.to}`)
      consola.info(`  swapToken: ${decoded.swapToken}`)
      consola.info(`  exchange: ${decoded.exchange}`)
      consola.info(`  outputAmount: ${decoded.depositData.outputAmount}`)
      consola.info('')

      callDataNoSelector = stripSelector(assertHex(swapTx.data, 'swapTx.data'))
    } else {
      const depositTxn = swapQuote.depositTxn
      if (!depositTxn)
        throw new Error(
          'Across Swap API did not return depositTxn (expected for spokePool mode)'
        )

      consola.info(`Step 2: Using depositTxn.to: ${depositTxn.to}`)
      consola.info('')

      callDataNoSelector = stripSelector(
        assertHex(depositTxn.data, 'depositTxn.data')
      )
    }

    bridgeDataSendingAssetId = getAddress(INPUT_TOKEN)
    bridgeDataMinAmount = fromAmount
    msgValueWei = 0n
  } else if (MODE === 'sponsoredOft') {
    const callDataHexArg = parseArgValue('--callDataHex')
    const fullCalldataHexArg = parseArgValue('--fullCalldataHex')
    const quoteJsonPath = parseArgValue('--quoteJson')
    const signatureHex = parseArgValue('--signatureHex')
    const sendingAssetIdArg = parseArgValue('--sendingAssetId')
    const msgValueWeiArg = parseBigIntArg('--msgValueWei') ?? 0n

    if (!sendingAssetIdArg) {
      throw new Error(
        'Missing --sendingAssetId for sponsoredOft (required for safe approvals)'
      )
    }

    if (fullCalldataHexArg) {
      callDataNoSelector = stripSelector(
        assertHex(fullCalldataHexArg, '--fullCalldataHex')
      )
    } else if (callDataHexArg) {
      callDataNoSelector = assertHex(callDataHexArg, '--callDataHex')
    } else {
      if (!quoteJsonPath || !signatureHex) {
        throw new Error(
          'sponsoredOft requires --callDataHex OR (--quoteJson and --signatureHex) OR --fullCalldataHex'
        )
      }
      const quoteJsonRaw = await readFile(quoteJsonPath, 'utf8')
      const quote = JSON.parse(quoteJsonRaw)
      const sig = assertHex(signatureHex, '--signatureHex')
      callDataNoSelector = encodeAbiParameters(
        [SPONSORED_OFT_QUOTE_PARAM, { type: 'bytes' }],
        [quote, sig]
      )
    }

    const [quoteDecoded] = decodeAbiParameters(
      [SPONSORED_OFT_QUOTE_PARAM, { type: 'bytes' }],
      callDataNoSelector
    )

    const sponsoredOftQuote = quoteDecoded as {
      signedParams: { amountLD: bigint; finalRecipient: Hex }
    }

    const amountLD = sponsoredOftQuote.signedParams.amountLD
    const finalRecipient = sponsoredOftQuote.signedParams.finalRecipient
    const finalRecipientAddr = bytes32ToEvmAddress(finalRecipient)
    if (finalRecipientAddr !== getAddress(walletAddress)) {
      throw new Error(
        `sponsoredOft finalRecipient mismatch. Quote.finalRecipient=${finalRecipientAddr} wallet=${walletAddress}`
      )
    }

    bridgeDataSendingAssetId = getAddress(sendingAssetIdArg)
    bridgeDataMinAmount = amountLD
    msgValueWei = msgValueWeiArg
  } else {
    // sponsoredCctp
    const callDataHexArg = parseArgValue('--callDataHex')
    const fullCalldataHexArg = parseArgValue('--fullCalldataHex')
    const quoteJsonPath = parseArgValue('--quoteJson')
    const signatureHex = parseArgValue('--signatureHex')

    if (fullCalldataHexArg) {
      callDataNoSelector = stripSelector(
        assertHex(fullCalldataHexArg, '--fullCalldataHex')
      )
    } else if (callDataHexArg) {
      callDataNoSelector = assertHex(callDataHexArg, '--callDataHex')
    } else {
      if (!quoteJsonPath || !signatureHex) {
        throw new Error(
          'sponsoredCctp requires --callDataHex OR (--quoteJson and --signatureHex) OR --fullCalldataHex'
        )
      }
      const quoteJsonRaw = await readFile(quoteJsonPath, 'utf8')
      const quote = JSON.parse(quoteJsonRaw)
      const sig = assertHex(signatureHex, '--signatureHex')
      callDataNoSelector = encodeAbiParameters(
        [SPONSORED_CCTP_QUOTE_PARAM, { type: 'bytes' }],
        [quote, sig]
      )
    }

    const [quoteDecoded] = decodeAbiParameters(
      [SPONSORED_CCTP_QUOTE_PARAM, { type: 'bytes' }],
      callDataNoSelector
    )

    const sponsoredCctpQuote = quoteDecoded as {
      amount: bigint
      burnToken: Hex
      destinationDomain: number
      finalRecipient: Hex
    }

    const amount = sponsoredCctpQuote.amount
    const burnTokenBytes32 = sponsoredCctpQuote.burnToken
    const destinationDomain = sponsoredCctpQuote.destinationDomain
    const finalRecipient = sponsoredCctpQuote.finalRecipient
    const finalRecipientAddr = bytes32ToEvmAddress(finalRecipient)

    if (finalRecipientAddr !== getAddress(walletAddress)) {
      throw new Error(
        `sponsoredCctp finalRecipient mismatch. Quote.finalRecipient=${finalRecipientAddr} wallet=${walletAddress}`
      )
    }

    const expectedDomain = chainIdToCctpDomainId(toChainId)
    if (destinationDomain !== expectedDomain) {
      throw new Error(
        `sponsoredCctp destinationDomain mismatch. Quote.destinationDomain=${destinationDomain} expected=${expectedDomain} (from destinationChainId=${toChainId})`
      )
    }

    bridgeDataSendingAssetId = bytes32ToEvmAddress(burnTokenBytes32)
    bridgeDataMinAmount = amount
    msgValueWei = 0n // facet enforces 0
  }

  const transactionId = `0x${randomBytes(32).toString('hex')}` as `0x${string}`
  const bridgeData: IBridgeData = {
    transactionId,
    bridge: 'acrossV4Swap',
    integrator: 'lifi-demoScript',
    referrer: zeroAddress,
    sendingAssetId: getAddress(bridgeDataSendingAssetId),
    receiver: walletAddress,
    minAmount: bridgeDataMinAmount,
    destinationChainId: toChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const acrossV4SwapFacetData: IAcrossV4SwapFacetData = {
    swapApiTarget: MODE_DEFAULTS[MODE].swapApiTarget,
    callData: callDataNoSelector,
  }

  // Fee collection is only safe for the default WETH flow in this demo (fees configured in 18 decimals).
  if (
    COLLECT_FEE &&
    bridgeData.sendingAssetId.toLowerCase() !== ADDRESS_WETH_ARB.toLowerCase()
  ) {
    throw new Error(
      `--collect-fee is only supported in this demo when sendingAssetId is WETH (${ADDRESS_WETH_ARB}).`
    )
  }

  const totalFees = COLLECT_FEE ? INTEGRATOR_FEE + LIFI_FEE : 0n
  const totalAmount = bridgeData.minAmount + totalFees

  const feeCollectorAddress = getAddress(getFeeCollectorAddress(ENVIRONMENT))

  let feeCollectionSwapData: ISwapData | undefined
  if (COLLECT_FEE) {
    feeCollectionSwapData = {
      callTo: feeCollectorAddress,
      approveTo: feeCollectorAddress,
      sendingAssetId: bridgeData.sendingAssetId,
      receivingAssetId: bridgeData.sendingAssetId,
      fromAmount: totalAmount,
      callData: encodeFunctionData({
        abi: FEE_COLLECTOR_ABI,
        functionName: 'collectTokenFees',
        args: [
          bridgeData.sendingAssetId,
          INTEGRATOR_FEE,
          LIFI_FEE,
          walletAddress,
        ],
      }),
      requiresDeposit: true,
    }
  }

  const bridgeDataWithSwap: IBridgeData = {
    ...bridgeData,
    hasSourceSwaps: COLLECT_FEE,
  }

  const diamondCallData = COLLECT_FEE
    ? encodeFunctionData({
        abi: ACROSS_V4_SWAP_FACET_ABI,
        functionName: 'swapAndStartBridgeTokensViaAcrossV4Swap',
        args: [
          bridgeDataWithSwap,
          [feeCollectionSwapData],
          acrossV4SwapFacetData,
        ],
      })
    : encodeFunctionData({
        abi: ACROSS_V4_SWAP_FACET_ABI,
        functionName: 'startBridgeTokensViaAcrossV4Swap',
        args: [bridgeData, acrossV4SwapFacetData],
      })

  consola.info('==========================================')
  consola.info('  Prepared Call')
  consola.info('==========================================')
  consola.info(`sendingAssetId:     ${bridgeData.sendingAssetId}`)
  consola.info(`minAmount:          ${bridgeData.minAmount.toString()}`)
  consola.info(`receiver:           ${bridgeData.receiver}`)
  consola.info(`destinationChainId: ${bridgeData.destinationChainId}`)
  consola.info(`swapApiTarget:      ${acrossV4SwapFacetData.swapApiTarget}`)
  consola.info(
    `callDataBytes:      ${(acrossV4SwapFacetData.callData.length - 2) / 2}`
  )
  consola.info('')
  consola.info('Requirements:')
  consola.info(`  Approval token:    ${bridgeData.sendingAssetId}`)
  consola.info(`  Approval spender:  ${lifiDiamondAddress}`)
  consola.info(`  Approval amount:   ${totalAmount.toString()}`)
  consola.info(`  msg.value:         ${msgValueWei.toString()}`)
  consola.info('==========================================\n')

  if (PRINT_CALLDATA) {
    consola.info('--- print-calldata ---')
    consola.info(`to: ${lifiDiamondAddress}`)
    consola.info(`data: ${diamondCallData}`)
    consola.info(`value: ${msgValueWei.toString()}`)
    consola.info('----------------------\n')
    return
  }

  // Balance + allowance (ERC20 only for these demo paths)
  consola.info('Checking balance and allowance...')
  const tokenContract = getContract({
    address: bridgeData.sendingAssetId as `0x${string}`,
    abi: erc20Abi,
    client: { public: publicClient, wallet: walletClient },
  })

  await ensureBalance(tokenContract, walletAddress, totalAmount, publicClient)
  await ensureAllowance(
    tokenContract,
    walletAddress,
    lifiDiamondAddress as string,
    totalAmount,
    publicClient
  )

  consola.info('Executing transaction...')
  const typedDiamond = lifiDiamondContract as unknown as {
    write: {
      swapAndStartBridgeTokensViaAcrossV4Swap: (
        args: readonly [
          IBridgeData,
          readonly ISwapData[],
          IAcrossV4SwapFacetData
        ],
        options: { value: bigint }
      ) => Promise<Hex>
      startBridgeTokensViaAcrossV4Swap: (
        args: readonly [IBridgeData, IAcrossV4SwapFacetData],
        options: { value: bigint }
      ) => Promise<Hex>
    }
  }

  let txHash: string | null = null

  if (COLLECT_FEE) {
    if (!feeCollectionSwapData) {
      throw new Error(
        'Fee collection enabled but feeCollectionSwapData missing'
      )
    }
    txHash = await executeTransaction(
      () =>
        typedDiamond.write.swapAndStartBridgeTokensViaAcrossV4Swap(
          [bridgeDataWithSwap, [feeCollectionSwapData], acrossV4SwapFacetData],
          { value: msgValueWei }
        ),
      'Starting bridge with fee collection via AcrossV4Swap',
      publicClient,
      true
    )
  } else {
    txHash = await executeTransaction(
      () =>
        typedDiamond.write.startBridgeTokensViaAcrossV4Swap(
          [bridgeData, acrossV4SwapFacetData],
          { value: msgValueWei }
        ),
      'Starting bridge tokens via AcrossV4Swap',
      publicClient,
      true
    )
  }

  consola.info('\n==========================================')
  consola.info('  TRANSACTION SUCCESSFUL!')
  consola.info('==========================================')
  consola.info(`Explorer: ${EXPLORER_BASE_URL}${txHash}\n`)
}

main()
  .then(() => {
    consola.info('Script completed successfully')
    process.exit(0)
  })
  .catch((error) => {
    consola.error('Script failed:', error)
    process.exit(1)
  })
