#!/usr/bin/env bun

import { parseUnits, createWalletClient, http, getContract, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { ethers } from 'ethers'
import { SupportedChainId, OrderKind, TradingSdk } from '@cowprotocol/cow-sdk'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import { setupCowShedPostHooks } from './utils/cowSwapHelpers'

const ARBITRUM_WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
import arbitrumDeployments from '../../deployments/arbitrum.staging.json'
const LIFI_DIAMOND_ARBITRUM = arbitrumDeployments.LiFiDiamond
const PATCHER_ARBITRUM = arbitrumDeployments.Patcher
const VAULT_RELAYER_ARBITRUM = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

const ERC20_ABI = erc20Artifact.abi

/**
 * Main function to execute the demo
 *
 * Note: There are several TypeScript errors related to the `0x${string}` type
 * that don't affect the functionality of the script. In a production environment,
 * these should be fixed with proper type assertions.
 */
async function main(options: { privateKey: string; dryRun: boolean }) {
  try {
    consola.start('Starting CowSwap with Patcher demo')

    // Set up wallet client
    const account = privateKeyToAccount(options.privateKey as Hex)
    const walletClient = createWalletClient({
      chain: arbitrum,
      transport: http(),
      account,
    })

    const walletAddress = account.address
    consola.info(`Connected wallet: ${walletAddress}`)

    // Amount to swap: 0.001 WETH
    const swapAmount = parseUnits('0.001', 18)
    consola.info(`Swap amount: 0.001 WETH`)

    // Check WETH balance and approve if needed
    const wethContract = getContract({
      address: ARBITRUM_WETH as Hex,
      abi: ERC20_ABI,
      client: { public: walletClient, wallet: walletClient },
    })

    const wethBalance = (await wethContract.read.balanceOf([
      walletAddress,
    ])) as bigint
    consola.info(`WETH balance: ${wethBalance}`)

    if (wethBalance < swapAmount) {
      consola.error(`Insufficient WETH balance. Need at least 0.001 WETH.`)
      process.exit(1)
    }

    // Check allowance
    const allowance = (await wethContract.read.allowance([
      walletAddress,
      VAULT_RELAYER_ARBITRUM,
    ])) as bigint
    consola.info(`Current allowance: ${allowance}`)

    if (allowance < swapAmount) {
      consola.info('Approving WETH for CoW Protocol VaultRelayer...')
      if (!options.dryRun) {
        const approveTx = await wethContract.write.approve([
          VAULT_RELAYER_ARBITRUM as `0x${string}`,
          BigInt(
            '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
          ), // Max uint256
        ])
        consola.success(`Approval transaction sent: ${approveTx}`)
      } else {
        consola.info(`[DRY RUN] Would approve WETH for VaultRelayer`)
      }
    }

    // Set up CowShed post hooks
    const { shedDeterministicAddress, postHooks } = await setupCowShedPostHooks(
      {
        chainId: 42161, // Arbitrum chain ID
        walletClient,
        usdcAddress: ARBITRUM_USDC,
        receivedAmount: parseUnits('0', 6), // This will be dynamically patched
        lifiDiamondAddress: LIFI_DIAMOND_ARBITRUM,
        patcherAddress: PATCHER_ARBITRUM,
        baseUsdcAddress: BASE_USDC,
        destinationChainId: 8453n, // BASE chain ID
      }
    )

    // Create ethers provider and signer for CoW SDK
    const provider = new ethers.providers.JsonRpcProvider(
      arbitrum.rpcUrls.default.http[0]
    )
    const ethersSigner = new ethers.Wallet(options.privateKey, provider)

    // Initialize CoW SDK with proper TraderParameters
    const cowSdk = new TradingSdk({
      chainId: SupportedChainId.ARBITRUM_ONE,
      signer: ethersSigner,
      appCode: 'lifi-demo' as any, // Cast to any to satisfy the AppCode type
    })

    // Create the order parameters
    const parameters = {
      kind: OrderKind.SELL,
      sellToken: ARBITRUM_WETH as `0x${string}`,
      sellTokenDecimals: 18,
      buyToken: ARBITRUM_USDC as `0x${string}`,
      buyTokenDecimals: 6,
      amount: swapAmount.toString(),
      receiver: shedDeterministicAddress as `0x${string}`, // Important: Set the receiver to the CowShed proxy
      validFor: 30 * 60, // 30 minutes in seconds
      slippageBps: 50, // 0.5% slippage
    }

    // Create advanced settings with post hooks
    const advancedSettings = {
      appData: {
        metadata: {
          hooks: {
            version: '1',
            pre: [],
            post: postHooks,
          },
        },
      },
    }

    // Submit the order with post hooks
    if (!options.dryRun) {
      consola.info('Submitting order to CowSwap...')
      try {
        // Create an AbortController for proper cancellation
        const abortController = new AbortController()
        const timeoutId = setTimeout(() => {
          abortController.abort()
        }, 30000)

        try {
          const orderId = await cowSdk.postSwapOrder(
            parameters,
            advancedSettings
          )
          clearTimeout(timeoutId)

          consola.success(`Order created with hash: ${orderId}`)
          consola.info(
            `Explorer URL: https://explorer.cow.fi/orders/${orderId}?chainId=42161`
          )
        } catch (error) {
          clearTimeout(timeoutId)
          if (abortController.signal.aborted) {
            throw new Error('Order submission timed out after 30 seconds')
          }
          throw error
        }
      } catch (error) {
        consola.error('Error submitting order to CowSwap:', error)
        throw error
      }
    } else {
      consola.info(`[DRY RUN] Would submit order to CowSwap with post hooks`)
      consola.info(`Parameters: ${JSON.stringify(parameters, null, 2)}`)
      consola.info(`Post hooks: ${JSON.stringify(postHooks, null, 2)}`)
    }

    consola.success('Demo completed successfully')
  } catch (error) {
    consola.error('Error executing demo:', error)
    process.exit(1)
  }
}

// CLI command definition
const cmd = defineCommand({
  meta: {
    name: 'demoPatcher',
    description: 'Demo script for CowSwap with Patcher contract',
  },
  args: {
    privateKey: {
      type: 'string',
      description: 'Private key for the wallet',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without submitting transactions',
      default: false,
    },
  },
  run: async ({ args }) => {
    await main(args)
  },
})

// Run the command
runMain(cmd)
