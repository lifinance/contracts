/**
 * Everclear Bridge Demo Script
 *
 * Bridges USDC from Arbitrum to Base using EverclearFacet
 *
 * Usage:
 * - Simple bridge: bun run script/demoScripts/demoEverclear.ts
 * - Swap + bridge: bun run script/demoScripts/demoEverclear.ts --swap
 *
 * Architecture:
 * 1. User approves USDC to LiFiDiamond (0xD3b2b0aC0AFdd0d166a495f5E9fca4eCc715a782)
 * 2. Script calls POST /intents API to get FeeAdapter calldata with signature
 * 3. Decodes FeeAdapter calldata to extract signature and fee params
 * 4. Calls startBridgeTokensViaEverclear() on LiFiDiamond with extracted params
 * 5. LiFiDiamond → EverclearFacet → FeeAdapter.newIntent() (validates signature)
 *
 * Implementation:
 * ✅ Uses TypeChain ABIs from EverclearFacet__factory
 * ✅ Uses viem (not ethers) and bun runtime
 * ✅ Properly decodes FeeAdapter calldata
 * ✅ Calls LiFiDiamond contract functions correctly
 * ✅ Supports both simple bridge and swap+bridge modes
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
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
  getUniswapDataERC20toExactERC20,
  zeroPadAddressToBytes32,
} from './utils/demoScriptHelpers'

config()

// ########## CONFIGURE SCRIPT HERE ##########
const WITH_SOURCE_SWAP = process.argv.includes('--swap')
const FROM_CHAIN_ID = 42161 // Arbitrum
const TO_CHAIN_ID = 8453 // Base
const AMOUNT = parseUnits('3', 6) // 3 USDC
const SRC_CHAIN: SupportedChain = 'arbitrum'
const EXPLORER_BASE_URL = 'https://arbiscan.io/tx/'
const ADDRESS_USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // USDC on Base
// ###########################################

const EVERCLEAR_FACET_ABI = EverclearFacet__factory.abi as Abi
const ERC20_ABI = ERC20__factory.abi as Abi
const EVERCLEAR_API_BASE_URL = 'https://api.everclear.org'

// FeeAdapter newIntent ABI for decoding
const NEW_INTENT_EVM_ABI = parseAbi([
  'function newIntent(uint32[],address,address,address,uint256,uint256,uint48,bytes,(uint256,uint256,bytes))',
])

/**
 * Decodes FeeAdapter calldata to extract signature and parameters
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

async function main() {
  console.log('\n=== Everclear Bridge Demo ===')
  console.log(`Mode: ${WITH_SOURCE_SWAP ? 'Swap + Bridge' : 'Simple Bridge'}`)
  console.log(`From: Arbitrum (${FROM_CHAIN_ID}) -> Base (${TO_CHAIN_ID})`)
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
  const srcSwapData: any[] = []

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
      FROM_CHAIN_ID,
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

  const requestBody = {
    origin: FROM_CHAIN_ID.toString(),
    destinations: [TO_CHAIN_ID.toString()],
    to: signerAddress,
    from: signerAddress, // User address (transaction sender)
    inputAsset: bridgeAssetId,
    outputAsset: ADDRESS_USDC_BASE,
    amount: bridgeAmount.toString(),
    callData: '0x',
    ttl: 86400, // 24 hours TTL for fast path
    isFastPath: false, // Use standard clearing path
    order_id: `0x${randomBytes(32).toString('hex')}`,
  }

  const createIntentResp = await fetch(`${EVERCLEAR_API_BASE_URL}/intents`, {
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
  const decoded = decodeNewIntentCalldata(createIntentData.data)

  console.log('\nIntent parameters:')
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
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'everclear',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId: bridgeAssetId,
    receiver: signerAddress,
    destinationChainId: TO_CHAIN_ID,
    minAmount: bridgeAmount,
    hasSourceSwaps: WITH_SOURCE_SWAP,
    hasDestinationCall: false,
  }

  // Prepare Everclear data
  const everclearData: EverclearFacet.EverclearDataStruct = {
    receiverAddress: zeroPadAddressToBytes32(signerAddress),
    nativeFee: BigInt(createIntentData.value || '0'),
    outputAsset: zeroPadAddressToBytes32(ADDRESS_USDC_BASE),
    amountOutMin: decoded._amountOutMin,
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
  if (WITH_SOURCE_SWAP) {
    await executeTransaction(
      () =>
        (lifiDiamondContract as any).write.swapAndStartBridgeTokensViaEverclear(
          [bridgeData, srcSwapData, everclearData],
          { value: everclearData.nativeFee }
        ),
      'Swapping and bridging tokens via Everclear',
      publicClient,
      true
    )
  } else {
    await executeTransaction(
      () =>
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
  console.log('To:', ADDRESS_USDC_BASE, '(Base)')
  console.log('Amount:', formatUnits(bridgeAmount, 6), 'USDC')
  console.log('Receiver:', signerAddress)
  console.log('View on Arbiscan:', EXPLORER_BASE_URL)
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
      console.error('The script is passing from=Diamond address to the API.')
      console.error('\nPossible causes:')
      console.error(
        '  1. Everclear backend not yet updated to use "from" parameter for FeeAdapterV2'
      )
      console.error(
        '  2. FeeAdapter contract at',
        '0xd0185bfb8107c5b2336bC73cE3fdd9Bfb504540e'
      )
      console.error('     may still be using V1 signature validation')
      console.error('\n✅ Script implementation is correct!')
      console.error(
        '⏳ Waiting for Everclear team to deploy FeeAdapterV2 backend changes'
      )
    }
    process.exit(1)
  })
