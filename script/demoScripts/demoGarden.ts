#!/usr/bin/env bunx tsx

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import { utils, BigNumber } from 'ethers'

import deployments from '../../deployments/mainnet.staging.json'
import {
  GardenFacet__factory,
  ERC20__factory,
  type ILiFi,
  type GardenFacet,
} from '../../typechain'
import type { LibSwap } from '../../typechain/GardenFacet'

import {
  getProvider,
  getWalletFromPrivateKeyInDotEnv,
  getUniswapDataERC20toExactERC20,
  ensureBalanceAndAllowanceToDiamond,
} from './utils/demoScriptHelpers'

config()

// Example successful transaction hashes
// Native ETH bridge (ETH -> USDC on Base): https://app.blocksec.com/explorer/tx/eth/0x82f4d880a6b55437666a25c013885c7ef7f8837d56c395bd9b58c6d1aba4901f
// ERC20 (USDC) simple bridge: https://app.blocksec.com/explorer/tx/eth/0xaab5b62dc46dbe61d452598643bda901dbfc51166a2578ef15c5ded9451895a7
// Swap and bridge (WETH -> USDC): https://app.blocksec.com/explorer/tx/eth/0x51f7703bb6d6bf49304499347ba79510c0bcae8386cdff9853a20130c420cd83

// Garden App ID
// This is a TEST identifier used to authenticate requests to the Garden API.
// Each integration partner (like LI.FI) receives their own app ID.
// The backend team will need to use their own production ID for production integration.
// Note: This is a test ID - production will use a different ID.
const GARDEN_APP_ID =
  '7648702b1997e55a3763afa5dd7ace3d4bd23348ee0423cc27a18ef3e28cb2b7'

// Garden API types
interface IGardenQuote {
  status: string
  result: Array<{
    source: {
      asset: string
      amount: string
      display: string
      value: string
    }
    destination: {
      asset: string
      amount: string
      display: string
      value: string
    }
    solver_id: string
  }>
}

interface IGardenOrderResponse {
  status: string
  result: {
    order_id: string
    approval_transaction?: {
      to: string
      value: string
      data: string
      gas_limit: string
      chain_id: number
    } | null
    initiate_transaction: {
      to: string
      value: string
      data: string
      gas_limit: string
      chain_id: number
    }
    typed_data?: {
      domain: {
        name: string
        version: string
        chainId: string
        verifyingContract: string
      }
      primaryType: string
      types: Record<string, Array<{ name: string; type: string }>>
      message: {
        redeemer: string
        timelock: string
        amount: string
        secretHash: string
      }
    } | null
  }
}

