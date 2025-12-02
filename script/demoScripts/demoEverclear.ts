/**
 * Everclear Bridge Demo Script
 *
 * Bridges USDC from Arbitrum to Base/Solana using EverclearFacet
 *
 * Usage:
 * - Simple bridge (Arbitrum -> Base): bun run script/demoScripts/demoEverclear.ts
 * - Swap + bridge (Arbitrum -> Base): bun run script/demoScripts/demoEverclear.ts --swap
 * - Bridge to Solana: bun run script/demoScripts/demoEverclear.ts --solana
 * - Swap + bridge to Solana: bun run script/demoScripts/demoEverclear.ts --swap --solana
 *
 * Example TX (swap + bridge):
 * - Source (Arbitrum): https://arbiscan.io/tx/0x306a29a5614983ffb5909be28a0123492756573d215b45935ef2537de512b61e
 * - Destination (Base): https://basescan.org/tx/0x3ef9ca72c835f89713e9bdbaafcfecd094b355b3f7f1fac97154a83c793c4c3a
 *
 * Example TX (direct bridge):
 * - Source (Arbitrum): https://arbiscan.io/tx/0x5c7238a7c544f904c39cf1a81e2c1f263deb71d58cb7ba5db997b23de6a6e3e4
 * - Destination (Base): https://basescan.org/tx/0x2a8ac851c672c65d395612de9e6f5bcc9015265a993d473c7d4f383a5b29ab3b
 */

import { randomBytes } from 'crypto'

import { config } from 'dotenv'
import {
  getContract,
  parseUnits,
  formatUnits,
  zeroAddress,
  type Abi,
  parseAbi,
  type Hex,
  decodeFunctionData,
  type Address,
} from 'viem'

import type { EverclearFacet, ILiFi } from '../../typechain'
import { ERC20__factory } from '../../typechain/factories/ERC20__factory'
import { EverclearFacet__factory } from '../../typechain/factories/EverclearFacet__factory'
import type { SupportedChain } from '../common/types'

import {
  ADDRESS_USDC_ARB,
  ADDRESS_USDT_ARB,
  ADDRESS_UNISWAP_ARB,
  ADDRESS_USDC_SOL,
  ADDRESS_USDC_BASE,
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
  getUniswapDataERC20toExactERC20,
  zeroPadAddressToBytes32,
  deriveSolanaAddress,
  solanaAddressToBytes32,
} from './utils/demoScriptHelpers'

config()

// ########## CONFIGURE SCRIPT HERE ##########
const WITH_SOURCE_SWAP = process.argv.includes('--swap')
const TO_SOLANA = process.argv.includes('--solana')
const AMOUNT = parseUnits('3', 6) // 3 USDC
const SRC_CHAIN: SupportedChain = 'arbitrum'
const EXPLORER_BASE_URL = 'https://arbiscan.io/tx/'
// ###########################################

// Hyperlane/Everclear Domain IDs (not EVM Chain IDs!)
// Reference: https://docs.everclear.org/resources/contracts/mainnet
const ARBITRUM_DOMAIN_ID = 42161 // Hyperlane domain ID for Arbitrum
const BASE_DOMAIN_ID = 8453 // Hyperlane domain ID for Base
const SOLANA_DOMAIN_ID = 1399811149 // Hyperlane domain ID for Solana

// Derive domain IDs based on destination
const FROM_DOMAIN_ID = ARBITRUM_DOMAIN_ID
const TO_DOMAIN_ID = TO_SOLANA ? SOLANA_DOMAIN_ID : BASE_DOMAIN_ID

// LiFi chain IDs (matching LiFiData.sol)
const LIFI_CHAIN_ID_SOLANA = 1151111081099710n
const LIFI_CHAIN_ID_BASE = 8453n // Base chain ID for LiFi

// NON_EVM_ADDRESS constant from LiFiData.sol
const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'

