/**
 * Safe Utilities
 *
 * This module provides utilities for interacting with Gnosis Safe contracts
 * using Viem. It includes classes and functions for creating, signing, and
 * executing transactions, as well as managing Safe configuration and MongoDB interactions.
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import { config } from 'dotenv'
import { MongoClient, type Collection, type InsertOneResult } from 'mongodb'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  toFunctionSelector,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import data from '../../../config/networks.json'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

import { SAFE_SINGLETON_ABI } from './config'

config()

const networks: Record<string, { safeAddress: string; status: string }> = data

// Types for Safe transactions
export enum OperationTypeEnum {
  Call = 0,
  DelegateCall = 1,
}

export enum PrivateKeyTypeEnum {
  SAFE_SIGNER,
  DEPLOYER,
}

export interface ISafeTransactionData {
  to: Address
  value: bigint
  data: Hex
  operation: OperationTypeEnum
  nonce: bigint
}

export interface ISafeTransaction {
  data: ISafeTransactionData
  signatures: Map<string, ISafeSignature>
}

export interface ISafeSignature {
  signer: Address
  data: Hex
}

export interface ISafeTxDocument {
  safeAddress: string
  network: string
  chainId: number
  safeTx: ISafeTransaction
  safeTxHash: string
  proposer: string
  timestamp: Date
  status: 'pending' | 'executed'
}

export interface IAugmentedSafeTxDocument extends ISafeTxDocument {
  safeTransaction: ISafeTransaction
  hasSignedAlready: boolean
  canExecute: boolean
  threshold: number
}

/**
 * Retries a function multiple times if it fails
 * @param func - The async function to retry
 * @param retries - Number of retries remaining
 * @returns The result of the function
 */
export const retry = async <T>(
  func: () => Promise<T>,
  retries = 3
): Promise<T> => {
  try {
    const result = await func()
    return result
  } catch (e) {
    console.error('Error details:', {
      error: e,
      remainingRetries: retries - 1,
    })
    if (retries > 0) return retry(func, retries - 1)

    throw e
  }
}

/**
 * ViemSafe class
 *
 * A wrapper around Viem clients that provides Safe-specific functionality.
 * This class handles Safe contract interactions including transaction creation,
 * signing, and execution.
 */
export class ViemSafe {
  /**
   * Public client for read operations
   * @private
   */
  private publicClient: PublicClient

  /**
   * Wallet client for write operations and signing
   * @private
   */
  private walletClient: WalletClient

  /**
   * Address of the Safe contract
   * @private
   */
  private safeAddress: Address

  /**
   * Address of the account used for signing
   * @public
   */
  public account: Account

