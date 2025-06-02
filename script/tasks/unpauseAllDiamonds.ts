import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import { Address, encodeFunctionData, parseAbi } from 'viem'

import {
  getAllActiveNetworks,
  getContractAddressForNetwork,
  networks,
} from '../utils/viemScriptHelpers'
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
  args: {
    blacklist: {
      type: 'string',
      description: 'Names of the facet(s) to be blacklisted',
    },
  },
  async run({ args }) {
    const blacklist = args.blacklist
    const activeNetworks = getAllActiveNetworks()

    const privateKey = getPrivateKey('SAFE_SIGNER_PRIVATE_KEY')
    const senderAddress = privateKeyToAccount(`0x${privateKey}`).address

    // Connect to MongoDB
    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

    // Execute transactions for all active networks in parallel
    await Promise.all(
      activeNetworks.map(async (network) => {
        try {
          consola.info(`[${network.name}] Processing network now`)

          // get the diamond address for this network
          const diamondAddress = await getContractAddressForNetwork(
            'LiFiDiamond',
            network.name as SupportedChain
          )

          // get blacklisted addresses for this network
          const blacklistedAddresses = await getBlacklistedFacetAddresses(
            network.name,
            blacklist
          )

          // create calldata for unpausing the diamond with blacklisted addresses
          const calldata = encodeFunctionData({
            abi: unpauseDiamondABI,
            functionName: 'unpauseDiamond',
            args: [blacklistedAddresses],
          })

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
              throw new Error(
                `[${network.name}] MongoDB insert was not acknowledged`
              )
            }

            consola.info(
              `[${network.name}] Transaction successfully stored in MongoDB`
            )
          } catch (error) {
            consola.error(
              `[${network.name}] Failed to store transaction in MongoDB: ${error}`
            )
            throw error
          }

          consola.success(`[${network.name}] Transaction proposed`)
        } catch (error) {
          consola.error(
            `[${network.name}] Error proposing unpause transaction:`,
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

async function getBlacklistedFacetAddresses(
  networkName: string,
  blacklistFacets: string
): Promise<Address[]> {
  // if blacklist is empty we dont need to look for addresses
  if (!blacklistFacets) {
    return []
  }

  // make sure that networkName is a valid supported chain
  if (!isValidSupportedChain(networkName))
    throw Error(`'${networkName}' is not a supported network`)

  // Split the string into an array of facet names and trim whitespace
  const facetNames = blacklistFacets.split(',').map((name) => name.trim())

  // Retrieve the corresponding addresses for each facet name from the deploy log
  const facetAddresses: Address[] = []
  for (const facetName of facetNames) {
    try {
      const facetAddress = await getContractAddressForNetwork(
        facetName,
        networkName
      )

      facetAddresses.push(facetAddress as Address)
    } catch (error) {
      consola.error(
        `Error retrieving address for facet "${facetName}" on ${networkName}:`,
        error
      )
    }
  }

  return facetAddresses
}

/**
 * Ensures the network name is a valid SupportedChain
 */
function isValidSupportedChain(network: string): network is SupportedChain {
  return Object.values(networks)
    .map(({ name }) => name)
    .includes(network)
}
runMain(main)