const EVERCLEAR_FACET_ABI = EverclearFacet__factory.abi as Abi
const ERC20_ABI = ERC20__factory.abi as Abi
const EVERCLEAR_API_BASE_URL = 'https://api.everclear.org'

// FeeAdapter newIntent ABI for decoding (EVM and non-EVM versions)
const NEW_INTENT_EVM_ABI = parseAbi([
  'function newIntent(uint32[],address,address,address,uint256,uint256,uint48,bytes,(uint256,uint256,bytes))',
])

const NEW_INTENT_NON_EVM_ABI = parseAbi([
  'function newIntent(uint32[],bytes32,address,bytes32,uint256,uint256,uint48,bytes,(uint256,uint256,bytes))',
])

/**
 * Decodes FeeAdapter calldata to extract signature and parameters (EVM version)
 */
function decodeNewIntentCalldata(fullCalldata: string) {
  const data = fullCalldata as Hex

  try {
    const { args } = decodeFunctionData({
      abi: NEW_INTENT_EVM_ABI,
      data: data,
    })

    const [
      _destinations,
      _receiver,
      _inputAsset,
      _outputAsset,
      _amount,
      _amountOutMin,
      _ttl,
      _data,
      _feeParamsTuple,
    ] = args

    // feeParamsTuple is an array: [fee, deadline, sig]
    const [fee, deadline, sig] = _feeParamsTuple as readonly [
      bigint,
      bigint,
      `0x${string}`
    ]

    return {
      _destinations: _destinations as number[],
      _receiver: _receiver as Address,
      _inputAsset: _inputAsset as Address,
      _outputAsset: _outputAsset as Address,
      _amount: _amount,
      _amountOutMin: _amountOutMin,
      _ttl: _ttl,
      _data: _data,
      _feeParams: {
        fee: fee,
        deadline: deadline,
        sig: sig,
      },
    }
  } catch (e) {
    throw new Error(
      `Decoding Failed: The calldata structure does not match the provided signature. Error: ${e}`
    )
  }
}

/**
 * Decodes FeeAdapter calldata to extract signature and parameters (non-EVM version for Solana)
 */
function decodeNewIntentNonEVMCalldata(fullCalldata: string) {
  const data = fullCalldata as Hex

  try {
    const { args } = decodeFunctionData({
      abi: NEW_INTENT_NON_EVM_ABI,
      data: data,
    })

    const [
      _destinations,
      _receiverBytes32,
      _inputAsset,
      _outputAssetBytes32,
      _amount,
      _amountOutMin,
      _ttl,
      _data,
      _feeParamsTuple,
    ] = args

    // feeParamsTuple is an array: [fee, deadline, sig]
    const [fee, deadline, sig] = _feeParamsTuple as readonly [
      bigint,
      bigint,
      `0x${string}`
    ]

    return {
      _destinations: _destinations as number[],
      _receiverBytes32: _receiverBytes32 as `0x${string}`,
      _inputAsset: _inputAsset as Address,
      _outputAssetBytes32: _outputAssetBytes32 as `0x${string}`,
      _amount: _amount,
      _amountOutMin: _amountOutMin,
      _ttl: _ttl,
      _data: _data,
      _feeParams: {
        fee: fee,
        deadline: deadline,
        sig: sig,
      },
    }
  } catch (e) {
    throw new Error(
      `Decoding non-EVM calldata failed: The calldata structure does not match the provided signature. Error: ${e}`
    )
  }
}

