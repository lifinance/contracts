import { defineCommand, runMain } from 'citty'
import { Address, encodeFunctionData, parseAbi } from 'viem'
import {
  getAllActiveNetworks,
  getContractAddressForNetwork,
} from '../utils/viemScriptHelpers'
import consola from 'consola'
import 'dotenv/config'
import { SupportedChain } from '../demoScripts/utils/demoScriptChainConfig'
import {
  getNextNonce,
  getPrivateKey,
  getSafeInfo,
  getSafeMongoCollection,
  initializeSafeClient,
  OperationType,
  storeTransactionInMongoDB,
} from '../deploy/safe/safe-utils'
import { privateKeyToAccount } from 'viem/accounts'

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

    const privateKey = getPrivateKey('SAFE_SIGNER_PRIVATE_KEY')
    const senderAddress = privateKeyToAccount(`0x${privateKey}`).address

    // Connect to MongoDB
    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

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

          // initialize the SAFE client that we use for signing and preparing transaction data
          const { safe, chain, safeAddress } = await initializeSafeClient(
            network.name,
            privateKey
          )

          // Get Safe information directly from the contract
          const safeInfo = await getSafeInfo(safeAddress, network.name)

          // get a valid nonce
          const nextNonce = await getNextNonce(
            pendingTransactions,
            safeAddress,
            network.name,
            chain.id,
            safeInfo.nonce
          )

          // prepare SAFE transaction
          const safeTransaction = await safe.createTransaction({
            transactions: [
              {
                to: diamondAddress as Address,
                value: 0n,
                data: calldata,
                operation: OperationType.Call,
                nonce: nextNonce,
              },
            ],
          })

          // sign transaction with SAFE_SIGNER_PRIVATE_KEY
          const signedTx = await safe.signTransaction(safeTransaction)
          const safeTxHash = await safe.getTransactionHash(safeTransaction)

          // Store transaction proposal in MongoDB
          try {
            const result = await storeTransactionInMongoDB(
              pendingTransactions,
              safeAddress,
              network.name,
              chain.id,
              signedTx,
              safeTxHash,
              senderAddress
            )

            if (!result.acknowledged) {
              throw new Error('MongoDB insert was not acknowledged')
            }

            consola.info('Transaction successfully stored in MongoDB')
          } catch (error) {
            consola.error('Failed to store transaction in MongoDB:', error)
            throw error
          }

          consola.success(`Transaction proposed for ${network.name}`)
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
