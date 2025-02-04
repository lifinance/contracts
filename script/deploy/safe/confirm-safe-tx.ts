import { defineCommand, runMain } from 'citty'
import { Abi, Chain, Hex, decodeFunctionData, parseAbi } from 'viem'
import Safe from '@safe-global/protocol-kit'
import { MongoClient } from 'mongodb'
import { ethers } from 'ethers6'
import consola from 'consola'
import * as chains from 'viem/chains'
import {
  NetworksObject,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import * as dotenv from 'dotenv'
import { SafeTransaction } from '@safe-global/safe-core-sdk-types'
import networksConfig from '../../../config/networks.json'
dotenv.config()

interface SafeTxDocument {
  safeAddress: string
  network: string
  chainId: number
  safeTx: {
    data: {
      to: string
      value: string
      data: string
      operation: number
      nonce: number
    }
    signatures?: Record<
      string,
      {
        signer: string
        data: string
      }
    >
  }
  safeTxHash: string
  proposer: string
  timestamp: Date
  status: 'pending' | 'executed'
}

interface AugmentedSafeTxDocument extends SafeTxDocument {
  safeTransaction: SafeTransaction
  hasSignedAlready: boolean
  canExecute: boolean
  threshold: number
  safeAddress: string
  network: string
  chainId: number
  safeTx: {
    data: {
      to: string
      value: string
      data: string
      operation: number
      nonce: number
    }
    signatures?: Record<
      string,
      {
        signer: string
        data: string
      }
    >
  }
  safeTxHash: string
  proposer: string
  timestamp: Date
  status: 'pending' | 'executed'
}

enum privateKeyType {
  SAFE_SIGNER,
  DEPLOYER,
}

const networks: NetworksObject = networksConfig

const ABI_LOOKUP_URL = `https://api.openchain.xyz/signature-database/v1/lookup?function=%SELECTOR%&filter=true`

const allNetworks = Object.keys(networksConfig)

// In order to skip specific networks simple comment them in
const skipNetworks: string[] = [
  // 'mainnet',
  // 'arbitrum',
  // 'aurora',
  // 'avalanche',
  // 'base',
  // 'blast',
  // 'boba',
  // 'bsc',
  // 'celo',
  // 'cronos',
  // 'fantom',
  // 'fraxtal',
  // 'fuse',
  // 'gnosis',
  // 'gravity',
  // 'immutablezkevm',
  // 'kaia',
  // 'linea',
  // 'mantle',
  // 'metis',
  // 'mode',
  // 'moonbeam',
  // 'moonriver',
  // 'optimism',
  // 'opbnb',
  // 'polygon',
  // 'polygonzkevm',
  // 'rootstock',
  // 'scroll',
  // 'sei',
  // 'taiko',
  // 'xlayer',
  // 'zksync',
]
const defaultNetworks = allNetworks.filter(
  (network) =>
    !skipNetworks.includes(network) &&
    network !== 'localanvil' &&
    networks[network.toLowerCase()].status === 'active' // <<< deactivate this to operate on non-active networks
)

const storedResponses: Record<string, string> = {}

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

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
    if (retries > 0) {
      consola.error('Retry after error:', e)
      return retry(func, retries - 1)
    }

    throw e
  }
}

