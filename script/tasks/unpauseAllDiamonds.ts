import { defineCommand, runMain } from 'citty'
import { encodeFunctionData, parseAbi } from 'viem'
import { ethers } from 'ethers6'
import {
  getAllActiveNetworks,
  getContractAddressForNetwork,
  getViemChainForNetworkName,
  networks,
  retry,
} from '../utils/viemScriptHelpers'
import consola from 'consola'
import { MongoClient } from 'mongodb'
import 'dotenv/config'
import {
  OperationType,
  SafeTransactionDataPartial,
} from '@safe-global/safe-core-sdk-types'
import { SupportedChain } from '../demoScripts/utils/demoScriptChainConfig'
const { default: Safe } = await import('@safe-global/protocol-kit')

// Define ABI
const unpauseDiamondABI = parseAbi([
  'function unpauseDiamond(address[] calldata _blacklist) external',
])

const main = defineCommand({
  meta: {
    name: 'unpauseAllDiamonds',
    description:
      'Proposes a transaction to unpause the diamond (without changes) on all active networks',
  },
  async run() {
    const activeNetworks = getAllActiveNetworks()

    // Get private key from .env
    if (!process.env.SAFE_SIGNER_PRIVATE_KEY) {
      throw new Error(
        'SAFE_SIGNER_PRIVATE_KEY environment variable is required'
      )
    }
    const privateKey = process.env.SAFE_SIGNER_PRIVATE_KEY

    // Set up MongoDB client
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required')
    }
    const mongoClient = new MongoClient(process.env.MONGODB_URI)
    await mongoClient.connect()
    const db = mongoClient.db('SAFE')
    const pendingTransactions = db.collection('pendingTransactions')

    // create calldata for unpausing the diamond with an empty blacklist
    const calldata = encodeFunctionData({
      abi: unpauseDiamondABI,
      functionName: 'unpauseDiamond',
      args: [[]], // Empty array for `_blacklist`
    })

    // Execute transactions for all active networks in parallel
    await Promise.all(
      activeNetworks.map(async (network) => {
        try {
          consola.info(`Processing network: ${network.name}`) // <-- Using key instead of network.name

          // get the diamond address for this network
          const diamondAddress = await getContractAddressForNetwork(
            'LiFiDiamond',
            network.name as SupportedChain
          )

          // Get chain configuration
          const chain = getViemChainForNetworkName(network.name)
          if (!chain) {
            throw new Error(`No chain found for network: ${network.name}`)
          }

          // Get Safe address
          const safeAddress = networks[network.name]?.safeAddress
          if (!safeAddress) {
            throw new Error(
              `No Safe address found for network: ${network.name}`
            )
          }

          // Set up provider and signer
          const rpcUrl = chain.rpcUrls.default.http[0]
          const provider = new ethers.JsonRpcProvider(rpcUrl)
          const signer = new ethers.Wallet(privateKey, provider)
          const senderAddress = await signer.getAddress()

          // Initialize Safe Protocol Kit
          let protocolKit: Safe
          try {
            protocolKit = await Safe.init({
              provider: rpcUrl,
              signer: privateKey,
              safeAddress,
            })
            consola.success(`Safe initialized for ${network.name}`)
          } catch (error) {
            consola.error(
              `Failed to initialize Safe for ${network.name}:`,
              error
            )
            return
          }

          // Get latest pending transaction for this SAFE, if exists
          const latestTx = await pendingTransactions
            .find({
              safeAddress,
              network: network.name,
              chainId: chain.id,
              status: 'pending',
            })
            .sort({ nonce: -1 })
            .limit(1)
            .toArray()

          // get a valid nonce
          const nextNonce =
            latestTx.length > 0
              ? (latestTx[0].safeTx?.data?.nonce || latestTx[0].data?.nonce) + 1
              : await protocolKit.getNonce()

          // prepare SAFE transaction
          const safeTransactionData: SafeTransactionDataPartial = {
            to: diamondAddress,
            value: '0',
            data: calldata,
            operation: OperationType.Call,
            nonce: nextNonce,
          }
          let safeTransaction = await protocolKit.createTransaction({
            transactions: [safeTransactionData],
          })

          // sign transaction with SAFE_SIGNER_PRIVATE_KEY
          safeTransaction = await protocolKit.signTransaction(safeTransaction)
          const safeTxHash = await protocolKit.getTransactionHash(
            safeTransaction
          )

          // Store transaction proposal in MongoDB
          try {
            const txDoc = {
              safeAddress: await protocolKit.getAddress(),
              network: network.name,
              chainId: chain.id,
              safeTx: safeTransaction,
              safeTxHash,
              proposer: senderAddress,
              timestamp: new Date(),
              status: 'pending',
            }

            // const result = await retry(async () => {
            //   const insertResult = await pendingTransactions.insertOne(txDoc)
            //   return insertResult
            // })

            // if (!result.acknowledged) {
            //   throw new Error('MongoDB insert was not acknowledged')
            // }

            console.log(
              `tx data to be pushed: ${JSON.stringify(txDoc, null, 2)}`
            )

            consola.info('Transaction successfully stored in MongoDB')
          } catch (error) {
            consola.error('Failed to store transaction in MongoDB:', error)
            throw error
          }

          consola.success(`Transaction proposed for ${network.name}`)
          console.log('')
          console.log('')
        } catch (error) {
          consola.error(
            `Error proposing unpause transaction for network ${network.name}:`,
            error
          )
        }
      })
    )

    await mongoClient.close()
    consola.success('All networks processed successfully.')

    process.exit(0)
  },
})

runMain(main)
