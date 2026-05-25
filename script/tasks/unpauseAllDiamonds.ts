import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { EnvironmentEnum, type SupportedChain } from '../common/types'
import {
  getNextNonce,
  getPrivateKey,
  getSafeInfo,
  getSafeMongoCollection,
  initializeSafeClient,
  OperationTypeEnum,
  storeTransactionInMongoDB,
} from '../deploy/safe/safe-utils'
import {
  castEnv,
  getAllActiveNetworks,
  getContractAddressForNetwork,
  getViemChainForNetworkName,
  isTestnetNetwork,
  networks,
} from '../utils/viemScriptHelpers'

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
    networks: {
      type: 'string',
      description:
        'Optional comma-separated list of network names to process (default: all active networks). Example: --networks gnosis,moonbeam,rootstock',
    },
    environment: {
      type: 'string',
      description:
        'Target environment: production (default) or staging. Staging skips the Safe/MongoDB flow and sends directly to the diamond.',
    },
  },
  async run({ args }) {
    const blacklist = args.blacklist
    const environment = castEnv(args.environment ?? 'production')
    let activeNetworks = getAllActiveNetworks()

    if (args.networks) {
      const requested = new Set(
        args.networks
          .split(',')
          .map((n: string) => n.trim())
          .filter((n) => n.length > 0)
      )
      activeNetworks = activeNetworks.filter((n) => requested.has(n.name))
      const found = new Set(activeNetworks.map((n) => n.name))
      const missing = [...requested].filter((n) => !found.has(n))
      if (missing.length > 0)
        consola.warn(
          `Networks not found in active list (skipped): ${missing.join(', ')}`
        )
      if (activeNetworks.length === 0) {
        consola.error('No matching active networks found. Exiting.')
        process.exit(1)
      }
      consola.info(
        `Restricted to networks: ${activeNetworks
          .map((n) => n.name)
          .join(', ')}`
      )
    }
    const isStaging = environment === EnvironmentEnum.staging
    const testnets = activeNetworks.filter((n) => isTestnetNetwork(n.id))
    // Staging mainnets are EOA-owned — treat them like testnets (direct send, no Safe/Mongo).
    const mainnets = isStaging
      ? []
      : activeNetworks.filter((n) => !isTestnetNetwork(n.id))
    const directSendNetworks = isStaging ? activeNetworks : testnets

    // Pass 1: direct-send networks (testnets always; all networks when staging).
    await Promise.all(
      directSendNetworks.map(async (network) => {
        try {
          consola.info(
            `[${network.name}] Processing ${
              isStaging ? 'staging' : 'testnet'
            } network`
          )
          const diamondAddress = await getContractAddressForNetwork(
            'LiFiDiamond',
            network.name as SupportedChain,
            environment
          )
          const blacklistedAddresses = await getBlacklistedFacetAddresses(
            network.name,
            blacklist,
            environment
          )
          const calldata = encodeFunctionData({
            abi: unpauseDiamondABI,
            functionName: 'unpauseDiamond',
            args: [blacklistedAddresses],
          })
          await sendUnpauseDirect(
            network.name,
            diamondAddress as Address,
            calldata,
            environment
          )
        } catch (error) {
          consola.error(
            `[${network.name}] Error sending direct unpause:`,
            error
          )
        }
      })
    )

    if (mainnets.length === 0) {
      consola.success('All networks processed successfully.')
      process.exit(0)
    }

    // Pass 2: production mainnets — propose to Safe. Initialize Safe / Mongo only now.
    const privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
    const senderAddress = privateKeyToAccount(`0x${privateKey}`).address
    const { client: mongoClient, pendingTransactions } =
      await getSafeMongoCollection()

    await Promise.all(
      mainnets.map(async (network) => {
        try {
          consola.info(`[${network.name}] Processing network now`)

          // get the diamond address for this network
          const diamondAddress = await getContractAddressForNetwork(
            'LiFiDiamond',
            network.name as SupportedChain,
            environment
          )

          // get blacklisted addresses for this network
          const blacklistedAddresses = await getBlacklistedFacetAddresses(
            network.name,
            blacklist,
            environment
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
                operation: OperationTypeEnum.Call,
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

            if (result === null) {
              consola.info(
                `[${network.name}] Proposal already exists - skipping`
              )
            } else if (!result.acknowledged) {
              throw new Error(
                `[${network.name}] MongoDB insert was not acknowledged`
              )
            } else {
              consola.info(
                `[${network.name}] Transaction successfully stored in MongoDB`
              )
              consola.success(`[${network.name}] Transaction proposed`)
            }
          } catch (error) {
            consola.error(
              `[${network.name}] Failed to store transaction in MongoDB: ${error}`
            )
            throw error
          }
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

/**
 * Send the unpause transaction directly to the diamond.
 * Used for testnets (EOA-owned, no Safe/Timelock) and staging environments.
 * Production uses `PRIVATE_KEY_PRODUCTION`; staging uses `PRIVATE_KEY`.
 */
async function sendUnpauseDirect(
  networkName: string,
  diamondAddress: Address,
  calldata: `0x${string}`,
  environment: EnvironmentEnum
): Promise<void> {
  const pkVar =
    environment === EnvironmentEnum.production
      ? 'PRIVATE_KEY_PRODUCTION'
      : 'PRIVATE_KEY'
  const pk = process.env[pkVar]
  if (!pk) throw new Error(`[${networkName}] Missing ${pkVar} in environment`)
  const normalizedPk = pk.startsWith('0x') ? pk : `0x${pk}`
  const account = privateKeyToAccount(normalizedPk as `0x${string}`)
  const chain = getViemChainForNetworkName(networkName)

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  })
  const publicClient = createPublicClient({ chain, transport: http() })

  consola.info(
    `[${networkName}] Sending unpauseDiamond directly to ${diamondAddress}`
  )

  const hash = await walletClient.sendTransaction({
    to: getAddress(diamondAddress),
    data: calldata,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success')
    throw new Error(
      `[${networkName}] unpauseDiamond reverted in block ${receipt.blockNumber}`
    )
  consola.success(
    `[${networkName}] unpauseDiamond confirmed in block ${receipt.blockNumber}`
  )
}

async function getBlacklistedFacetAddresses(
  networkName: string,
  blacklistFacets: string,
  environment: EnvironmentEnum = EnvironmentEnum.production
): Promise<Address[]> {
  // if blacklist is empty we dont need to look for addresses
  if (!blacklistFacets) return []

  // make sure that networkName is a valid supported chain
  if (!isValidSupportedChain(networkName))
    throw Error(`'${networkName}' is not a supported network`)

  // Split the string into an array of facet names and trim whitespace
  const facetNames = blacklistFacets.split(',').map((name) => name.trim())

  // Retrieve the corresponding addresses for each facet name from the deploy log
  const facetAddresses: Address[] = []
  for (const facetName of facetNames)
    try {
      const facetAddress = await getContractAddressForNetwork(
        facetName,
        networkName,
        environment
      )

      facetAddresses.push(facetAddress as Address)
    } catch (error) {
      consola.error(
        `Error retrieving address for facet "${facetName}" on ${networkName}:`,
        error
      )
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
