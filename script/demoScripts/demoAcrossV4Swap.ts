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
  getAddress,
  getContract,
  isHex,
  keccak256,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import networks from '../../config/networks.json'
import acrossV4SwapFacetArtifact from '../../out/AcrossV4SwapFacet.sol/AcrossV4SwapFacet.json'
import { EnvironmentEnum, type SupportedChain } from '../common/types'

import {
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_BASE,
  ADDRESS_USDC_ETH,
  ADDRESS_USDC_OPT,
  ADDRESS_USDC_POL,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getEnvVar,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// ==========================================================================================================
// AcrossV4SwapFacet demo script (calldata-focused)
//
// ######### !!!!!!!!!!!!!!!! IMPORTANT INFORMATION !!!!!!!!!!!!!!!! #########
// This script assumes that we get access to the backend STAGING signer private key for testing.
// please add this to your .env with:
// PRIVATE_KEY_BACKEND_SIGNER_STAGING=<private key>
// ######### !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! #########
//
// Goal: demonstrate how to build the Diamond calldata for:
// - swapApiTarget=SpokePool (0)                  -> requires backend EIP-712 signature
// - swapApiTarget=SpokePoolPeriphery (1)         -> requires backend EIP-712 signature
// - swapApiTarget=SponsoredOFTSrcPeriphery (2)   -> NO facet signature (quote is signed)
// - swapApiTarget=SponsoredCCTPSrcPeriphery (3)  -> NO facet signature (quote is signed)
//
// IMPORTANT:
// - AcrossV4SwapFacetData.callData must be without function selector
//
// How to run (examples):
// - Print calldata for SpokePoolPeriphery (target 1, uses PRIVATE_KEY_BACKEND_SIGNER_STAGING by default):
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePoolPeriphery --print-calldata`
// - Print calldata for SpokePool (target 0, uses PRIVATE_KEY_BACKEND_SIGNER_STAGING by default):
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePool --print-calldata`
// - (Optional override) Provide an explicit backend key:
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePoolPeriphery --backendPrivateKey 0x... --print-calldata`
// - Print calldata for Sponsored CCTP (target 3) from quote JSON + signature:
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode sponsoredCctp --quoteJson ./quote.json --signatureHex 0x... --print-calldata`
// - Print calldata for Sponsored OFT (target 2) from quote JSON + signature:
//   `bun run script/demoScripts/demoAcrossV4Swap.ts --mode sponsoredOft --quoteJson ./quote.json --signatureHex 0x... --sendingAssetId 0x... --msgValueWei 0 --print-calldata`
//
// Send transaction (optional, unsafe-by-default):
// - Add `--send` to broadcast instead of only printing calldata.
// ==========================================================================================================

type Mode =
  | 'spokePool'
  | 'spokePoolPeriphery'
  | 'sponsoredOft'
  | 'sponsoredCctp'
type Entrypoint = 'start' | 'swapAndStart'

const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h')
const SEND_TX = process.argv.includes('--send')
const PRINT_CALLDATA = process.argv.includes('--print-calldata') || !SEND_TX

const arg = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

const argBigInt = (flag: string): bigint | undefined => {
  const v = arg(flag)
  if (!v) return undefined
  if (!/^\d+$/.test(v)) throw new Error(`Invalid ${flag} value: '${v}'`)
  return BigInt(v)
}

const assertHex = (value: string, label: string): Hex => {
  if (!isHex(value)) throw new Error(`Invalid ${label}`)
  return value as Hex
}

const stripSelector = (calldata: Hex): Hex => {
  // 4 bytes selector = 8 hex chars, plus "0x" => slice(10)
  if (calldata.length < 10)
    throw new Error('Calldata too short to have selector')
  return `0x${calldata.slice(10)}` as Hex
}

const parseMode = (): Mode => {
  const raw = (arg('--mode') ?? 'spokePoolPeriphery').trim()
  if (
    raw === 'spokePool' ||
    raw === 'spokePoolPeriphery' ||
    raw === 'sponsoredOft' ||
    raw === 'sponsoredCctp'
  )
    return raw
  throw new Error(
    `Invalid --mode '${raw}'. Expected: spokePool | spokePoolPeriphery | sponsoredOft | sponsoredCctp`
  )
}

const parseEntrypoint = (): Entrypoint => {
  const raw = (arg('--entrypoint') ?? 'start').trim()
  if (raw === 'start' || raw === 'swapAndStart') return raw
  throw new Error(
    `Invalid --entrypoint '${raw}'. Expected: start | swapAndStart`
  )
}

const parseEnv = (): EnvironmentEnum => {
  const raw = (arg('--env') ?? 'staging').trim()
  if (raw === 'staging') return EnvironmentEnum.staging
  if (raw === 'production') return EnvironmentEnum.production
  throw new Error(`Invalid --env '${raw}'. Expected: staging | production`)
}

const parseChain = (flag: string, fallback: SupportedChain): SupportedChain => {
  const raw = (arg(flag) ?? fallback).trim() as SupportedChain
  if (!networks[raw]) throw new Error(`Unknown chain '${raw}' for ${flag}`)
  return raw
}

const bytes32ToEvmAddress = (b32: Hex): Address => {
  // bytes32(uint256(uint160(addr))) => addr in last 20 bytes
  if (b32.length !== 66) throw new Error('Invalid bytes32 length')
  return getAddress(`0x${b32.slice(26)}`) as Address
}

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
        { name: 'maxUserSlippageBps', type: 'uint256' },
        { name: 'finalRecipient', type: 'bytes32' },
        { name: 'finalToken', type: 'bytes32' },
        { name: 'destinationDex', type: 'uint32' },
        { name: 'lzReceiveGasLimit', type: 'uint256' },
        { name: 'lzComposeGasLimit', type: 'uint256' },
        { name: 'maxOftFeeBps', type: 'uint256' },
        { name: 'accountCreationMode', type: 'uint8' },
        { name: 'executionMode', type: 'uint8' },
        { name: 'actionData', type: 'bytes' },
      ],
    },
    {
      name: 'unsignedParams',
      type: 'tuple',
      components: [{ name: 'refundRecipient', type: 'address' }],
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
    { name: 'destinationDex', type: 'uint32' },
    { name: 'accountCreationMode', type: 'uint8' },
    { name: 'executionMode', type: 'uint8' },
    { name: 'actionData', type: 'bytes' },
  ],
} as const