const main = defineCommand({
  meta: {
    name: 'demoGarden',
    description:
      'Demo script to bridge tokens from Mainnet to Base using GardenFacet on staging',
  },
  args: {
    amount: {
      type: 'string',
      description:
        'Amount to bridge (in token units, e.g., 10 for $10 USDC or 0.01 for ETH)',
      default: '10',
    },
    swap: {
      type: 'boolean',
      description: 'Perform a swap before bridging (WETH -> USDC)',
      default: false,
    },
    native: {
      type: 'boolean',
      description: 'Bridge native ETH instead of USDC',
      default: false,
    },
  },
  run: async ({ args }) => {
    try {
      const LIFI_ADDRESS = deployments.LiFiDiamond
      const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // Mainnet USDC
      const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // Mainnet WETH
      const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // Mainnet Uniswap
      const NULL_ADDRESS = '0x0000000000000000000000000000000000000000' // For native ETH

      // Setup provider and wallet
      const provider = getProvider('mainnet')
      const wallet = getWalletFromPrivateKeyInDotEnv(provider)
      const address = await wallet.getAddress()

      const isNative = args.native
      const withSwap = args.swap
      const amountStr = args.amount

      // Validate conflicting options
      if (isNative && withSwap) 
        throw new Error('Please choose only one option: --native or --swap')
      

      // Parse amount based on token type
      const amountInWei = isNative
        ? utils.parseUnits(amountStr, 18) // ETH has 18 decimals
        : utils.parseUnits(amountStr, 6) // USDC has 6 decimals

      consola.info('=== Garden Bridge Demo ===')
      consola.info(`Environment: staging`)
      consola.info(`Mode: ${withSwap ? 'Swap and Bridge' : 'Bridge only'}`)
      consola.info(`From: Mainnet`)
      consola.info(`To: Base`)
      consola.info(
        `Asset: ${
          isNative
            ? 'ETH -> USDC (converted on destination)'
            : withSwap
            ? 'WETH -> USDC'
            : 'USDC'
        }`
      )
      consola.info(`Amount: ${amountStr} ${isNative ? 'ETH' : 'USDC'}`)
      consola.info(`Wallet Address: ${address}`)
      consola.info(`Diamond: ${LIFI_ADDRESS}`)

      // Prepare swap data if needed
      let swapData: LibSwap.SwapDataStruct[] = []
      let inputAmount = amountInWei

      if (withSwap) {
        consola.info('\n🔄 Preparing swap data (WETH -> USDC)...')

        // Use the helper that calculates exact input for exact output
        const swapDataItem = await getUniswapDataERC20toExactERC20(
          UNISWAP_ADDRESS,
          1, // Mainnet chain ID
          WETH_ADDRESS,
          USDC_ADDRESS,
          amountInWei, // Exact USDC output we want
          LIFI_ADDRESS,
          true, // requiresDeposit
          Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour deadline
        )

        swapData = [swapDataItem]
        inputAmount = BigNumber.from(swapDataItem.fromAmount) // The amount of WETH needed (with slippage)

        consola.info(
          `Swap prepared: ${utils.formatUnits(
            inputAmount,
            18
          )} WETH (max with slippage) -> ${amountStr} USDC (exact)`
        )

        // Check WETH balance and approval
        consola.info('\n💰 Checking WETH balance and approval...')
        await ensureBalanceAndAllowanceToDiamond(
          WETH_ADDRESS,
          wallet,
          LIFI_ADDRESS,
          inputAmount,
          false
        )
      }

      // Step 1: Get quote from Garden API
      consola.info('\n📡 Fetching quote from Garden API...')

      // Note: When bridging native ETH, it's converted to USDC on destination
      const fromAsset = isNative ? 'ethereum:eth' : 'ethereum:usdc'
      const toAsset = 'base:usdc' // Always USDC on destination (no native ETH on non-Ethereum chains)
      const quoteUrl = `https://api.garden.finance/v2/quote?from=${fromAsset}&to=${toAsset}&from_amount=${amountInWei.toString()}`

      consola.info(`Quote URL: ${quoteUrl}`)
      const response = await fetch(quoteUrl)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to fetch quote: ${response.statusText} - ${errorText}`
        )
      }

      const quote: IGardenQuote = await response.json()

      if (quote.status !== 'Ok' || !quote.result || quote.result.length === 0) {
        consola.error('Garden API response:', JSON.stringify(quote, null, 2))
        throw new Error('No valid quote received from Garden API')
      }

      const selectedQuote = quote.result[0]
      if (!selectedQuote) throw new Error('No quote selected')

      consola.success(`Quote received:`)
      consola.info(
        `  Input: ${selectedQuote.source.display} ${selectedQuote.source.asset
          .split(':')[1]
          ?.toUpperCase()}`
      )
      consola.info(
        `  Output: ${
          selectedQuote.destination.display
        } ${selectedQuote.destination.asset.split(':')[1]?.toUpperCase()}`
      )
      consola.info(`  Solver: ${selectedQuote.solver_id}`)

      // Step 2: Submit order to Garden API
      consola.info('\n📝 Submitting order to Garden...')

      const orderPayload = {
        source: {
          asset: fromAsset,
          owner: address,
          amount: amountInWei.toString(),
        },
        destination: {
          asset: toAsset, // Always USDC on destination
          owner: address, // Same address on destination chain
          amount: selectedQuote.destination.amount,
        },
      }

      const orderResponse = await fetch(
        'https://api.garden.finance/v2/orders',
        {
          method: 'POST',
          headers: {
            'garden-app-id': GARDEN_APP_ID,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(orderPayload),
        }
      )

      if (!orderResponse.ok) {
        const errorText = await orderResponse.text()
        throw new Error(
          `Failed to submit order: ${orderResponse.statusText} - ${errorText}`
        )
      }

      const orderData: IGardenOrderResponse = await orderResponse.json()

      if (orderData.status !== 'Ok' || !orderData.result)
        throw new Error('Failed to create order with Garden')

      consola.success(`Order created: ${orderData.result.order_id}`)

      // The API returns transaction data for initiate function
      // Function signature: initiate(address,uint256,uint256,bytes32)
      // Parameters: redeemer, timelock, amount, secretHash

      const txData = orderData.result.initiate_transaction.data
      const functionSelector = txData.slice(0, 10)
      consola.info(`Function selector: ${functionSelector}`)

      // Skip the function selector (first 10 chars including 0x)
      const encodedParams = '0x' + txData.slice(10)

      let redeemer, timelock, amount, secretHash

      try {
        // Decode initiate(address,uint256,uint256,bytes32)
        const decodedParams = utils.defaultAbiCoder.decode(
          ['address', 'uint256', 'uint256', 'bytes32'],
          encodedParams
        )
        ;[redeemer, timelock, amount, secretHash] = decodedParams

        consola.info(`  Redeemer: ${redeemer}`)
        consola.info(`  Timelock: ${timelock.toString()}`)
        consola.info(
          `  Amount: ${
            isNative
              ? utils.formatEther(amount) + ' ETH'
              : utils.formatUnits(amount, 6) + ' USDC'
          }`
        )
        consola.info(`  Secret Hash: ${secretHash}`)
      } catch (error) {
        consola.warn('Failed to decode transaction parameters:', error)
        // Use fallback values for testing
        redeemer = address // Use sender as redeemer
        timelock = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
        secretHash = '0x' + orderData.result.order_id.padEnd(64, '0') // Use order ID as secret hash

        consola.info(`  Using fallback values:`)
        consola.info(`  Redeemer: ${redeemer}`)
        consola.info(`  Timelock: ${timelock}`)
        consola.info(`  Secret Hash: ${secretHash}`)
      }

      // Step 3: Prepare bridge data using the order response
      const bridgeData: ILiFi.BridgeDataStruct = {
        transactionId: utils.randomBytes(32),
        bridge: 'Garden',
        integrator: 'LiFi-Demo',
        referrer: '0x0000000000000000000000000000000000000000',
        sendingAssetId: isNative ? NULL_ADDRESS : USDC_ADDRESS,
        receiver: address,
        minAmount: amountInWei,
        destinationChainId: 8453, // Base chain ID
        hasSourceSwaps: withSwap,
        hasDestinationCall: false,
      }

      // Garden-specific data extracted from the transaction
      const gardenData: GardenFacet.GardenDataStruct = {
        redeemer: redeemer,
        timelock: timelock.toString(),
        secretHash: secretHash,
      }

      // Step 4: If not swapping, check balance and approve tokens if needed
      if (!withSwap) 
        if (isNative) {
          consola.info('\n💰 Checking ETH balance...')

          const balance = await provider.getBalance(address)

          if (balance.lt(amountInWei))
            throw new Error(
              `Insufficient ETH balance. Required: ${amountStr}, Available: ${utils.formatUnits(
                balance,
                18
              )}`
            )

          consola.info(`Balance: ${utils.formatUnits(balance, 18)} ETH`)
        } else {
          consola.info('\n💰 Checking USDC balance and approval...')

          const token = ERC20__factory.connect(USDC_ADDRESS, provider)
          const balance = await token.balanceOf(address)

          if (balance.lt(amountInWei))
            throw new Error(
              `Insufficient USDC balance. Required: ${amountStr}, Available: ${utils.formatUnits(
                balance,
                6
              )}`
            )

          consola.info(`Balance: ${utils.formatUnits(balance, 6)} USDC`)

          const allowance = await token.allowance(address, LIFI_ADDRESS)
          if (allowance.lt(amountInWei)) {
            consola.info('Approving USDC...')
            const approveTx = await token
              .connect(wallet)
              .approve(LIFI_ADDRESS, amountInWei)
            await approveTx.wait()
            consola.success('USDC approved')
          } else consola.info('Sufficient allowance already exists')
        }
      

      // Step 5: Execute the bridge transaction
      consola.info('\n🚀 Executing bridge transaction...')

      const gardenFacet = GardenFacet__factory.connect(LIFI_ADDRESS, provider)

      let tx
      if (withSwap) {
        consola.info('Using swapAndStartBridgeTokensViaGarden...')
        tx = await gardenFacet
          .connect(wallet)
          .swapAndStartBridgeTokensViaGarden(bridgeData, swapData, gardenData, {
            value: 0, // No native token needed for swaps (WETH is ERC20)
          })
      } else {
        consola.info('Using startBridgeTokensViaGarden...')
        const txValue = isNative ? amountInWei : 0
        tx = await gardenFacet
          .connect(wallet)
          .startBridgeTokensViaGarden(bridgeData, gardenData, {
            value: txValue, // Send native ETH if bridging native
          })
      }

      consola.info(`Transaction sent: ${tx.hash}`)
      consola.info('Waiting for confirmation...')

      const receipt = await tx.wait()

      if (receipt.status === 1) {
        consola.success(`\n✨ Bridge transaction successful!`)
        consola.info(`Transaction hash: ${tx.hash}`)
        consola.info(`View on Etherscan: https://etherscan.io/tx/${tx.hash}`)
        if (withSwap) 
          consola.info(
            `Successfully swapped WETH to USDC and initiated bridge to Base`
          )
         else if (isNative) 
          consola.info(
            `Successfully initiated ETH to USDC bridge to Base (ETH will be converted to USDC on destination)`
          )
         else 
          consola.info(`Successfully initiated USDC bridge to Base`)
        

        consola.info(
          "\nNote: The bridge process will continue on Garden's infrastructure."
        )
        consola.info(
          "You can track the progress using the transaction hash on Garden's dashboard."
        )
      } else throw new Error('Transaction failed')
    } catch (error) {
      consola.error('Error executing Garden bridge:', error)
      process.exit(1)
    }
  },
})

runMain(main)