  public constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    safeAddress: Address,
    account: Account
  ) {
    this.publicClient = publicClient
    this.walletClient = walletClient
    this.safeAddress = safeAddress
    this.account = account
  }

  public static async init(options: {
    provider: string | Chain
    privateKey?: string
    safeAddress: Address
    useLedger?: boolean
    ledgerOptions?: {
      derivationPath?: string
      ledgerLive?: boolean
      accountIndex?: number
    }
    account?: Account
  }): Promise<ViemSafe> {
    const {
      privateKey,
      safeAddress,
      provider,
      useLedger,
      ledgerOptions,
      account: preCreatedAccount,
    } = options

    // Create provider with Viem
    let publicClient: PublicClient
    let chain: Chain | undefined = undefined

    if (typeof provider === 'string')
      publicClient = createPublicClient({
        transport: http(provider),
      })
    else {
      chain = provider
      publicClient = createPublicClient({
        chain: chain,
        transport: http(),
      })
    }

    // Get account - either use pre-created, from private key, or create new Ledger connection
    let account
    if (preCreatedAccount) account = preCreatedAccount
    else if (useLedger) {
      // Dynamically import the Ledger module to avoid dependency issues
      const { getLedgerAccount } = await import('./ledger')
      const ledgerResult = await getLedgerAccount(ledgerOptions)
      account = ledgerResult.account
    } else if (privateKey)
      account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`)
    else
      throw new Error(
        'Either privateKey, useLedger, or account must be provided'
      )

    // Create wallet client with the account and chain
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(typeof provider === 'string' ? provider : undefined),
    })

    return new ViemSafe(publicClient, walletClient, safeAddress, account)
  }

  // Get Safe address
  public getAddress(): Address {
    return this.safeAddress
  }

  // Get nonce from Safe contract (replaces getNonce from Safe SDK)
  public async getNonce(): Promise<bigint> {
    try {
      return await this.publicClient.readContract({
        address: this.safeAddress,
        abi: SAFE_SINGLETON_ABI,
        functionName: 'nonce',
      })
    } catch (error) {
      console.error('Error getting nonce:', error)
      throw error
    }
  }

  // Get owners from Safe contract (replaces getOwners from Safe SDK)
  public async getOwners(): Promise<Address[]> {
    try {
      const owners = [
        ...(await this.publicClient.readContract({
          address: this.safeAddress,
          abi: SAFE_SINGLETON_ABI,
          functionName: 'getOwners',
        })),
      ]
      return owners
    } catch (error) {
      console.error('Error getting owners:', error)
      throw error
    }
  }

  // Get threshold from Safe contract (replaces getThreshold from Safe SDK)
  public async getThreshold(): Promise<bigint> {
    try {
      return await this.publicClient.readContract({
        address: this.safeAddress,
        abi: SAFE_SINGLETON_ABI,
        functionName: 'getThreshold',
      })
    } catch (error) {
      console.error('Error getting threshold:', error)
      throw error
    }
  }

  // Create a Safe transaction (replaces createTransaction from Safe SDK)
  public async createTransaction(options: {
    transactions: {
      to: Address
      value: string | bigint
      data: Hex
      operation?: OperationTypeEnum
      nonce?: bigint
    }[]
  }): Promise<ISafeTransaction> {
    const tx = options.transactions[0]
    if (!tx) throw new Error('No transaction provided')

    const nonce = tx.nonce !== undefined ? tx.nonce : await this.getNonce()

    const safeTx: ISafeTransaction = {
      data: {
        to: tx.to,
        value: typeof tx.value === 'string' ? BigInt(tx.value) : tx.value,
        data: tx.data,
        operation: tx.operation || OperationTypeEnum.Call,
        nonce: nonce,
      },
      signatures: new Map(),
    }

    return safeTx
  }

  // Create a Safe transaction for adding an owner (replaces createAddOwnerTx from Safe SDK)
  public async createAddOwnerTx(
    options: { ownerAddress: Address; threshold: bigint },
    txOptions?: { nonce?: bigint }
  ): Promise<ISafeTransaction> {
    try {
      const data = encodeFunctionData({
        abi: SAFE_SINGLETON_ABI,
        functionName: 'addOwnerWithThreshold',
        args: [options.ownerAddress, options.threshold],
      })

      return await this.createTransaction({
        transactions: [
          {
            to: this.safeAddress,
            value: 0n,
            data,
            nonce: txOptions?.nonce,
          },
        ],
      })
    } catch (error) {
      console.error('Error creating add owner transaction:', error)
      throw error
    }
  }

  // Create a Safe transaction for changing the threshold (replaces createChangeThresholdTx from Safe SDK)
  public async createChangeThresholdTx(
    threshold: number,
    txOptions?: { nonce?: bigint }
  ): Promise<ISafeTransaction> {
    try {
      const data = encodeFunctionData({
        abi: SAFE_SINGLETON_ABI,
        functionName: 'changeThreshold',
        args: [BigInt(threshold)],
      })

      return await this.createTransaction({
        transactions: [
          {
            to: this.safeAddress,
            value: 0n,
            data,
            nonce: txOptions?.nonce,
          },
        ],
      })
    } catch (error) {
      console.error('Error creating change threshold transaction:', error)
      throw error
    }
  }

  // Generate transaction hash (replaces getTransactionHash from Safe SDK)
  public async getTransactionHash(safeTx: ISafeTransaction): Promise<Hex> {
    try {
      // The Safe contract's getTransactionHash matches this implementation
      // GS026 error indicates invalid signature which would happen if we're not using
      // the correct hash that the Safe contract expects
      const hash = await this.publicClient.readContract({
        address: this.safeAddress,
        abi: SAFE_SINGLETON_ABI,
        functionName: 'getTransactionHash',
        args: [
          safeTx.data.to,
          safeTx.data.value,
          safeTx.data.data,
          safeTx.data.operation,
          0n, // safeTxGas
          0n, // baseGas
          0n, // gasPrice
          '0x0000000000000000000000000000000000000000' as Address, // gasToken
          '0x0000000000000000000000000000000000000000' as Address, // refundReceiver
          safeTx.data.nonce,
        ],
      })

      console.log('Generated transaction hash:', hash)
      return hash
    } catch (error) {
      console.error('Error generating transaction hash:', error)
      throw error
    }
  }

  // Sign a transaction hash using eth_sign (most compatible with all Safe versions)
  // Error GS026 indicates an invalid signature issue
  public async signHash(hash: Hex): Promise<ISafeSignature> {
    try {
      console.log('Signing hash:', hash)

      // Use eth_sign (via personal_sign) which adds the Ethereum message prefix
      // This is the most compatible method with all Safe contract versions
      const ethSignSignature = await this.walletClient.signMessage({
        account: this.account,
        message: { raw: hash },
      })

      console.log('Raw signature:', ethSignSignature)

      if (!ethSignSignature.startsWith('0x') || ethSignSignature.length !== 132)
        throw new Error(
          `Invalid signature format from wallet. Expected 0x + 130 hex chars but got: ${ethSignSignature}`
        )

      // Extract r, s, v components from the signature
      const r = ethSignSignature.slice(0, 66)
      const s = ethSignSignature.slice(66, 130)

      // Get v value from the signature and adjust for eth_sign
      const vByte = ethSignSignature.slice(130, 132)
      const vValue = parseInt(vByte, 16)

      // For eth_sign signatures in Safe contracts, we need to add +4 to v
      // This identifies it as an eth_sign signature (type 1)
      const safeV = (vValue + 4).toString(16).padStart(2, '0')

      // Format for Safe contract: r + s + v
      // Safe expects signatures in format: r (32 bytes) + s (32 bytes) + v (1 byte)
      const safeSignature = `0x${r.slice(2)}${s}${safeV}` as Hex

      console.log('Safe signature:', safeSignature)

      return {
        signer: this.account.address,
        data: safeSignature,
      }
    } catch (error: any) {
      console.error('Error signing hash with eth_sign:', error)
      throw new Error(`Failed to sign hash: ${error.message || error}`)
    }
  }

  // Sign a Safe transaction (replaces signTransaction from Safe SDK)
  public async signTransaction(
    safeTx: ISafeTransaction
  ): Promise<ISafeTransaction> {
    try {
      // Get chain ID for domain
      const chainId = await this.publicClient.getChainId()

      // Define EIP-712 domain and types
      const domain = {
        chainId,
        verifyingContract: this.safeAddress,
      }

      const types = {
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      }

      // Message to sign following EIP-712 structure
      const message = {
        to: safeTx.data.to,
        value: safeTx.data.value,
        data: safeTx.data.data,
        operation: safeTx.data.operation,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: '0x0000000000000000000000000000000000000000' as Address,
        refundReceiver: '0x0000000000000000000000000000000000000000' as Address,
        nonce: safeTx.data.nonce,
      }

      // Sign typed data using walletClient
      const typedDataSignature = await this.walletClient.signTypedData({
        account: this.account,
        domain,
        types,
        primaryType: 'SafeTx',
        message,
      })

      // Format the signature for Safe contract
      const signature = {
        signer: this.account.address,
        data: typedDataSignature,
      }

      // Add signature to transaction
      safeTx.signatures.set(signature.signer.toLowerCase(), signature)

      return safeTx
    } catch (error: any) {
      console.error('Error signing transaction:', error)
      throw new Error(`Failed to sign transaction: ${error.message || error}`)
    }
  }

  // Validate a signature to ensure it's in the correct format for Safe contracts
  private validateSignature(signature: Hex): boolean {
    if (!signature.startsWith('0x')) return false

    // Remove 0x prefix for length check
    const sigWithoutPrefix = signature.slice(2)

    // For Safe signatures in format r+s+v, signature should be 130 chars (65 bytes)
    // r = 32 bytes (64 chars), s = 32 bytes (64 chars), v = 1 byte (2 chars)
    if (sigWithoutPrefix.length !== 130) return false

    // For eth_sign signatures (type 1), v values should be 31 or 32
    // (normal v value of 27/28 + 4 = 31/32)
    const vValue = parseInt(sigWithoutPrefix.slice(128, 130), 16)

    // Check for eth_sign signatures or standard EIP-712 signatures
    // EIP-712 signatures typically have v values of 27 or 28
    // eth_sign signatures have v values of 31 or 32
    return vValue === 27 || vValue === 28 || vValue === 31 || vValue === 32
  }

  // Format signatures as bytes for contract submission
  private formatSignatures(signatures: Map<string, ISafeSignature>): Hex {
    if (!signatures.size) return '0x' as Hex

    try {
      // Convert Map to array and sort by signer address
      // Safe contract requires signatures to be sorted by signer address
      const sortedSigs = Array.from(signatures.values()).sort((a, b) => {
        const addressA = a.signer.toLowerCase()
        const addressB = b.signer.toLowerCase()
        return addressA < addressB ? -1 : addressA > addressB ? 1 : 0
      })

      // Concatenate all signatures as bytes
      // Each signature is 65 bytes: r (32) + s (32) + v (1)
      let signatureBytes = '0x' as Hex
      for (const sig of sortedSigs) {
        // Ensure signature data is in correct format
        if (!sig.data.startsWith('0x'))
          throw new Error(
            `Invalid signature format. Expected 0x prefix but got: ${sig.data}`
          )

        // Validate signature format
        if (!this.validateSignature(sig.data))
          throw new Error(
            `Invalid signature length. Safe signatures must be 65 bytes (130 hex chars excluding 0x prefix). Got: ${
              sig.data.slice(2).length
            } chars`
          )

        // Remove 0x prefix before concatenating
        signatureBytes = (signatureBytes + sig.data.slice(2)) as Hex
      }

      return signatureBytes
    } catch (error: any) {
      console.error('Error formatting signatures:', error)
      throw new Error(`Failed to format signatures: ${error.message || error}`)
    }
  }

  /**
   * Executes a Safe transaction
   * @param safeTx - The transaction to execute
   * @returns Object containing the transaction hash and optional receipt
   * @throws Error if execution fails
   */
  public async executeTransaction(
    safeTx: ISafeTransaction
  ): Promise<{ hash: Hex; receipt?: TransactionReceipt }> {
    try {
      const signatures = this.formatSignatures(safeTx.signatures)

      // Submit the transaction
      const txHash = await this.walletClient.writeContract({
        account: this.account,
        chain: null,
        address: this.safeAddress,
        abi: SAFE_SINGLETON_ABI,
        functionName: 'execTransaction',
        args: [
          safeTx.data.to,
          safeTx.data.value,
          safeTx.data.data,
          safeTx.data.operation,
          0n, // safeTxGas
          0n, // baseGas
          0n, // gasPrice
          '0x0000000000000000000000000000000000000000' as Address, // gasToken
          '0x0000000000000000000000000000000000000000' as Address, // refundReceiver
          signatures,
        ],
      })

      consola.info(`Blockchain Transaction Hash: \u001b[33m${txHash}\u001b[0m`)

      // Try to get receipt with 30 second timeout
      let receipt: TransactionReceipt | null = null

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Confirmation timeout')), 30000)
        )

        const receiptPromise = this.publicClient.waitForTransactionReceipt({
          hash: txHash,
        })

        receipt = (await Promise.race([
          receiptPromise,
          timeoutPromise,
        ])) as TransactionReceipt

        // If we got a receipt, check its status
        if (receipt.status === 'success') return { hash: txHash, receipt }
        else
          throw new Error(`Transaction failed with status: ${receipt.status}`)
      } catch (timeoutError: any) {
        if (timeoutError.message.includes('timeout')) {
          // Timeout reached - return optimistically with warning
          consola.warn(
            `⚠️  Transaction submitted but confirmation timed out after 30 seconds`
          )
          consola.warn(`   Transaction hash: ${txHash}`)
          consola.warn(`   Please manually verify transaction status later`)
          return { hash: txHash }
        }
        // Some other error occurred
        else throw timeoutError
      }
    } catch (error: any) {
      if (error.message?.includes('execution reverted'))
        throw new Error(`Safe execution reverted: ${error.message}`)

      throw new Error(`Error executing transaction: ${error.message || error}`)
    }
  }

  /**
   * Cleanup method to close transport connections and prevent hanging processes
   */
  public async cleanup(): Promise<void> {
    try {
      // Close public client transport if it has a close method
      if (
        this.publicClient?.transport &&
        'close' in this.publicClient.transport
      )
        await (this.publicClient.transport as any).close?.()

      // Close wallet client transport if it has a close method
      if (
        this.walletClient?.transport &&
        'close' in this.walletClient.transport
      )
        await (this.walletClient.transport as any).close?.()
    } catch (error: any) {
      // Don't throw on cleanup errors, just log them
      consola.warn(`Warning during ViemSafe cleanup: ${error.message}`)
    }
  }
}

/**
 * Initializes a SafeTransaction from MongoDB document data
 * @param txFromMongo - Transaction document from MongoDB
 * @param safe - ViemSafe instance
 * @returns Initialized SafeTransaction with signatures
 */
export const initializeSafeTransaction = async (
  txFromMongo: ISafeTxDocument,
  safe: ViemSafe
): Promise<ISafeTransaction> => {
  // Create a new transaction using our viem-based Safe implementation
  const safeTransaction = await safe.createTransaction({
    transactions: [
      {
        to: txFromMongo.safeTx.data.to as Address,
        value: BigInt(txFromMongo.safeTx.data.value),
        data: txFromMongo.safeTx.data.data as Hex,
        operation: txFromMongo.safeTx.data.operation as OperationTypeEnum,
        nonce: BigInt(txFromMongo.safeTx.data.nonce),
      },
    ],
  })

  // Add existing signatures
  if (txFromMongo.safeTx.signatures) {
    // Convert from document format to Map
    const signatures = new Map<string, { signer: Address; data: Hex }>()
    Object.entries(txFromMongo.safeTx.signatures).forEach(
      ([key, value]: [string, any]) => {
        signatures.set(key, {
          signer: value.signer as Address,
          data: value.data as Hex,
        })
      }
    )
    safeTransaction.signatures = signatures
  }

  return safeTransaction
}

/**
 * Checks if a SafeTransaction has enough signatures to execute
 * @param safeTx - The transaction to check
 * @param threshold - Number of signatures required
 * @returns True if the transaction has enough signatures
 */
export const hasEnoughSignatures = (
  safeTx: ISafeTransaction,
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
export const isSignedByCurrentSigner = (
  safeTx: ISafeTransaction,
  signerAddress: Address
): boolean => {
  if (!safeTx?.signatures) return false
  const signers = Array.from(safeTx.signatures.values()).map((sig) =>
    sig.signer.toLowerCase()
  )
  return signers.includes(signerAddress.toLowerCase())
}

/**
 * Checks if an address is an owner of a Safe
 * @param existingOwners - Array of existing Safe owner addresses
 * @param addressToCheck - Address to check for ownership
 * @returns True if the address is an owner, false otherwise
 */
export function isAddressASafeOwner(
  existingOwners: Address[],
  addressToCheck: Address
): boolean {
  const existingOwnersLowercase = existingOwners.map((o) => o.toLowerCase())
  return existingOwnersLowercase.includes(addressToCheck.toLowerCase())
}

/**
 * Checks if adding current signer's signature would meet the threshold
 * @param safeTx - The transaction to check
 * @param threshold - Number of signatures required
 * @returns True if adding a signature would meet the threshold
 */
export const wouldMeetThreshold = (
  safeTx: ISafeTransaction,
  threshold: number
): boolean => {
  const currentSignatures = safeTx?.signatures?.size || 0
  const afterSigning = currentSignatures + 1
  return afterSigning >= threshold
}

/**
 * Checks if the PRIVATE_KEY_PRODUCTION wallet has already signed the transaction
 * @param safeTx - The transaction to check
 * @returns True if the PRIVATE_KEY_PRODUCTION wallet has already signed
 */
export const isSignedByProductionWallet = (
  safeTx: ISafeTransaction
): boolean => {
  if (!safeTx?.signatures) return false

  try {
    const productionPrivateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
    const productionAccount = privateKeyToAccount(
      `0x${productionPrivateKey}` as Hex
    )
    const productionAddress = productionAccount.address

    const signers = Array.from(safeTx.signatures.values()).map((sig) =>
      sig.signer.toLowerCase()
    )
    return signers.includes(productionAddress.toLowerCase())
  } catch (error) {
    // If we can't get the production key, assume it hasn't signed
    return false
  }
}

/**
 * Determines if the "Sign and Execute With Deployer" option should be shown
 * @param safeTx - The Safe transaction
 * @param threshold - The signature threshold required
 * @param currentSignerAddress - Address of the current signer
 * @returns True if the option should be shown
 */
export const shouldShowSignAndExecuteWithDeployer = (
  safeTx: ISafeTransaction,
  threshold: number,
  currentSignerAddress: Address
): boolean => {
  const currentSignatures = safeTx?.signatures?.size || 0
  const isCurrentSignerAlreadySigned = isSignedByCurrentSigner(
    safeTx,
    currentSignerAddress
  )
  const isDeployerAlreadySigned = isSignedByProductionWallet(safeTx)

  // Don't show if current signer has already signed
  if (isCurrentSignerAlreadySigned) return false

  // Calculate signatures after current signer signs
  const signaturesAfterCurrentSigner = currentSignatures + 1

  // Two scenarios:
  // 1. If deployer already signed: check if current user's signature would meet threshold
  // 2. If deployer hasn't signed: check if current user + deployer would meet threshold
  if (isDeployerAlreadySigned)
    // Deployer already signed, just need current user to potentially meet threshold
    return signaturesAfterCurrentSigner >= threshold
  else {
    // Deployer hasn't signed, need both current user + deployer to meet threshold
    const signaturesAfterBoth = signaturesAfterCurrentSigner + 1
    return signaturesAfterBoth >= threshold
  }
}

/**
 * Gets Safe information directly from the contract
 * @param publicClient - Viem public client
 * @param safeAddress - Address of the Safe
 * @returns Safe information including owners and threshold
 */
export async function getSafeInfoFromContract(
  publicClient: PublicClient,
  safeAddress: Address
): Promise<{
  owners: Address[]
  threshold: bigint
  nonce: bigint
}> {
  const [owners, threshold, nonce] = await Promise.all([
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'getOwners',
    }),
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'getThreshold',
    }),
    publicClient.readContract({
      address: safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'nonce',
    }),
  ])

  return {
    owners: owners as Address[],
    threshold,
    nonce,
  }
}

/**
 * Stores a Safe transaction in MongoDB
 * @param pendingTransactions - MongoDB collection
 * @param safeAddress - Address of the Safe
 * @param network - Network name
 * @param chainId - Chain ID
 * @param safeTx - The transaction to store
 * @param safeTxHash - Hash of the transaction
 * @param proposer - Address of the proposer
 * @returns Result of the MongoDB insert operation
 */
export async function storeTransactionInMongoDB(
  pendingTransactions: Collection<ISafeTxDocument>,
  safeAddress: Address,
  network: string,
  chainId: number,
  safeTx: ISafeTransaction,
  safeTxHash: Hex,
  proposer: Address
): Promise<InsertOneResult<ISafeTxDocument>> {
  const txDoc = {
    safeAddress,
    network: network.toLowerCase(),
    chainId,
    safeTx,
    safeTxHash,
    proposer,
    timestamp: new Date(),
    status: 'pending' as const,
  } satisfies ISafeTxDocument

  return retry(async () => {
    const insertResult = await pendingTransactions.insertOne(txDoc)
    return insertResult
  })
}

/**
 * Gets a MongoDB client and collection for Safe transactions
 * @returns MongoDB client and pendingTransactions collection
 * @throws Error if MONGODB_URI is not set
 */
export async function getSafeMongoCollection(): Promise<{
  client: MongoClient
  pendingTransactions: Collection<ISafeTxDocument>
}> {
  if (!process.env.MONGODB_URI)
    throw new Error('MONGODB_URI environment variable is required')

  const client = new MongoClient(process.env.MONGODB_URI)
  const db = client.db('SAFE')
  const pendingTransactions = db.collection<ISafeTxDocument>(
    'pendingTransactions'
  )

  return { client, pendingTransactions }
}

/**
 * Gets the next nonce for a Safe transaction
 * @param pendingTransactions - MongoDB collection
 * @param safeAddress - Address of the Safe
 * @param network - Network name
 * @param chainId - Chain ID
 * @param currentNonce - Current nonce from the Safe contract
 * @returns The next nonce to use
 */
export async function getNextNonce(
  pendingTransactions: Collection<ISafeTxDocument>,
  safeAddress: string,
  network: string,
  chainId: number,
  currentNonce: bigint
): Promise<bigint> {
  const latestTx = await pendingTransactions
    .find({
      safeAddress,
      network: network.toLowerCase(),
      chainId,
      status: 'pending',
    })
    .sort({ 'safeTx.data.nonce': -1 })
    .limit(1)
    .toArray()

  if (latestTx.length > 0) {
    const tx = latestTx[0]
    if (!tx) throw new Error('Latest transaction not found')
    return BigInt(tx.safeTx?.data?.nonce || 0) + 1n
  }
  return currentNonce
}

/**
 * Gets all pending transactions for specified networks
 * @param pendingTransactions - MongoDB collection
 * @param networks - List of network names
 * @returns Transactions grouped by network
 */
export async function getPendingTransactionsByNetwork(
  pendingTransactions: Collection<ISafeTxDocument>,
  networks: string[]
): Promise<Record<string, ISafeTxDocument[]>> {
  const allPendingTxs = await pendingTransactions
    .find<ISafeTxDocument>({
      network: { $in: networks.map((n) => n.toLowerCase()) },
      status: 'pending',
    })
    .toArray()

  // Group transactions by network
  const txsByNetwork: Record<string, ISafeTxDocument[]> = {}
  for (const tx of allPendingTxs) {
    const network = tx.network.toLowerCase()
    if (!txsByNetwork[network]) txsByNetwork[network] = []

    txsByNetwork[network].push(tx)
  }

  // Sort transactions by nonce for each network
  for (const network in txsByNetwork) {
    const txs = txsByNetwork[network]
    if (!txs) throw new Error(`Missing transactions for network ${network}`)
    txs.sort((a, b) => {
      if (a.safeTx.data.nonce < b.safeTx.data.nonce) return -1
      if (a.safeTx.data.nonce > b.safeTx.data.nonce) return 1
      return 0
    })
  }

  return txsByNetwork
}

/**
 * Initializes a Safe client for a specific network
 * @param network - Network name
 * @param privateKey - Private key for signing (optional if useLedger is true)
 * @param rpcUrl - Optional RPC URL override
 * @param useLedger - Whether to use a Ledger device for signing
 * @param ledgerOptions - Options for Ledger connection
 * @returns Initialized ViemSafe instance and chain information
 */
export async function initializeSafeClient(
  network: string,
  privateKey?: string,
  rpcUrl?: string,
  useLedger?: boolean,
  ledgerOptions?: {
    derivationPath?: string
    ledgerLive?: boolean
    accountIndex?: number
  },
  safeAddress?: Address,
  account?: Account
): Promise<{
  safe: ViemSafe
  chain: Chain
  safeAddress: Address
}> {
  const chain = getViemChainForNetworkName(network)
  const finalSafeAddress =
    safeAddress || (networks[network.toLowerCase()]?.safeAddress as Address)

  if (!finalSafeAddress)
    throw new Error(`No Safe address configured for network ${network}`)

  const parsedRpcUrl = rpcUrl || chain.rpcUrls.default.http[0]

  // Initialize Safe with Viem
  try {
    const safe = await ViemSafe.init({
      provider: parsedRpcUrl as string,
      privateKey,
      safeAddress: finalSafeAddress,
      useLedger,
      ledgerOptions,
      account,
    })

    return { safe, chain, safeAddress: finalSafeAddress }
  } catch (error: any) {
    consola.error(`Error encountered while setting up Safe: ${error}`)
    throw new Error(
      `Failed to initialize Safe for ${network}: ${error.message}`
    )
  }
}

/**
 * Gets the private key from environment or argument
 * @param privateKeyArg - Private key argument from command line
 * @param keyType - Type of key to use from environment
 * @returns The private key
 */
export function getPrivateKey(
  keyType:
    | 'PRIVATE_KEY_PRODUCTION'
    | 'SAFE_SIGNER_PRIVATE_KEY' = 'PRIVATE_KEY_PRODUCTION',
  privateKeyArg?: string
): string {
  const privateKey = privateKeyArg || process.env[keyType]

  if (!privateKey)
    throw new Error(
      `Private key is missing, either provide it as argument or add ${keyType} to your .env`
    )

  return privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
}

/**
 * Gets the list of networks to process
 * @param networkArg - Network argument from command line
 * @returns List of networks to process
 */
export function getNetworksToProcess(networkArg?: string): string[] {
  if (networkArg) return [networkArg]

  return Object.keys(networks).filter(
    (network) =>
      network !== 'localanvil' &&
      networks[network.toLowerCase()]?.status === 'active'
  )
}

/**
 * Gets networks that have pending transactions and exist in networks.json
 * @param pendingTransactions - MongoDB collection
 * @returns List of network names with pending transactions
 */
export async function getNetworksWithPendingTransactions(
  pendingTransactions: Collection<ISafeTxDocument>
): Promise<string[]> {
  // Query MongoDB to get distinct networks that have pending transactions
  const networksWithPendingTxs = await pendingTransactions.distinct('network', {
    status: 'pending',
  })

  // Filter to only include networks that exist in networks.json and are active
  const validNetworks = networksWithPendingTxs.filter((network: string) => {
    const networkConfig = networks[network.toLowerCase()]
    return networkConfig && networkConfig.status === 'active'
  })

  return validNetworks
}

/**
 * Gets contract name from deployment log file by address
 * @param address - Contract address
 * @returns Contract name or "Unknown"
 */
function getContractNameFromDeploymentLog(address: string): string {
  try {
    const projectRoot = process.cwd()
    const deploymentLogPath = path.join(
      projectRoot,
      'deployments',
      '_deployments_log_file.json'
    )

    if (!fs.existsSync(deploymentLogPath)) return 'Unknown'

    const logData = JSON.parse(fs.readFileSync(deploymentLogPath, 'utf8'))
    const normalizedAddress = address.toLowerCase()

    // Search through the nested structure: ContractName -> network -> environment -> version -> deployments[]
    for (const [contractName, networks] of Object.entries(logData))
      if (typeof networks === 'object' && networks !== null)
        for (const [_networkName, environments] of Object.entries(
          networks as Record<string, unknown>
        ))
          if (typeof environments === 'object' && environments !== null)
            for (const [_envName, versions] of Object.entries(
              environments as Record<string, unknown>
            ))
              if (typeof versions === 'object' && versions !== null)
                for (const [_version, deployments] of Object.entries(
                  versions as Record<string, unknown>
                ))
                  if (Array.isArray(deployments))
                    for (const deployment of deployments)
                      if (
                        deployment.ADDRESS &&
                        deployment.ADDRESS.toLowerCase() === normalizedAddress
                      )
                        return contractName

    return 'Unknown'
  } catch (error) {
    consola.warn(`Error reading deployment log: ${error}`)
    return 'Unknown'
  }
}

/**
 * Creates a mapping of function selectors to function names from diamond ABI
 * @returns Map of selector to function info
 */
async function createSelectorMap(): Promise<Map<
  string,
  { name: string; signature: string }
> | null> {
  try {
    const projectRoot = process.cwd()
    const diamondPath = path.join(projectRoot, 'diamond.json')

    if (!fs.existsSync(diamondPath)) return null

    const abiData = JSON.parse(fs.readFileSync(diamondPath, 'utf8'))
    if (!Array.isArray(abiData)) return null

    const selectorMap = new Map<string, { name: string; signature: string }>()

    for (const abiItem of abiData)
      if (abiItem.type === 'function')
        try {
          const selector = toFunctionSelector(abiItem)
          const inputs =
            abiItem.inputs?.map((input: any) => input.type).join(',') || ''
          const signature = `${abiItem.name}(${inputs})`

          selectorMap.set(selector, {
            name: abiItem.name,
            signature: signature,
          })
        } catch (error) {
          // Skip invalid ABI items
          continue
        }

    consola.info(`Created selector map with ${selectorMap.size} functions`)
    return selectorMap
  } catch (error) {
    consola.warn(`Error creating selector map: ${error}`)
    return null
  }
}

/**
 * Decodes a diamond cut transaction and displays its details
 * @param diamondCutData - Decoded diamond cut data
 * @param chainId - Chain ID
 */
export async function decodeDiamondCut(diamondCutData: any, chainId: number) {
  const actionMap: Record<number, string> = {
    0: 'Add',
    1: 'Replace',
    2: 'Remove',
  }

  // Create selector map for efficient lookup
  const selectorMap = await createSelectorMap()

  consola.info('Diamond Cut Details:')
  consola.info('-'.repeat(80))
  // diamondCutData.args[0] contains an array of modifications.
  const modifications = diamondCutData.args[0]
  for (const mod of modifications) {
    // Each mod is [facetAddress, action, selectors]
    const [facetAddress, actionValue, selectors] = mod
    try {
      consola.info(`Facet Address: \u001b[34m${facetAddress}\u001b[0m`)
      consola.info(`Action: ${actionMap[actionValue] ?? actionValue}`)

      // Use selector map for efficient lookup
      if (selectorMap) {
        const contractName = getContractNameFromDeploymentLog(facetAddress)
        consola.info(`Contract Name: \u001b[34m${contractName}\u001b[0m`)

        for (const selector of selectors) {
          const functionInfo = selectorMap.get(selector)
          if (functionInfo)
            consola.info(
              `Function: \u001b[34m${functionInfo.name}\u001b[0m [${selector}] - ${functionInfo.signature}`
            )
          else consola.warn(`Unknown function [${selector}]`)
        }
      } else {
        // Fallback to external API if selector map not available
        consola.info('No diamond ABI found, fetching from anyabi.xyz...')
        const url = `https://anyabi.xyz/api/get-abi/${chainId}/${facetAddress}`
        const response = await fetch(url)
        const resData = await response.json()

        if (resData && resData.abi) {
          consola.info(
            `Contract Name: \u001b[34m${resData.name || 'unknown'}\u001b[0m`
          )

          for (const selector of selectors)
            try {
              // Find matching function in ABI
              const matchingFunction = resData.abi.find((abiItem: any) => {
                if (abiItem.type !== 'function') return false
                const calculatedSelector = toFunctionSelector(abiItem)
                return calculatedSelector === selector
              })

              if (matchingFunction)
                consola.info(
                  `Function: \u001b[34m${matchingFunction.name}\u001b[0m [${selector}]`
                )
              else consola.warn(`Unknown function [${selector}]`)
            } catch (error) {
              consola.warn(`Failed to decode selector: ${selector}`)
            }
        } else consola.info(`Could not fetch ABI for facet ${facetAddress}`)
      }
    } catch (error) {
      consola.error(`Error processing facet ${facetAddress}:`, error)
    }
    consola.info('-'.repeat(80))
  }
  // Also log the initialization parameters (2nd and 3rd arguments of diamondCut)
  consola.info(`Init Address: ${diamondCutData.args[1]}`)
  consola.info(`Init Calldata: ${diamondCutData.args[2]}`)
}

/**
 * Obtains a safe
 * @param data - Transaction data
 * @returns Decoded function name and data if available
 */
export const getSafeInfo = async (safeAddress: string, network: string) => {
  const chain = getViemChainForNetworkName(network)

  // Get Safe information directly from the contract
  consola.info(`Getting Safe info for ${safeAddress} on ${network}`)
  let safeInfo
  try {
    // Create a public client for read operations
    const publicClient = createPublicClient({
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    })

    safeInfo = await getSafeInfoFromContract(
      publicClient,
      safeAddress as Address
    )
  } catch (error: any) {
    consola.error(`Failed to get Safe info: ${error.message}`)
    throw new Error(`Could not get Safe info for ${safeAddress} on ${network}`)
  }

  return safeInfo
}

/**
 * Helper function to wrap calldata in a timelock schedule call
 */
export async function wrapWithTimelockSchedule(
  network: string,
  rpcUrl: string,
  timelockAddress: Address,
  targetAddress: Address,
  originalCalldata: Hex
): Promise<{ calldata: Hex; targetAddress: Address }> {
  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  })

  // Get the minimum delay from the timelock controller
  const timelockAbi = parseAbi([
    'function getMinDelay() view returns (uint256)',
  ])

  let minDelay: bigint
  try {
    minDelay = await client.readContract({
      address: timelockAddress,
      abi: timelockAbi,
      functionName: 'getMinDelay',
    })
  } catch (error) {
    consola.warn(
      'Failed to get minimum delay from timelock, reading from config file'
    )

    // Read from config file as fallback
    try {
      const configPath = path.join(
        process.cwd(),
        'config',
        'timelockController.json'
      )
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      minDelay = BigInt(configData.minDelay || 3600)
      consola.info(`Using minimum delay from config: ${minDelay} seconds`)
    } catch (configError) {
      consola.warn(
        'Failed to read timelockController.json config file, using default 1 hour'
      )
      minDelay = 3600n // Default to 1 hour
    }
  }

  // Create a unique salt based on the current timestamp
  const salt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex

  // Encode the schedule function call
  const scheduleAbi = parseAbi([
    'function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
  ])

  const scheduleCalldata = encodeFunctionData({
    abi: scheduleAbi,
    functionName: 'schedule',
    args: [
      targetAddress, // target
      0n, // value
      originalCalldata, // data
      '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex, // predecessor (empty)
      salt, // salt
      minDelay, // delay
    ],
  })

  consola.info(
    `Wrapped transaction in timelock schedule call with minimum delay of ${minDelay} seconds`
  )

  return {
    calldata: scheduleCalldata,
    targetAddress: timelockAddress,
  }
}