// ABI for decoding Swap API periphery calldata (swapAndBridge)
const SPOKE_POOL_PERIPHERY_SWAP_AND_BRIDGE_ABI = parseAbi([
  'function swapAndBridge((( uint256 amount, address recipient) submissionFees, (address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce) swapAndDepositData)',
])

interface IAcrossV4SwapFacetData {
  swapApiTarget: 0 | 1 | 2 | 3
  callData: Hex
  signature: Hex
}

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

interface IAcrossSwapApiResponse {
  depositTxn?: { to: string; data: string; value: string }
  swapTx?: { to: string; data: string; value: string }
}

interface IAcrossSwapApiRequest {
  originChainId: number
  destinationChainId: number
  inputToken: string
  outputToken: string
  amount: string
  recipient: string
  depositor: string
  refundAddress?: string
  refundOnOrigin?: boolean
  slippageTolerance?: number
  skipOriginTxEstimation?: boolean
}

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
    slippageTolerance: (request.slippageTolerance ?? 1).toString(),
    skipOriginTxEstimation: (request.skipOriginTxEstimation ?? true).toString(),
  })
  if (request.refundAddress)
    params.append('refundAddress', request.refundAddress)

  const response = await fetch(`${baseUrl}?${params.toString()}`)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Across Swap API error (${response.status}): ${errorText}`)
  }
  return (await response.json()) as IAcrossSwapApiResponse
}

const buildFacetBackendSignature = async (args: {
  backendPrivateKey: Hex
  chainId: number
  verifyingContract: Address
  bridgeData: IBridgeData
  swapApiTarget: 0 | 1
  callDataNoSelector: Hex
}): Promise<Hex> => {
  const account = privateKeyToAccount(args.backendPrivateKey)

  // Must match facet:
  // name="LI.FI Across V4 Swap Facet", version="1"
  const domain = {
    name: 'LI.FI Across V4 Swap Facet',
    version: '1',
    chainId: BigInt(args.chainId),
    verifyingContract: args.verifyingContract,
  } as const

  const types = {
    AcrossV4SwapPayload: [
      { name: 'transactionId', type: 'bytes32' },
      { name: 'minAmount', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'sendingAssetId', type: 'address' },
      { name: 'swapApiTarget', type: 'uint8' },
      { name: 'callDataHash', type: 'bytes32' },
    ],
  } as const

  const message = {
    transactionId: args.bridgeData.transactionId,
    minAmount: args.bridgeData.minAmount,
    receiver: args.bridgeData.receiver,
    destinationChainId: BigInt(args.bridgeData.destinationChainId),
    sendingAssetId: args.bridgeData.sendingAssetId,
    swapApiTarget: args.swapApiTarget,
    callDataHash: keccak256(args.callDataNoSelector),
  } as const

  return (await account.signTypedData({
    domain,
    types,
    primaryType: 'AcrossV4SwapPayload',
    message,
  })) as Hex
}

async function main() {
  if (SHOW_HELP) {
    console.log(`
