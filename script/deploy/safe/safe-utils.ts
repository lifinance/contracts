import {
  Abi,
  Address,
  Chain,
  Client,
  Hex,
  PublicClient,
  Transport,
  WalletClient,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  hashMessage,
  hashTypedData,
  hexToBytes,
  http,
  parseAbiParameters,
  toBytes,
  concat,
  keccak256,
  recoverMessageAddress,
  recoverPublicKey,
  signMessage,
  getAddress,
  encodePacked,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SAFE_SINGLETON_ABI } from './config'

// Types for Safe transactions
export enum OperationType {
  Call = 0,
  DelegateCall = 1,
}

export interface SafeTransactionData {
  to: Address
  value: bigint
  data: Hex
  operation: OperationType
  nonce: bigint
}

export interface SafeTransaction {
  data: SafeTransactionData
  signatures: Map<string, SafeSignature>
}

export interface SafeSignature {
  signer: Address
  data: Hex
}

interface SafeEIP712Domain {
  chainId: bigint
  verifyingContract: Address
}

const EIP712_SAFE_TX_TYPE = {
  SafeTx: [
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'value' },
    { type: 'bytes', name: 'data' },
    { type: 'uint8', name: 'operation' },
    { type: 'uint256', name: 'safeTxGas' },
    { type: 'uint256', name: 'baseGas' },
    { type: 'uint256', name: 'gasPrice' },
    { type: 'address', name: 'gasToken' },
    { type: 'address', name: 'refundReceiver' },
    { type: 'uint256', name: 'nonce' },
  ],
}

export class ViemSafe {
  private publicClient: PublicClient
  private walletClient: WalletClient
  private safeAddress: Address
  private account: Address

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    safeAddress: Address,
    account: Address
  ) {
    this.publicClient = publicClient
    this.walletClient = walletClient
    this.safeAddress = safeAddress
    this.account = account
  }

  static async init(options: {
    provider: string | Chain
    privateKey: string
    safeAddress: Address
  }): Promise<ViemSafe> {
    const { privateKey, safeAddress, provider } = options

    // Create provider and signer with Viem
    let publicClient: PublicClient
    if (typeof provider === 'string') {
      publicClient = createPublicClient({
        transport: http(provider),
      })
    } else {
      publicClient = createPublicClient({
        chain: provider,
        transport: http(),
      })
    }

    const account = privateKeyToAccount(
      `0x${privateKey.replace(/^0x/, '')}` as Hex
    )
    const walletClient = createWalletClient({
      account,
      transport: http(typeof provider === 'string' ? provider : undefined),
    })

    return new ViemSafe(
      publicClient,
      walletClient,
      safeAddress,
      account.address
    )
  }

  // Get Safe address
  async getAddress(): Promise<Address> {
    return this.safeAddress
  }

  // Get nonce from Safe contract (replaces getNonce from Safe SDK)
  async getNonce(): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'nonce',
    })
  }

  // Get owners from Safe contract (replaces getOwners from Safe SDK)
  async getOwners(): Promise<Address[]> {
    return await this.publicClient.readContract({
      address: this.safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'getOwners',
    })
  }

  // Get threshold from Safe contract (replaces getThreshold from Safe SDK)
  async getThreshold(): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'getThreshold',
    })
  }

  // Create a Safe transaction (replaces createTransaction from Safe SDK)
  async createTransaction(options: {
    transactions: {
      to: Address
      value: string | bigint
      data: Hex
      operation?: OperationType
      nonce?: bigint
    }[]
  }): Promise<SafeTransaction> {
    const tx = options.transactions[0] // We only handle single transactions for now
    const nonce = tx.nonce !== undefined ? tx.nonce : await this.getNonce()

    const safeTx: SafeTransaction = {
      data: {
        to: tx.to,
        value: typeof tx.value === 'string' ? BigInt(tx.value) : tx.value,
        data: tx.data,
        operation: tx.operation || OperationType.Call,
        nonce: nonce,
      },
      signatures: new Map(),
    }

    return safeTx
  }

  // Create a Safe transaction for adding an owner (replaces createAddOwnerTx from Safe SDK)
  async createAddOwnerTx(
    options: { ownerAddress: Address; threshold: bigint },
    txOptions?: { nonce?: bigint }
  ): Promise<SafeTransaction> {
    const data = encodeFunctionData({
      abi: SAFE_SINGLETON_ABI,
      functionName: 'addOwnerWithThreshold',
      args: [options.ownerAddress, options.threshold],
    })

    return this.createTransaction({
      transactions: [
        {
          to: this.safeAddress,
          value: 0n,
          data,
          nonce: txOptions?.nonce,
        },
      ],
    })
  }

  // Create a Safe transaction for changing the threshold (replaces createChangeThresholdTx from Safe SDK)
  async createChangeThresholdTx(
    threshold: number,
    txOptions?: { nonce?: bigint }
  ): Promise<SafeTransaction> {
    const data = encodeFunctionData({
      abi: SAFE_SINGLETON_ABI,
      functionName: 'changeThreshold',
      args: [BigInt(threshold)],
    })

    return this.createTransaction({
      transactions: [
        {
          to: this.safeAddress,
          value: 0n,
          data,
          nonce: txOptions?.nonce,
        },
      ],
    })
  }

  // Generate transaction hash (replaces getTransactionHash from Safe SDK)
  async getTransactionHash(safeTx: SafeTransaction): Promise<Hex> {
    const chainId = await this.publicClient.getChainId()

    return await this.publicClient.readContract({
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
        '0x0000000000000000000000000000000000000000', // gasToken
        '0x0000000000000000000000000000000000000000', // refundReceiver
        safeTx.data.nonce,
      ],
    })
  }

  // Sign a transaction hash (replaces signHash from Safe SDK)
  async signHash(hash: Hex): Promise<SafeSignature> {
    const signature = await this.walletClient.signMessage({
      message: { raw: hash },
    })

    return {
      signer: this.account,
      data: signature,
    }
  }

  // Sign a Safe transaction (replaces signTransaction from Safe SDK)
  async signTransaction(safeTx: SafeTransaction): Promise<SafeTransaction> {
    const hash = await this.getTransactionHash(safeTx)
    const signature = await this.signHash(hash)

    // Add signature to transaction
    safeTx.signatures.set(signature.signer.toLowerCase(), signature)

    return safeTx
  }

  // Format signatures as bytes for contract submission
  private formatSignatures(signatures: Map<string, SafeSignature>): Hex {
    // Convert Map to array and sort by signer address
    const sortedSigs = Array.from(signatures.values()).sort((a, b) =>
      a.signer.toLowerCase() > b.signer.toLowerCase() ? 1 : -1
    )

    // Concatenate all signatures as bytes
    let signatureBytes = '0x' as Hex
    for (const sig of sortedSigs) {
      signatureBytes = (signatureBytes + sig.data.slice(2)) as Hex
    }

    return signatureBytes
  }

  // Execute a Safe transaction (replaces executeTransaction from Safe SDK)
  async executeTransaction(safeTx: SafeTransaction): Promise<{ hash: Hex }> {
    const signatures = this.formatSignatures(safeTx.signatures)

    // Build transaction for execution
    const txHash = await this.walletClient.writeContract({
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
        '0x0000000000000000000000000000000000000000', // gasToken
        '0x0000000000000000000000000000000000000000', // refundReceiver
        signatures,
      ],
    })

    // Wait for transaction receipt
    await this.publicClient.waitForTransactionReceipt({ hash: txHash })

    return { hash: txHash }
  }
}

