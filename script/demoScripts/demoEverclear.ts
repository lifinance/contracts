import { randomBytes } from 'crypto'

import { config } from 'dotenv'
import {
  getContract,
  parseUnits,
  zeroAddress,
  type Abi,
  parseAbi,
  type Hex,
  decodeFunctionData,
  type Address,
} from 'viem'

import everclearFacetArtifact from '../../out/EverclearFacet.sol/EverclearFacet.json'
import type { EverclearFacet, ILiFi } from '../../typechain'
import { ERC20__factory as ERC20 } from '../../typechain/factories/ERC20__factory'
import { EnvironmentEnum, type SupportedChain } from '../common/types'

import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
  addressToBytes32LeftPadded,
} from './utils/demoScriptHelpers'

config()

const EVERCLEAR_FACET_ABI = everclearFacetArtifact.abi as Abi

/**
 * Define ABI signatures for both EVM and Non-EVM chains
 *
 * IMPORTANT: These ABIs represent the CURRENT FeeAdapter (V1) implementation.
 *
 * Key differences between FeeAdapter V1 and FeeAdapterV2:
 *
 * V1 (FeeAdapter):
 * - Uses `uint24 maxFee` parameter
 * - Signature validation in _verifySignature does NOT include msg.sender
 * - Currently in production use
 *
 * V2 (FeeAdapterV2):
 * - Uses `uint256 amountOutMin` parameter instead of `uint24 maxFee`
 * - Signature validation in _verifySignature INCLUDES msg.sender in signed data
 * - Will require API to accept msg.sender parameter for proper signature generation
 * - When LiFi diamond calls newIntent, msg.sender will be diamond address, not user address
 *
 * Non-EVM vs EVM difference:
 * - Non-EVM (Solana, etc.): Uses `bytes32` for receiver and outputAsset
 * - EVM (Ethereum, Arbitrum, etc.): Uses `address` for receiver and outputAsset
 */

const NEW_INTENT_NON_EVM_ABI_STRING = [
  `function newIntent(uint32[] destinations, bytes32 receiver, address inputAsset, bytes32 outputAsset, uint256 amount, uint24 maxFee, uint48 ttl, bytes data, (uint256 fee, uint256 deadline, bytes sig) feeParams)`,
] as const

const NEW_INTENT_EVM_ABI_STRING = [
  `function newIntent(uint32[] destinations, address receiver, address inputAsset, address outputAsset, uint256 amount, uint24 maxFee, uint48 ttl, bytes data, (uint256 fee, uint256 deadline, bytes sig) feeParams)`,
] as const

// Using viem's parseAbi to convert the human-readable ABI into the structured ABI
const NEW_INTENT_NON_EVM_ABI = parseAbi(NEW_INTENT_NON_EVM_ABI_STRING)
const NEW_INTENT_EVM_ABI = parseAbi(NEW_INTENT_EVM_ABI_STRING)