AcrossV4SwapFacet calldata demo

Defaults:
  - prints calldata (safe). Use --send to broadcast.

Required:
  --mode <spokePool|spokePoolPeriphery|sponsoredOft|sponsoredCctp>

Optional:
  --src <chain>                (default: arbitrum)
  --dst <chain>                (default: optimism)
  --env <staging|production>   (default: staging)
  --entrypoint <start|swapAndStart> (default: start)
  --receiver <0x..>            (default: wallet address)
  --amount <decimal>           (only for spokePool/spokePoolPeriphery; default depends on mode)

Supplying callData (all modes):
  --callDataHex <0x..>          selector-less callData (used as-is)
  --fullCalldataHex <0x..>      full calldata with selector (selector will be stripped)

SpokePool / SpokePoolPeriphery (swapApiTarget 0/1):
  - The facet REQUIRES a backend EIP-712 signature.
  By default this script reads from .env:
    - staging:    PRIVATE_KEY_BACKEND_SIGNER_STAGING
    - production: PRIVATE_KEY_BACKEND_SIGNER_PRODUCTION
  You can override with:
    --backendPrivateKey <0x..32bytes>
  If callData not supplied, the script fetches Across Swap API and builds callData automatically.

Sponsored OFT (swapApiTarget 2):
  Provide one of:
    --callDataHex <0x..>  (selector-less abi.encode(quote, signature))
    --quoteJson <path> --signatureHex <0x..>
  Also required:
    --sendingAssetId <0x..>     (token to approve+deposit into Diamond)
  Optional:
    --msgValueWei <wei>         (LayerZero fees forwarded to periphery)

Sponsored CCTP (swapApiTarget 3):
  Provide one of:
    --callDataHex <0x..>  (selector-less abi.encode(quote, signature, refundRecipient))
    --quoteJson <path> --signatureHex <0x..>
  Optional:
    --sendingAssetId <0x..>     (if omitted, derived from quote.burnToken)
    --refundRecipient <0x..>    (if omitted when using quoteJson, defaults to wallet address)

Swap-and-start encoding (optional):
  --entrypoint swapAndStart --swapDataJson <path>
  swapDataJson must be an array of {callTo, approveTo, sendingAssetId, receivingAssetId, fromAmount, callData, requiresDeposit}

Examples (print only):
  bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePoolPeriphery --backendPrivateKey 0x...
  bun run script/demoScripts/demoAcrossV4Swap.ts --mode spokePool --backendPrivateKey 0x...
  bun run script/demoScripts/demoAcrossV4Swap.ts --mode sponsoredCctp --quoteJson ./quote.json --signatureHex 0x...
