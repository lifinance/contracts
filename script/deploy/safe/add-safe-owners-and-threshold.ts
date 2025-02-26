import { defineCommand, runMain } from 'citty'
import { type SafeApiKitConfig } from '@safe-global/api-kit'
import { getAddress } from 'viem'
import { EthersAdapter } from '@safe-global/protocol-kit'
const { default: SafeApiKit } = await import('@safe-global/api-kit')
const { default: Safe } = await import('@safe-global/protocol-kit')
import { ethers } from 'ethers6'
import { getSafeUtilityContracts } from './config'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'
import globalConfig from '../../../config/global.json'
import * as dotenv from 'dotenv'
import { SafeTransaction } from '@safe-global/safe-core-sdk-types'
dotenv.config()

const networks: NetworksObject = data as NetworksObject

const main = defineCommand({
  meta: {
    name: 'add-safe-owners-and-threshold',
    description:
      'Adds all SAFE owners from global.json to the SAFE address in networks.json and sets threshold to 3',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
    },
  },
  async run({ args }) {
    const { network, privateKey: privateKeyArg } = args

    const chain = getViemChainForNetworkName(network)

    const config: SafeApiKitConfig = {
      chainId: BigInt(chain.id),
      txServiceUrl: networks[network].safeApiUrl,
    }

    const privateKey = String(
      privateKeyArg || process.env.PRIVATE_KEY_PRODUCTION
    )

    if (!privateKey)
      throw new Error(
        'Private key is missing, either provide it as argument or add PRIVATE_KEY_PRODUCTION to your .env'
      )

    console.info('Setting up connection to SAFE API')

    const safeService = new SafeApiKit(config)

    const safeAddress = getAddress(networks[network].safeAddress)

    const rpcUrl = chain.rpcUrls.default.http[0] || args.rpcUrl

    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const signer = new ethers.Wallet(privateKey, provider)

    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    })

    const protocolKit = await Safe.create({
      ethAdapter,
      safeAddress: safeAddress,
      contractNetworks: getSafeUtilityContracts(chain.id),
    })

    const owners = globalConfig.safeOwners

    let nextNonce = await safeService.getNextNonce(safeAddress)
    const currentThreshold = (await safeService.getSafeInfo(safeAddress))
      ?.threshold
    if (!currentThreshold)
      throw new Error('Could not get current signature threshold')

    console.info('Safe Address', safeAddress)
    const senderAddress = await signer.getAddress()
    console.info('Signer Address', senderAddress)

    // go through all owner addresses and add each of them individually
    for (const o of owners) {
      console.info('-'.repeat(80))
      const owner = getAddress(o)
      const existingOwners = await protocolKit.getOwners()
      if (existingOwners.includes(owner)) {
        console.info('Owner already exists', owner)
        continue
      }

      const safeTransaction = await protocolKit.createAddOwnerTx(
        {
          ownerAddress: owner,
          threshold: currentThreshold,
        },
        {
          nonce: nextNonce,
        }
      )

      console.info('Adding owner', owner)

      await submitAndExecuteTransaction(
        protocolKit,
        safeService,
        safeTransaction,
        senderAddress
      )
      nextNonce++
    }

    console.info('-'.repeat(80))

    if (currentThreshold != 3) {
      console.info('Now changing threshold from 1 to 3')
      const changeThresholdTx = await protocolKit.createChangeThresholdTx(3)
      await submitAndExecuteTransaction(
        protocolKit,
        safeService,
        changeThresholdTx,
        senderAddress
      )
    } else console.log('Threshold is already set to 3 - no action required')

    console.info('-'.repeat(80))
    console.info('Script completed without errors')
  },
})

async function submitAndExecuteTransaction(
  protocolKit: any,
  safeService: any,
  safeTransaction: SafeTransaction,
  senderAddress: string
): Promise<string> {
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
  const signature = await protocolKit.signHash(safeTxHash)

  // Propose the transaction
  await safeService.proposeTransaction({
    safeAddress: await protocolKit.getAddress(),
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress,
    senderSignature: signature.data,
  })

  console.info('Transaction proposed:', safeTxHash)

  // Execute the transaction immediately
  try {
    const execResult = await protocolKit.executeTransaction(safeTransaction)
    const receipt = await execResult.transactionResponse?.wait()
    if (receipt?.status === 0) {
      throw new Error('Transaction failed')
    }
    console.info('Transaction executed:', safeTxHash)
  } catch (error) {
    console.error('Transaction execution failed:', error)
    throw error
  }

  return safeTxHash
}

runMain(main)