/**
 * Rest API client for interacting with the Safe Transaction Service
 */
export class ViemSafeContract {
  private txServiceUrl: string
  private chainId: bigint

  constructor(config: { txServiceUrl: string; chainId: bigint }) {
    this.txServiceUrl = config.txServiceUrl
    this.chainId = config.chainId
  }

  // Get Safe info (owners, threshold, etc.)
  async getSafeInfo(safeAddress: Address): Promise<{
    address: Address
    nonce: number
    threshold: number
    owners: Address[]
  }> {
    const url = `${this.txServiceUrl}/api/v1/safes/${safeAddress}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to get Safe info: ${response.statusText}`)
    }

    const data = await response.json()
    return {
      address: data.address,
      nonce: data.nonce,
      threshold: data.threshold,
      owners: data.owners,
    }
  }

  // Get next nonce for Safe
  async getNextNonce(safeAddress: Address): Promise<bigint> {
    const info = await this.getSafeInfo(safeAddress)
    return BigInt(info.nonce)
  }

  // Propose a transaction to the Safe Transaction Service
  async proposeTransaction(options: {
    safeAddress: Address
    safeTransactionData: SafeTransactionData
    safeTxHash: Hex
    senderAddress: Address
    senderSignature: Hex
  }): Promise<void> {
    const {
      safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
    } = options

    const body = {
      safe: safeAddress,
      to: safeTransactionData.to,
      value: safeTransactionData.value.toString(),
      data: safeTransactionData.data,
      operation: safeTransactionData.operation,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: safeTransactionData.nonce.toString(),
      contractTransactionHash: safeTxHash,
      sender: senderAddress,
      signature: senderSignature,
    }

    const url = `${this.txServiceUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Failed to propose transaction: ${response.statusText} - ${errorText}`
      )
    }
  }
}