`)
    process.exit(0)
  }

  const MODE = parseMode()
  const ENTRYPOINT = parseEntrypoint()
  const ENVIRONMENT = parseEnv()

  const SRC_CHAIN = parseChain('--src', 'arbitrum')
  const DST_CHAIN = parseChain('--dst', 'optimism')
  const fromChainId = networks[SRC_CHAIN].chainId
  const toChainId = networks[DST_CHAIN].chainId

  const FACET_ABI = acrossV4SwapFacetArtifact.abi as Abi
  const {
    publicClient,
    walletClient,
    walletAccount,
    lifiDiamondContract,
    lifiDiamondAddress,
  } = await setupEnvironment(SRC_CHAIN, FACET_ABI, ENVIRONMENT)

  if (!lifiDiamondContract || !lifiDiamondAddress)
    throw new Error('Missing Diamond contract/address from setupEnvironment()')

  const walletAddress = getAddress(walletAccount.address)
  const receiver = getAddress(arg('--receiver') ?? walletAddress)

  // ----------------------------------------------------------------------------------------------
  // Build AcrossV4SwapFacetData.callData (selector-less) + BridgeData fields needed for signature
  // ----------------------------------------------------------------------------------------------
  const callDataHexArg = arg('--callDataHex')
  const fullCalldataHexArg = arg('--fullCalldataHex')

  let swapApiTarget: 0 | 1 | 2 | 3
  let callDataNoSelector: Hex
  let sendingAssetId: Address
  let minAmount: bigint
  let msgValueWei = argBigInt('--msgValueWei') ?? 0n

  if (MODE === 'spokePoolPeriphery' || MODE === 'spokePool') {
    swapApiTarget = MODE === 'spokePool' ? 0 : 1

    const USDC_BY_CHAIN: Partial<Record<SupportedChain, Address>> = {
      arbitrum: ADDRESS_USDC_ARB,
      optimism: ADDRESS_USDC_OPT,
      base: ADDRESS_USDC_BASE,
      mainnet: ADDRESS_USDC_ETH,
      polygon: ADDRESS_USDC_POL,
    }

    const defaultInputToken =
      MODE === 'spokePoolPeriphery'
        ? networks[SRC_CHAIN].wrappedNativeAddress
        : USDC_BY_CHAIN[SRC_CHAIN]
    const defaultOutputToken = USDC_BY_CHAIN[DST_CHAIN]

    const inputTokenRaw = arg('--inputToken') ?? defaultInputToken
    if (!inputTokenRaw) {
      throw new Error(
        `Missing input token for SRC_CHAIN=${SRC_CHAIN}. Provide --inputToken 0x...`
      )
    }

    const outputTokenRaw = arg('--outputToken') ?? defaultOutputToken
    if (!outputTokenRaw) {
      throw new Error(
        `Missing output token for DST_CHAIN=${DST_CHAIN}. Provide --outputToken 0x...`
      )
    }

    const inputToken = getAddress(inputTokenRaw)
    const outputToken = getAddress(outputTokenRaw)

    const amountWei = argBigInt('--amountWei')
    const amountDecimals = MODE === 'spokePoolPeriphery' ? 18 : 6
    const defaultAmountWei =
      MODE === 'spokePoolPeriphery' ? parseUnits('0.0003', 18) : 6000000n
    const amount =
      amountWei ??
      (arg('--amount')
        ? parseUnits(arg('--amount') as string, amountDecimals)
        : defaultAmountWei)

    sendingAssetId = inputToken
    minAmount = amount
    msgValueWei = 0n

    if (fullCalldataHexArg) {
      // sanity-check decode for SpokePoolPeriphery.swapAndBridge(...)
      if (MODE === 'spokePoolPeriphery') {
        decodeFunctionData({
          abi: SPOKE_POOL_PERIPHERY_SWAP_AND_BRIDGE_ABI,
          data: assertHex(fullCalldataHexArg, '--fullCalldataHex'),
        })
      }
      callDataNoSelector = stripSelector(
        assertHex(fullCalldataHexArg, '--fullCalldataHex')
      )
    } else if (callDataHexArg) {
      callDataNoSelector = assertHex(callDataHexArg, '--callDataHex')
    } else {
      // Fetch Across Swap API quote and extract the calldata we need.
      const req: IAcrossSwapApiRequest = {
        originChainId: fromChainId,
        destinationChainId: toChainId,
        inputToken,
        outputToken,
        amount: minAmount.toString(),
        recipient: receiver,
        depositor: lifiDiamondAddress,
        refundAddress: receiver,
        refundOnOrigin: true,
        slippageTolerance: 1,
        skipOriginTxEstimation: true,
      }

      const quote = await getAcrossSwapQuote(req)

      const tx = MODE === 'spokePoolPeriphery' ? quote.swapTx : quote.depositTxn
      if (!tx?.data)
        throw new Error(
          `Across Swap API did not return expected calldata for mode=${MODE}`
        )

      callDataNoSelector = stripSelector(
        assertHex(tx.data, 'across.swapApi.data')
      )
    }
  } else if (MODE === 'sponsoredOft') {
    swapApiTarget = 2

    const sendingAssetIdArg = arg('--sendingAssetId')
    if (!sendingAssetIdArg)
      throw new Error('Missing --sendingAssetId for sponsoredOft')
    sendingAssetId = getAddress(sendingAssetIdArg)

    if (fullCalldataHexArg) {
      callDataNoSelector = stripSelector(
        assertHex(fullCalldataHexArg, '--fullCalldataHex')
      )
    } else if (callDataHexArg) {
      callDataNoSelector = assertHex(callDataHexArg, '--callDataHex')
    } else {
      const quoteJsonPath = arg('--quoteJson')
      const signatureHex = arg('--signatureHex')
      if (!quoteJsonPath || !signatureHex)
        throw new Error(
          'sponsoredOft requires --callDataHex OR (--quoteJson and --signatureHex) OR --fullCalldataHex'
        )
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
    const oftQuote = quoteDecoded as {
      signedParams: { amountLD: bigint; finalRecipient: Hex }
    }

    // Default minAmount to quote amount (allow override via --minAmount)
    minAmount = argBigInt('--minAmount') ?? oftQuote.signedParams.amountLD

    // Keep receiver consistent with quote (integrator safety, mirrors on-chain checks)
    const finalRecipientAddr = bytes32ToEvmAddress(
      oftQuote.signedParams.finalRecipient
    )
    if (finalRecipientAddr !== receiver) {
      throw new Error(
        `sponsoredOft receiver mismatch. quote.finalRecipient=${finalRecipientAddr} receiver=${receiver}`
      )
    }
  } else {
    // sponsoredCctp
    swapApiTarget = 3

    if (fullCalldataHexArg) {
      callDataNoSelector = stripSelector(
        assertHex(fullCalldataHexArg, '--fullCalldataHex')
      )
    } else if (callDataHexArg) {
      callDataNoSelector = assertHex(callDataHexArg, '--callDataHex')
    } else {
      const quoteJsonPath = arg('--quoteJson')
      const signatureHex = arg('--signatureHex')
      if (!quoteJsonPath || !signatureHex)
        throw new Error(
          'sponsoredCctp requires --callDataHex OR (--quoteJson and --signatureHex) OR --fullCalldataHex'
        )
      const quoteJsonRaw = await readFile(quoteJsonPath, 'utf8')
      const quote = JSON.parse(quoteJsonRaw)
      const sig = assertHex(signatureHex, '--signatureHex')
      const refundRecipient = getAddress(
        arg('--refundRecipient') ?? walletAddress
      )
      callDataNoSelector = encodeAbiParameters(
        [SPONSORED_CCTP_QUOTE_PARAM, { type: 'bytes' }, { type: 'address' }],
        [quote, sig, refundRecipient]
      )
    }

    const [quoteDecoded] = decodeAbiParameters(
      [SPONSORED_CCTP_QUOTE_PARAM, { type: 'bytes' }, { type: 'address' }],
      callDataNoSelector
    )
    const cctpQuote = quoteDecoded as {
      amount: bigint
      burnToken: Hex
      finalRecipient: Hex
    }

    // Default minAmount to quote amount (allow override via --minAmount)
    minAmount = argBigInt('--minAmount') ?? cctpQuote.amount

    // Default sendingAssetId to burnToken from quote (allow override via --sendingAssetId)
    const derivedBurnToken = bytes32ToEvmAddress(cctpQuote.burnToken)
    sendingAssetId = getAddress(arg('--sendingAssetId') ?? derivedBurnToken)

    const finalRecipientAddr = bytes32ToEvmAddress(cctpQuote.finalRecipient)
    if (finalRecipientAddr !== receiver) {
      throw new Error(
        `sponsoredCctp receiver mismatch. quote.finalRecipient=${finalRecipientAddr} receiver=${receiver}`
      )
    }
    msgValueWei = 0n // facet enforces 0 for sponsored CCTP
  }

  const transactionId = (arg('--transactionId') ??
    (`0x${randomBytes(32).toString('hex')}` as Hex)) as Hex

  const bridgeData: IBridgeData = {
    transactionId,
    bridge: 'acrossV4Swap',
    integrator: arg('--integrator') ?? 'lifi-demo',
    referrer: getAddress(
      arg('--referrer') ??
        ('0x0000000000000000000000000000000000000000' as Address)
    ),
    sendingAssetId,
    receiver,
    minAmount,
    destinationChainId: toChainId,
    hasSourceSwaps: ENTRYPOINT === 'swapAndStart',
    hasDestinationCall: false,
  }

  let facetSignature: Hex = '0x'
  if (swapApiTarget === 0 || swapApiTarget === 1) {
    const backendPkCli = arg('--backendPrivateKey')
    const envVarName =
      ENVIRONMENT === EnvironmentEnum.staging
        ? 'PRIVATE_KEY_BACKEND_SIGNER_STAGING'
        : 'PRIVATE_KEY_BACKEND_SIGNER_PRODUCTION'

    const backendPrivateKey = assertHex(
      backendPkCli ?? getEnvVar(envVarName),
      backendPkCli ? '--backendPrivateKey' : envVarName
    )

    facetSignature = await buildFacetBackendSignature({
      backendPrivateKey,
      chainId: fromChainId,
      verifyingContract: lifiDiamondAddress,
      bridgeData,
      swapApiTarget,
      callDataNoSelector,
    })
  }

  const acrossV4SwapFacetData: IAcrossV4SwapFacetData = {
    swapApiTarget,
    callData: callDataNoSelector,
    signature: facetSignature,
  }

  // ----------------------------------------------------------------------------------------------
  // Encode Diamond calldata
  // ----------------------------------------------------------------------------------------------
  let swapData: ISwapData[] = []
  if (ENTRYPOINT === 'swapAndStart') {
    const swapDataJson = arg('--swapDataJson')
    if (!swapDataJson)
      throw new Error('swapAndStart requires --swapDataJson <path>')
    const raw = await readFile(swapDataJson, 'utf8')
    // Expect direct array of SwapData-compatible objects.
    swapData = JSON.parse(raw) as ISwapData[]
  }

  const diamondCallData =
    ENTRYPOINT === 'swapAndStart'
      ? encodeFunctionData({
          abi: FACET_ABI,
          functionName: 'swapAndStartBridgeTokensViaAcrossV4Swap',
          args: [bridgeData, swapData, acrossV4SwapFacetData],
        })
      : encodeFunctionData({
          abi: FACET_ABI,
          functionName: 'startBridgeTokensViaAcrossV4Swap',
          args: [bridgeData, acrossV4SwapFacetData],
        })

  // Minimal, effective output (primary goal: show calldata)
  consola.info(`mode=${MODE} entrypoint=${ENTRYPOINT} env=${ENVIRONMENT}`)
  consola.info(`to=${lifiDiamondAddress}`)
  consola.info(`value=${msgValueWei.toString()}`)
  consola.info(`data=${diamondCallData}`)

  if (PRINT_CALLDATA && !SEND_TX) return

  // ----------------------------------------------------------------------------------------------
  // Optional: send tx (best-effort helper; may still revert depending on quote validity/allowlists)
  // ----------------------------------------------------------------------------------------------
  const isNativeAsset = getAddress(bridgeData.sendingAssetId) === zeroAddress

  const tokenContract = isNativeAsset
    ? null
    : getContract({
        address: bridgeData.sendingAssetId,
        abi: erc20Abi,
        client: { public: publicClient, wallet: walletClient },
      })

  await ensureBalance(
    isNativeAsset ? zeroAddress : tokenContract,
    walletAddress,
    bridgeData.minAmount,
    publicClient
  )

  if (!isNativeAsset && tokenContract) {
    await ensureAllowance(
      tokenContract,
      walletAddress,
      lifiDiamondAddress as string,
      bridgeData.minAmount,
      publicClient
    )
  }

  const typedDiamond = lifiDiamondContract as unknown as {
    write: {
      startBridgeTokensViaAcrossV4Swap: (
        args: readonly [IBridgeData, IAcrossV4SwapFacetData],
        options: { value: bigint }
      ) => Promise<Hex>
      swapAndStartBridgeTokensViaAcrossV4Swap: (
        args: readonly [
          IBridgeData,
          readonly ISwapData[],
          IAcrossV4SwapFacetData
        ],
        options: { value: bigint }
      ) => Promise<Hex>
    }
  }

  const txHash =
    ENTRYPOINT === 'swapAndStart'
      ? await executeTransaction(
          () =>
            typedDiamond.write.swapAndStartBridgeTokensViaAcrossV4Swap(
              [bridgeData, swapData, acrossV4SwapFacetData],
              { value: msgValueWei }
            ),
          'AcrossV4SwapFacet swapAndStart',
          publicClient,
          true
        )
      : await executeTransaction(
          () =>
            typedDiamond.write.startBridgeTokensViaAcrossV4Swap(
              [bridgeData, acrossV4SwapFacetData],
              { value: msgValueWei }
            ),
          'AcrossV4SwapFacet start',
          publicClient,
          true
        )

  consola.info(`tx=${txHash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    consola.error(error)
    process.exit(1)
  })