async function decodeDiamondCut(diamondCutData: any, chainId: number) {
  const actionMap: Record<number, string> = {
    0: 'Add',
    1: 'Replace',
    2: 'Remove',
  }
  consola.info('Diamond Cut Details:')
  consola.info('-'.repeat(80))
  // diamondCutData.args[0] contains an array of modifications.
  const modifications = diamondCutData.args[0]
  for (const mod of modifications) {
    // Each mod is [facetAddress, action, selectors]
    const [facetAddress, actionValue, selectors] = mod
    try {
      consola.info(`Fetching ABI for Facet Address: ${facetAddress}`)
      const url = `https://anyabi.xyz/api/get-abi/${chainId}/${facetAddress}`
      const response = await fetch(url)
      const resData = await response.json()
      consola.info(`Action: ${actionMap[actionValue] ?? actionValue}`)
      if (resData && resData.abi) {
        consola.info(`Contract Name: ${resData.name || 'unknown'}`)
        for (const selector of selectors) {
          let decodedSignature = `function unknown() [${selector}]`
          try {
            const decoded = decodeFunctionData({
              abi: resData.abi,
              data: selector,
            })
            decodedSignature = `function ${decoded.functionName}() [${selector}]`
            consola.info(decodedSignature)
          } catch (error) {
            consola.info(decodedSignature)
          }
        }
      } else {
        consola.info(`Could not fetch ABI for facet ${facetAddress}`)
      }
    } catch (error) {
      consola.error(`Error fetching ABI for ${facetAddress}:`, error)
    }
    consola.info('-'.repeat(80))
  }
  // Also log the initialization parameters (2nd and 3rd arguments of diamondCut)
  consola.info(`Init Address: ${diamondCutData.args[1]}`)
  consola.info(`Init Calldata: ${diamondCutData.args[2]}`)
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

/**
 * Main function to process Safe transactions for a given network
 * @param network - Network name
 * @param privateKey - Private key of the signer
 * @param privKeyType - Type of private key (SAFE_SIGNER or DEPLOYER)
 * @param rpcUrl - Optional RPC URL override
 */
const func = async (
  network: string,
  privateKey: string,
  privKeyType: privateKeyType,
  rpcUrl?: string
) => {
  console.info(' ')
  consola.info('-'.repeat(80))

  const chain = getViemChainForNetworkName(network)

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is required')
  }

  const mongoClient = new MongoClient(process.env.MONGODB_URI)
  const db = mongoClient.db('SAFE')
  const pendingTransactions = db.collection('pendingTransactions')

  const safeAddress = networks[network.toLowerCase()].safeAddress

  const parsedRpcUrl = rpcUrl || chain.rpcUrls.default.http[0]
  const provider = new ethers.JsonRpcProvider(parsedRpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)

  const signerAddress = await signer.getAddress()

  consola.info('Chain:', chain.name)
  consola.info('Signer:', signerAddress)

  let protocolKit: Safe
  try {
    protocolKit = await Safe.init({
      provider: parsedRpcUrl,
      signer: privateKey,
      safeAddress,
    })
  } catch (err) {
    consola.error(`error encountered while setting up protocolKit: ${err}`)
    consola.error(`skipping network ${network}`)
    consola.error(
      `Please check this network's SAFE manually NOW to make sure no pending transactions are missed`
    )
    return
  }

  // Get pending transactions from MongoDB
  const allTx = await pendingTransactions
    .find<SafeTxDocument>({
      safeAddress,
      network: network.toLowerCase(),
      chainId: chain.id,
      status: 'pending',
    })
    .toArray()

  /**
   * Initializes a SafeTransaction from MongoDB document data
   * @param txFromMongo - Transaction document from MongoDB
   * @returns Initialized SafeTransaction with signatures
   */
  const initializeSafeTransaction = async (txFromMongo: any) => {
    const safeTransaction = await protocolKit.createTransaction({
      transactions: [txFromMongo.safeTx.data],
    })

    // Add existing signatures
    if (txFromMongo.safeTx.signatures) {
      Object.values(txFromMongo.safeTx.signatures).forEach((signature: any) => {
        safeTransaction.addSignature(signature)
      })
    }

    return safeTransaction
  }

  /**
   * Signs a SafeTransaction
   * @param safeTransaction - The transaction to sign
   * @returns The signed transaction
   */
  const signTransaction = async (safeTransaction: SafeTransaction) => {
    consola.info('Signing transaction')
    const signedTx = await protocolKit.signTransaction(safeTransaction)
    consola.success('Transaction signed')
    return signedTx
  }

  /**
   * Executes a SafeTransaction and updates its status in MongoDB
   * @param safeTransaction - The transaction to execute
   */
  async function executeTransaction(safeTransaction: SafeTransaction) {
    consola.info('Executing transaction')
    try {
      const exec = await protocolKit.executeTransaction(safeTransaction)

      // Update MongoDB transaction status
      await pendingTransactions.updateOne(
        { safeTxHash: await protocolKit.getTransactionHash(safeTransaction) },
        { $set: { status: 'executed', executionHash: exec.hash } }
      )
    } catch (err) {
      consola.error('Error while trying to execute the transaction')
      throw Error(`Transaction could not be executed`)
    }

    consola.success('Transaction executed')
    console.info(' ')
    console.info(' ')
  }

  /**
   * Checks if a SafeTransaction has enough signatures to execute
   * @param safeTx - The transaction to check
   * @param threshold - Number of signatures required
   * @returns True if the transaction has enough signatures
   */
  const hasEnoughSignatures = (
    safeTx: SafeTransaction,
    threshold: number
  ): boolean => {
    const sigCount = safeTx?.signatures?.size || 0
    return sigCount >= threshold
  }

  /**
   * Checks if the current signer has already signed the transaction
   * @param safeTx - The transaction to check
   * @param signerAddress - Address of the current signer
   * @returns True if the signer has already signed
   */
  const isSignedByCurrentSigner = (
    safeTx: SafeTransaction,
    signerAddress: string
  ): boolean => {
    if (!safeTx?.signatures) return false
    const signers = Array.from(safeTx.signatures.values()).map((sig) =>
      sig.signer.toLowerCase()
    )
    return signers.includes(signerAddress.toLowerCase())
  }

  /**
   * Checks if adding current signer's signature would meet the threshold
   * @param safeTx - The transaction to check
   * @param threshold - Number of signatures required
   * @returns True if adding a signature would meet the threshold
   */
  const wouldMeetThreshold = (
    safeTx: SafeTransaction,
    threshold: number
  ): boolean => {
    const currentSignatures = safeTx?.signatures?.size || 0
    const afterSigning = currentSignatures + 1
    return afterSigning >= threshold
  }

  // Filter and augment transactions with signature status
  const txs = await Promise.all(
    allTx.map(async (tx: SafeTxDocument): Promise<AugmentedSafeTxDocument> => {
      const threshold = await protocolKit.getThreshold()
      const safeTransaction = await initializeSafeTransaction(tx)
      const hasSignedAlready = isSignedByCurrentSigner(
        safeTransaction,
        signerAddress
      )
      const canExecute = hasEnoughSignatures(safeTransaction, threshold)

      return {
        ...tx,
        safeTransaction,
        hasSignedAlready,
        canExecute,
        threshold,
      }
    })
  ).then((txs: AugmentedSafeTxDocument[]) =>
    txs.filter((tx) => {
      const needsMoreSignatures =
        tx.safeTransaction.signatures.size < tx.threshold
      const canExecute = tx.safeTransaction.signatures.size >= tx.threshold
      // Show transaction if:
      // - it needs more signatures OR
      // - it can be executed (has enough signatures)
      return needsMoreSignatures || canExecute
    })
  )

  if (!txs.length) {
    consola.success('No pending transactions')
    await mongoClient.close()
    return
  }

  for (const tx of txs.sort((a, b) => {
    if (a.safeTx.data.nonce < b.safeTx.data.nonce) return -1
    if (a.safeTx.data.nonce > b.safeTx.data.nonce) return 1
    return 0
  })) {
    let abi
    let abiInterface: Abi
    let decoded
    if (tx.safeTx.data) {
      const selector = tx.safeTx.data.data.substring(0, 10)
      const url = ABI_LOOKUP_URL.replace('%SELECTOR%', selector)
      const response = await fetch(url)
      const data = await response.json()
      if (
        data.ok &&
        data.result &&
        data.result.function &&
        data.result.function[selector]
      ) {
        abi = data.result.function[selector][0].name
        const fullAbiString = `function ${abi}`
        abiInterface = parseAbi([fullAbiString])
        decoded = decodeFunctionData({
          abi: abiInterface,
          data: tx.safeTx.data.data as Hex,
        })
      }
    }

    consola.info('-'.repeat(80))
    consola.info('Transaction Details:')
    consola.info('-'.repeat(80))

    if (abi) {
      if (decoded && decoded.functionName === 'diamondCut') {
        await decodeDiamondCut(decoded, chain.id)
      } else {
        consola.info('Method:', abi)
        if (decoded) {
          consola.info('Decoded Data:', JSON.stringify(decoded, null, 2))
        }
      }
    }

    consola.info(`Transaction:
    Nonce:     ${tx.safeTx.data.nonce}
    To:        ${tx.safeTx.data.to}
    Value:     ${tx.safeTx.data.value}
    Data:      ${tx.safeTx.data.data}
    Proposer:  ${tx.proposer}
    Hash:      ${tx.safeTxHash}`)

    const storedResponse = tx.safeTx.data.data
      ? storedResponses[tx.safeTx.data.data]
      : undefined

    // Determine available actions based on signature status
    let action: string
    if (privKeyType === privateKeyType.SAFE_SIGNER) {
      action = 'Sign'
      consola.info(
        'Using SAFE_SIGNER_PRIVATE_KEY - automatically selecting "Sign" action'
      )
    } else {
      const options = ['Do Nothing']
      if (!tx.hasSignedAlready) {
        options.push('Sign')
        if (wouldMeetThreshold(tx.safeTransaction, tx.threshold)) {
          options.push('Sign & Execute')
        }
      }

      if (hasEnoughSignatures(tx.safeTransaction, tx.threshold)) {
        options.push('Execute')
      }

      action =
        storedResponse ||
        (await consola.prompt('Select action:', {
          type: 'select',
          options,
        }))

      if (action === 'Do Nothing') {
        continue
      }
    }
    storedResponses[tx.safeTx.data.data!] = action

    if (action === 'Sign') {
      try {
        const safeTransaction = await initializeSafeTransaction(tx)
        const signedTx = await signTransaction(safeTransaction)
        // Update MongoDB with new signature
        await pendingTransactions.updateOne(
          { safeTxHash: tx.safeTxHash },
          {
            $set: {
              [`safeTx`]: signedTx,
            },
          }
        )
      } catch (error) {
        consola.error('Error signing transaction:', error)
      }
    }

    if (action === 'Sign & Execute') {
      try {
        const safeTransaction = await initializeSafeTransaction(tx)
        const signedTx = await signTransaction(safeTransaction)
        // Update MongoDB with new signature
        await pendingTransactions.updateOne(
          { safeTxHash: tx.safeTxHash },
          {
            $set: {
              [`safeTx`]: signedTx,
            },
          }
        )
        await executeTransaction(signedTx)
      } catch (error) {
        consola.error('Error signing and executing transaction:', error)
      }
    }

    if (action === 'Execute') {
      try {
        const safeTransaction = await initializeSafeTransaction(tx)
        await executeTransaction(safeTransaction)
      } catch (error) {
        consola.error('Error executing transaction:', error)
      }
    }
  }

  // Close MongoDB connection after processing all transactions
  await mongoClient.close()
}

/**
 * Main command definition for the script
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
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL',
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
      required: false,
    },
  },
  async run({ args }) {
    const networks = args.network ? [args.network] : defaultNetworks

    // if no privateKey was supplied, read directly from env
    let privateKey = args.privateKey
    let keyType = privateKeyType.DEPLOYER // default value

    if (!privateKey) {
      const keyChoice = await consola.prompt(
        'Which private key do you want to use from your .env file?',
        {
          type: 'select',
          options: ['PRIVATE_KEY_PRODUCTION', 'SAFE_SIGNER_PRIVATE_KEY'],
        }
      )

      privateKey = process.env[keyChoice] ?? ''
      keyType =
        keyChoice === 'SAFE_SIGNER_PRIVATE_KEY'
          ? privateKeyType.SAFE_SIGNER
          : privateKeyType.DEPLOYER

      if (privateKey == '')
        throw Error(`could not find a key named ${keyChoice} in your .env file`)
    }

    for (const network of networks) {
      await func(network, privateKey, keyType, args.rpcUrl)
    }
  },
})

runMain(main)
