import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import type { Chain } from 'viem'
import { MongoClient } from 'mongodb'
const { default: Safe } = await import('@safe-global/protocol-kit')
import { ethers } from 'ethers6'
import {
  OperationType,
  type SafeTransactionDataPartial,
} from '@safe-global/safe-core-sdk-types'
import * as chains from 'viem/chains'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'
const networks: NetworksObject = data as NetworksObject
import consola from 'consola'

/**
 * Retries a function multiple times if it fails
 * @param func - The async function to retry
 * @param retries - Number of retries remaining
 * @returns The result of the function
 */
const retry = async <T>(func: () => Promise<T>, retries = 3): Promise<T> => {
  try {
    const result = await func()
    return result
  } catch (e) {
    consola.error('Error details:', {
      error: e,
      remainingRetries: retries - 1,
    })
    if (retries > 0) {
      return retry(func, retries - 1)
    }
    throw e
  }
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

/**
 * Main command definition for proposing transactions to a Safe
 */
const main = defineCommand({
  meta: {
    name: 'propose-to-safe',
    description: 'Propose a transaction to a Gnosis Safe',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL',
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
      required: true,
    },
    to: {
      type: 'string',
      description: 'To address',
      required: true,
    },
    calldata: {
      type: 'string',
      description: 'Calldata',
      required: true,
    },
  },
  /**
   * Executes the propose-to-safe command
   * @param args - Command arguments including network, rpcUrl, privateKey, to address, and calldata
   */
  async run({ args }) {
    const chain = getViemChainForNetworkName(args.network)

    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required')
    }

    const mongoClient = new MongoClient(process.env.MONGODB_URI)
    const db = mongoClient.db('SAFE')
    const pendingTransactions = db.collection('pendingTransactions')

    const safeAddress = networks[args.network.toLowerCase()].safeAddress

    const rpcUrl = args.rpcUrl || chain.rpcUrls.default.http[0]
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const signer = new ethers.Wallet(args.privateKey, provider)

    let protocolKit: Safe
    try {
      protocolKit = await Safe.init({
        provider: rpcUrl,
        signer: args.privateKey,
        safeAddress,
      })
    } catch (error) {
      console.error('Failed to initialize Safe protocol kit:', error)
      throw error
    }

    const latestTx = await pendingTransactions
      .find({
        safeAddress,
        network: args.network.toLowerCase(),
        chainId: chain.id,
        status: 'pending',
      })
      .sort({ nonce: -1 })
      .limit(1)
      .toArray()

    const nextNonce =
      latestTx.length > 0 ? latestTx[0].nonce + 1 : await protocolKit.getNonce()
    const safeTransactionData: SafeTransactionDataPartial = {
      to: args.to,
      value: '0',
      data: args.calldata,
      operation: OperationType.Call,
      nonce: nextNonce,
    }

    let safeTransaction = await protocolKit.createTransaction({
      transactions: [safeTransactionData],
    })

    const senderAddress = await signer.getAddress()
    safeTransaction = await protocolKit.signTransaction(safeTransaction)
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)

    console.info('Signer Address', senderAddress)
    console.info('Safe Address', safeAddress)
    console.info('Network', chain.name)
    console.info('Proposing transaction to', args.to)

    // Store transaction in MongoDB
    try {
      const txDoc = {
        safeAddress: await protocolKit.getAddress(),
        network: args.network.toLowerCase(),
        chainId: chain.id,
        safeTx: safeTransaction,
        safeTxHash,
        proposer: senderAddress,
        timestamp: new Date(),
        status: 'pending',
      }

      const result = await retry(async () => {
        const insertResult = await pendingTransactions.insertOne(txDoc)
        return insertResult
      })

      if (!result.acknowledged) {
        throw new Error('MongoDB insert was not acknowledged')
      }

      console.info('Transaction successfully stored in MongoDB')
    } catch (error) {
      console.error('Failed to store transaction in MongoDB:', error)
      throw error
    } finally {
      await mongoClient.close()
    }

    console.info('Transaction proposed')
  },
})

runMain(main)