/// SUCCESSFUL TRANSACTIONS
// FeeAdapter V1:
// Bridge USDC from Arbitrum to Linea - 0x22095c11bfb49334fcd01881517b5c95fc634f579b6652a450520ebda90b2445
// Bridge USDC from Arbitrum to Solana - 0x4a847cd232475f7ee7c7301efb62f5367c1f097127986a1874139ff2944db7bf
//
// FeeAdapterV2 (Upcoming - will replace V1 in 2-3 weeks):
// Bridge USDC from Arbitrum to Linea - TBD (requires amountOutMin parameter)
// Bridge USDC from Arbitrum to Solana - TBD (requires amountOutMin parameter)
//
// NOTE: When migrating to V2, the API call to https://api.everclear.org/intents
// will need to include msg.sender parameter (diamond address) for proper signature validation

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum'
  let destinationChainId = 59144 // Linea Mainnet

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(
    srcChain,
    EVERCLEAR_FACET_ABI,
    EnvironmentEnum.staging
  )
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS =
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}` // USDC on Arbitrum

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20.abi,
    client: client,
  })

  const srcTokenName = (await srcTokenContract.read.name()) as string
  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as number
  const amount = parseUnits('0.3', Number(srcTokenDecimals)) // 10 * 1e{source token decimals}

  // docs: https://docs.everclear.org/developers/api#post-routes-quotes
  const quoteResp = await fetch(`https://api.everclear.org/routes/quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: '42161',
      destinations: [destinationChainId.toString()],
      inputAsset: SRC_TOKEN_ADDRESS,
      amount: amount.toString(),
      to: signerAddress,
    }),
  })
  const quoteData = await quoteResp.json()

  console.log('quoteData')
  console.log(quoteData)

  let createIntentResp = await fetch(`https://api.everclear.org/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: '42161',
      destinations: [destinationChainId.toString()],
      to: signerAddress,
      inputAsset: SRC_TOKEN_ADDRESS,
      amount: amount.toString(),
      callData: '0x',
      maxFee: '0',
      order_id: `0x${randomBytes(32).toString('hex')}`,
    }),
  })
  let createIntentData = await createIntentResp.json()

  console.log('createIntentData')
  console.log(createIntentData)
  console.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> linea`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

  await ensureAllowance(
    srcTokenContract,
    signerAddress,
    lifiDiamondAddress as string,
    amount,
    publicClient
  )

  // // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'everclear',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // For EVM chains (Linea) - use EVM ABI
  let decodedNewIntentData = decodeNewIntentCalldata(
    createIntentData.data,
    false
  )
  let everclearData: EverclearFacet.EverclearDataStruct = {
    receiverAddress: addressToBytes32LeftPadded(
      decodedNewIntentData._receiver as Address
    ),
    nativeFee: BigInt(createIntentData.value),
    outputAsset: addressToBytes32LeftPadded(
      decodedNewIntentData._outputAsset as Address
    ),
    maxFee: BigInt(decodedNewIntentData._maxFee),
    ttl: BigInt(decodedNewIntentData._ttl),
    data: '',
    fee: decodedNewIntentData._feeParams.fee,
    deadline: decodedNewIntentData._feeParams.deadline,
    sig: decodedNewIntentData._feeParams.sig,
  }

  // // === Start bridging ===
  await executeTransaction(
    () =>
      (lifiDiamondContract as any).write.startBridgeTokensViaEverclear(
        [bridgeData, everclearData],
        { value: BigInt(createIntentData.value) }
      ),
    'Starting bridge tokens via Everclear',
    publicClient,
    true
  )

  /// Bridging from Arbitrum to Solana
  console.log('=== Bridging from Arbitrum to Solana ===')

  destinationChainId = 1399811149 // Solana

  createIntentResp = await fetch(`https://api.everclear.org/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: '42161',
      destinations: [destinationChainId.toString()],
      to: 'B8xioV266mGER51fTWAsx8mQeuiMb22jjoJiPTMa3aL7', // random solana address
      inputAsset: SRC_TOKEN_ADDRESS,
      amount: amount.toString(),
      callData: '0x',
      maxFee: '0',
      order_id: `0x${randomBytes(32).toString('hex')}`,
    }),
  })
  createIntentData = await createIntentResp.json()

  bridgeData.destinationChainId = 1151111081099710 // Solana chain id for LIFI
  bridgeData.receiver = '0x11f111f111f111F111f111f111F111f111f111F1' // change receiver to NON_EVM_ADDRESS

  // For Non-EVM chains (Solana) - use Non-EVM ABI
  decodedNewIntentData = decodeNewIntentCalldata(createIntentData.data, true)
  everclearData = {
    receiverAddress: decodedNewIntentData._receiver as Hex, // Already bytes32 for Solana
    nativeFee: BigInt(createIntentData.value),
    outputAsset: decodedNewIntentData._outputAsset as Hex, // Already bytes32 for Solana
    maxFee: BigInt(decodedNewIntentData._maxFee),
    ttl: BigInt(decodedNewIntentData._ttl),
    data: '',
    fee: decodedNewIntentData._feeParams.fee,
    deadline: decodedNewIntentData._feeParams.deadline,
    sig: decodedNewIntentData._feeParams.sig,
  }

  await executeTransaction(
    () =>
      (lifiDiamondContract as any).write.startBridgeTokensViaEverclear(
        [bridgeData, everclearData],
        { value: BigInt(createIntentData.value) }
      ),
    'Starting bridge tokens via Everclear',
    publicClient,
    true
  )
}

/**
 * Decodes the newIntent function calldata from Everclear API
 *
 * @param fullCalldata - The calldata returned from https://api.everclear.org/intents
 * @param isNonEVM - Whether the destination chain is Non-EVM (like Solana)
 *
 * IMPORTANT: This function currently handles FeeAdapter V1 calldata.
 * When FeeAdapterV2 is deployed, this function will need updates:
 * - Change `uint24 maxFee` to `uint256 amountOutMin` in ABI definitions
 * - Update parameter extraction accordingly
 * - The API will need to accept msg.sender parameter for signature validation
 */
function decodeNewIntentCalldata(fullCalldata: string, isNonEVM = false) {
  const data = fullCalldata as Hex

  try {
    // Choose the appropriate ABI based on destination chain type
    const abi = isNonEVM ? NEW_INTENT_NON_EVM_ABI : NEW_INTENT_EVM_ABI

    // Decode the parameters using viem's decodeFunctionData
    const { args } = decodeFunctionData({
      abi: abi,
      data: data,
    })

    console.log('args')
    console.log(args)

    // Destructure args according to the function signature
    const [
      _destinations,
      _receiver,
      _inputAsset,
      _outputAsset,
      _amount,
      _maxFee,
      _ttl,
      _data,
      _feeParamsTuple,
    ] = args
    // Return the decoded data with proper typing
    const output = {
      _destinations: _destinations as number[],
      _receiver: _receiver as Address | Hex, // Can be address or bytes32
      _inputAsset: _inputAsset as Address,
      _outputAsset: _outputAsset as Address | Hex, // Can be address or bytes32
      _amount: _amount,
      _maxFee: _maxFee,
      _ttl: _ttl,
      _data: _data,
      _feeParams: {
        fee: _feeParamsTuple.fee,
        deadline: _feeParamsTuple.deadline,
        sig: _feeParamsTuple.sig,
      },
    }

    return output
  } catch (e) {
    throw new Error(
      `Decoding Failed: The calldata structure does not match the provided signature. Error: ${e}`
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
