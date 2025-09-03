#!/usr/bin/env bunx tsx

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import { utils } from 'ethers'

import deployments from '../../deployments/mainnet.staging.json'
import {
  GardenFacet__factory,
  ERC20__factory,
  type ILiFi,
  type GardenFacet,
} from '../../typechain'

import {
  getProvider,
  getWalletFromPrivateKeyInDotEnv,
} from './utils/demoScriptHelpers'

config()

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
    transaction: {
      to: string
      value: string
      data: string
      gas_limit: string
      chain_id: number
    }
    typed_data: {
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
    }
  }
}

const main = defineCommand({
  meta: {
    name: 'demoGarden',
    description:
      'Demo script to bridge USDC from Mainnet to Base using GardenFacet on staging',
  },
  args: {
    amount: {
      type: 'string',
      description: 'Amount of USDC to bridge (in USDC units, e.g., 10 for $10)',
      default: '10',
    },
  },
  run: async ({ args }) => {
    try {
      const LIFI_ADDRESS = deployments.LiFiDiamond
      const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // Mainnet USDC

      // Setup provider and wallet
      const provider = getProvider('mainnet')
      const wallet = getWalletFromPrivateKeyInDotEnv(provider)
      const address = await wallet.getAddress()

      const amountInUsdc = parseFloat(args.amount)
      const amountInWei = utils.parseUnits(args.amount, 6) // USDC has 6 decimals

      consola.info('=== Garden Bridge Demo ===')
      consola.info(`Environment: staging`)
      consola.info(`From: Mainnet`)
      consola.info(`To: Base`)
      consola.info(`Asset: USDC`)
      consola.info(`Amount: ${amountInUsdc} USDC`)
      consola.info(`Wallet Address: ${address}`)
      consola.info(`Diamond: ${LIFI_ADDRESS}`)

      // Step 1: Get quote from Garden API
      consola.info('\n📡 Fetching quote from Garden API...')

      const quoteUrl = `https://api.garden.finance/v2/quote?from=ethereum:usdc&to=base:usdc&from_amount=${amountInWei.toString()}`
      const response = await fetch(quoteUrl)

      if (!response.ok)
        throw new Error(`Failed to fetch quote: ${response.statusText}`)

      const quote: IGardenQuote = await response.json()

      if (quote.status !== 'Ok' || !quote.result || quote.result.length === 0)
        throw new Error('No valid quote received from Garden API')

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
          asset: 'ethereum:usdc',
          owner: address,
          amount: amountInWei.toString(),
        },
        destination: {
          asset: 'base:usdc',
          owner: address, // Same address on destination chain
          amount: selectedQuote.destination.amount,
        },
      }

      const orderResponse = await fetch(
        'https://api.garden.finance/v2/orders',
        {
          method: 'POST',
          headers: {
            'garden-app-id':
              '7648702b1997e55a3763afa5dd7ace3d4bd23348ee0423cc27a18ef3e28cb2b7', // [pre-commit-checker: not a secret]
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
      consola.info(
        `  Redeemer: ${orderData.result.typed_data.message.redeemer}`
      )
      consola.info(
        `  Timelock: ${orderData.result.typed_data.message.timelock}`
      )
      consola.info(
        `  Secret Hash: ${orderData.result.typed_data.message.secretHash}`
      )

      // Step 3: Prepare bridge data using the order response
      const bridgeData: ILiFi.BridgeDataStruct = {
        transactionId: utils.randomBytes(32),
        bridge: 'Garden',
        integrator: 'LiFi-Demo',
        referrer: '0x0000000000000000000000000000000000000000',
        sendingAssetId: USDC_ADDRESS,
        receiver: address,
        minAmount: amountInWei,
        destinationChainId: 8453, // Base chain ID
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }

      // Garden-specific data from the order response
      const gardenData: GardenFacet.GardenDataStruct = {
        redeemer: orderData.result.typed_data.message.redeemer,
        timelock: orderData.result.typed_data.message.timelock,
        secretHash: orderData.result.typed_data.message.secretHash,
      }

      // Step 4: Check and approve USDC
      consola.info('\n💰 Checking USDC balance and approval...')

      const token = ERC20__factory.connect(USDC_ADDRESS, provider)
      const balance = await token.balanceOf(address)

      if (balance.lt(amountInWei))
        throw new Error(
          `Insufficient USDC balance. Required: ${amountInUsdc}, Available: ${utils.formatUnits(
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

      // Step 5: Execute the bridge transaction
      consola.info('\n🚀 Executing bridge transaction...')

      const gardenFacet = GardenFacet__factory.connect(LIFI_ADDRESS, provider)

      const tx = await gardenFacet
        .connect(wallet)
        .startBridgeTokensViaGarden(bridgeData, gardenData, {
          value: 0, // No native token needed for USDC bridge
        })

      consola.info(`Transaction sent: ${tx.hash}`)
      consola.info('Waiting for confirmation...')

      const receipt = await tx.wait()

      if (receipt.status === 1) {
        consola.success(`\n✨ Bridge transaction successful!`)
        consola.info(`Transaction hash: ${tx.hash}`)
        consola.info(`View on Etherscan: https://etherscan.io/tx/${tx.hash}`)
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