async function main() {
  console.log('\n=== Everclear Bridge Demo ===')
  console.log(`Mode: ${WITH_SOURCE_SWAP ? 'Swap + Bridge' : 'Simple Bridge'}`)
  console.log(
    `From: Arbitrum (domain ${FROM_DOMAIN_ID}) -> ${
      TO_SOLANA ? 'Solana' : 'Base'
    } (domain ${TO_DOMAIN_ID})`
  )
  console.log(`Amount: ${formatUnits(AMOUNT, 6)} USDC\n`)

  // Setup environment
  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(SRC_CHAIN, EVERCLEAR_FACET_ABI)
  const signerAddress = walletAccount.address

  console.log('Connected wallet:', signerAddress)
  console.log('LiFiDiamond:', lifiDiamondAddress)

  // Determine tokens based on mode
  const sendingAssetId = WITH_SOURCE_SWAP ? ADDRESS_USDT_ARB : ADDRESS_USDC_ARB
  const bridgeAssetId = ADDRESS_USDC_ARB // Always bridge USDC
  let bridgeAmount = AMOUNT
  const srcSwapData: unknown[] = []

  // Handle source swap if needed
  if (WITH_SOURCE_SWAP) {
    console.log('\nPreparing source swap: USDT -> USDC')

    const usdtContract = getContract({
      address: ADDRESS_USDT_ARB,
      abi: ERC20_ABI,
      client,
    })

    await ensureBalance(usdtContract, signerAddress, AMOUNT, publicClient)
    await ensureAllowance(
      usdtContract,
      signerAddress,
      lifiDiamondAddress as string,
      AMOUNT,
      publicClient
    )

    const { BigNumber } = await import('ethers')
    const swapData = await getUniswapDataERC20toExactERC20(
      ADDRESS_UNISWAP_ARB,
      ARBITRUM_DOMAIN_ID, // Use domain ID
      ADDRESS_USDT_ARB,
      ADDRESS_USDC_ARB,
      BigNumber.from(AMOUNT.toString()),
      lifiDiamondAddress as string,
      true
    )
    srcSwapData.push(swapData)
    bridgeAmount = AMOUNT

    console.log(
      'Swap prepared: will receive',
      formatUnits(bridgeAmount, 6),
      'USDC'
    )
  } else {
    const usdcContract = getContract({
      address: ADDRESS_USDC_ARB,
      abi: ERC20_ABI,
      client,
    })

    await ensureBalance(usdcContract, signerAddress, AMOUNT, publicClient)
  }

  // Get intent data from Everclear API
  console.log('\nFetching intent from Everclear API...')

  // Determine destination address based on whether we're bridging to Solana
  let destinationAddress: string = signerAddress
  let solanaRecipient: string | null = null
  if (TO_SOLANA) {
    const privateKey = process.env.PRIVATE_KEY
    if (!privateKey)
      throw new Error('PRIVATE_KEY env var required for Solana destination')

    solanaRecipient = deriveSolanaAddress(privateKey)
    destinationAddress = solanaRecipient
    console.log('Derived Solana recipient address:', solanaRecipient)
  }

  // Note: 'from' parameter is optional - we include it for tracking
  // The API endpoint and request body differ for Solana vs EVM chains
  let requestBody: Record<string, unknown>

  if (TO_SOLANA) {
    // Solana-specific request body structure
    // Reference: POST /solana/intents from API spec
    // Required fields: origin, destinations, to, inputAsset, amount, callData, maxFee, user
    requestBody = {
      origin: FROM_DOMAIN_ID.toString(),
      destinations: [TO_DOMAIN_ID.toString()],
      to: destinationAddress, // Solana address in base58
      from: signerAddress, // Origin EVM address (optional but include for tracking)
      inputAsset: bridgeAssetId,
      amount: bridgeAmount.toString(),
      callData: '0x',
      maxFee: bridgeAmount.toString(), // Max fee in input token units - set to full amount initially
      user: solanaRecipient, // Solana user address (required)
      order_id: `0x${randomBytes(32).toString('hex')}`,
    }
  } else {
    // EVM-specific request body structure
    // Required fields: origin, destinations, to, inputAsset, amount, callData
    requestBody = {
      origin: FROM_DOMAIN_ID.toString(),
      destinations: [TO_DOMAIN_ID.toString()],
      to: destinationAddress,
      from: signerAddress,
      inputAsset: bridgeAssetId,
      outputAsset: ADDRESS_USDC_BASE, // Use Base USDC for destination
      amount: bridgeAmount.toString(),
      callData: '0x',
      ttl: 0, // TTL in seconds (0 for standard clearing path)
      isFastPath: false, // Use standard clearing path
      order_id: `0x${randomBytes(32).toString('hex')}`,
    }
  }

  // Use different API endpoints for Solana vs EVM
  const apiEndpoint = TO_SOLANA
    ? `${EVERCLEAR_API_BASE_URL}/solana/intents`
    : `${EVERCLEAR_API_BASE_URL}/intents`

  console.log('API endpoint:', apiEndpoint)
  console.log('Request body:', JSON.stringify(requestBody, null, 2))

  const createIntentResp = await fetch(apiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!createIntentResp.ok) {
    const errorText = await createIntentResp.text()
    throw new Error(
      `Everclear API failed: ${createIntentResp.status} - ${errorText}`
    )
  }

  const createIntentData = await createIntentResp.json()
  console.log('Intent response received')
  console.log('  FeeAdapter:', createIntentData.to)

  // Decode the calldata to extract signature and parameters
  // Use different ABI based on destination chain type
  let decoded:
    | ReturnType<typeof decodeNewIntentCalldata>
    | ReturnType<typeof decodeNewIntentNonEVMCalldata>
  if (TO_SOLANA) {
    decoded = decodeNewIntentNonEVMCalldata(createIntentData.data)
    console.log('\nIntent parameters (Solana):')
    console.log('  Receiver (bytes32):', decoded._receiverBytes32)
    console.log('  Output asset (bytes32):', decoded._outputAssetBytes32)
  } else {
    decoded = decodeNewIntentCalldata(createIntentData.data)
    console.log('\nIntent parameters (EVM):')
    console.log('  Receiver:', decoded._receiver)
    console.log('  Output asset:', decoded._outputAsset)
  }

  console.log('  Fee:', formatUnits(decoded._feeParams.fee, 6), 'USDC')
  console.log(
    '  Min amount out:',
    formatUnits(decoded._amountOutMin, 6),
    'USDC'
  )
  console.log('  TTL:', decoded._ttl.toString(), 'seconds')
  console.log(
    '  Deadline:',
    new Date(Number(decoded._feeParams.deadline) * 1000).toISOString()
  )
  console.log('  Signature:', decoded._feeParams.sig.substring(0, 20) + '...')

  // Ensure allowance to LiFiDiamond
  console.log('\nEnsuring allowance to LiFiDiamond...')
  const tokenContract = getContract({
    address: bridgeAssetId,
    abi: ERC20_ABI,
    client,
  })

  await ensureAllowance(
    tokenContract,
    signerAddress,
    lifiDiamondAddress as string,
    bridgeAmount,
    publicClient
  )

  // Prepare bridge data
  // For Solana destinations, use NON_EVM_ADDRESS and LIFI_CHAIN_ID_SOLANA
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'everclear',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId: bridgeAssetId,
    receiver: TO_SOLANA ? (NON_EVM_ADDRESS as `0x${string}`) : signerAddress,
    destinationChainId: TO_SOLANA ? LIFI_CHAIN_ID_SOLANA : LIFI_CHAIN_ID_BASE,
    minAmount: bridgeAmount,
    hasSourceSwaps: WITH_SOURCE_SWAP,
    hasDestinationCall: false,
  }

  // Prepare Everclear data
  let receiverAddressBytes32: `0x${string}`
  let outputAssetBytes32: `0x${string}`

  if (TO_SOLANA) {
    // For Solana, convert the base58 address to bytes32
    if (!solanaRecipient) throw new Error('Solana recipient not computed')
    receiverAddressBytes32 = solanaAddressToBytes32(solanaRecipient)
    outputAssetBytes32 = solanaAddressToBytes32(ADDRESS_USDC_SOL)

    console.log('\nSolana address encoding:')
    console.log('  Recipient (base58):', solanaRecipient)
    console.log('  Recipient (bytes32):', receiverAddressBytes32)
    console.log('  USDC mint (base58):', ADDRESS_USDC_SOL)
    console.log('  USDC mint (bytes32):', outputAssetBytes32)
  } else {
    receiverAddressBytes32 = zeroPadAddressToBytes32(signerAddress)
    outputAssetBytes32 = zeroPadAddressToBytes32(ADDRESS_USDC_BASE)
  }

  const everclearData: EverclearFacet.EverclearDataStruct = {
    receiverAddress: receiverAddressBytes32,
    nativeFee: BigInt(createIntentData.value || '0'),
    outputAsset: outputAssetBytes32,
    amountOutMin: decoded._amountOutMin,
    amountOutMinMultiplier: BigInt(1e18), // 100% pass-through (1:1 ratio)
    ttl: decoded._ttl,
    data: '0x' as `0x${string}`,
    fee: decoded._feeParams.fee,
    deadline: decoded._feeParams.deadline,
    sig: decoded._feeParams.sig as `0x${string}`,
  }

  console.log('\n=== Executing Transaction ===')
  console.log(
    'Function:',
    WITH_SOURCE_SWAP
      ? 'swapAndStartBridgeTokensViaEverclear'
      : 'startBridgeTokensViaEverclear'
  )

  // Execute transaction
  let txHash: string | null = null
  if (WITH_SOURCE_SWAP) {
    txHash = await executeTransaction(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lifiDiamondContract as any).write.swapAndStartBridgeTokensViaEverclear(
          [bridgeData, srcSwapData, everclearData],
          { value: everclearData.nativeFee }
        ),
      'Swapping and bridging tokens via Everclear',
      publicClient,
      true
    )
  } else {
    txHash = await executeTransaction(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lifiDiamondContract as any).write.startBridgeTokensViaEverclear(
          [bridgeData, everclearData],
          { value: everclearData.nativeFee }
        ),
      'Starting bridge tokens via Everclear',
      publicClient,
      true
    )
  }

  console.log('\n✅ Bridge initiated successfully!')
  console.log('From:', sendingAssetId, '(Arbitrum)')
  if (TO_SOLANA) {
    console.log('To:', ADDRESS_USDC_SOL, '(Solana)')
    console.log('Amount:', formatUnits(bridgeAmount, 6), 'USDC')
    console.log('Receiver (Solana):', solanaRecipient)
    console.log('LiFi Chain ID:', LIFI_CHAIN_ID_SOLANA.toString())
    console.log('Everclear Domain ID:', SOLANA_DOMAIN_ID)
  } else {
    console.log('To:', ADDRESS_USDC_BASE, '(Base)')
    console.log('Amount:', formatUnits(bridgeAmount, 6), 'USDC')
    console.log('Receiver:', signerAddress)
    console.log('LiFi Chain ID:', LIFI_CHAIN_ID_BASE.toString())
    console.log('Everclear Domain ID:', BASE_DOMAIN_ID)
  }
  console.log('View on Arbiscan:', `${EXPLORER_BASE_URL}${txHash}`)
  console.log('\n=== Demo Complete ===\n')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '\n❌ Fatal error:',
      error.shortMessage || error.message || error
    )
    if (error.signature === '0xa85a0869') {
      console.error('\n📝 ERROR: FeeAdapter_InvalidSignature() [0xa85a0869]')
      console.error('\nThis error indicates the signature validation failed.')
      console.error(
        'Note: Everclear no longer uses msg.sender in signature validation.'
      )
      console.error(
        'The sig check uses intent transaction input + fee params only.'
      )
      console.error('\nPossible causes:')
      console.error('  1. Signature has expired (check deadline)')
      console.error('  2. Intent parameters do not match what was signed')
      console.error('  3. Fee parameters mismatch')
    }
    process.exit(1)
  })
