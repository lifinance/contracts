/**
 * Ledger HID Device Utilities
 *
 * This module provides utilities for connecting to a Ledger hardware device
 * and creating a viem-compatible account for signing transactions.
 * Requires @ledgerhq/hw-app-eth and @ledgerhq/hw-transport-node-hid packages.
 */

import type Transport from '@ledgerhq/hw-transport'
import { consola } from 'consola'
import type {
  Account,
  Address,
  Hex,
  TransactionSerializable,
  TypedData,
  TypedDataDefinition,
} from 'viem'

/**
 * Creates a viem-compatible account using a Ledger hardware wallet
 *
 * @param options Configuration options for the Ledger connection
 * @param options.derivationPath HD wallet derivation path (default: "m/44'/60'/0'/0/0")
 * @param options.ledgerLive Use Ledger Live derivation path if true
 * @param options.accountIndex Account index to use (default: 0, only used with ledgerLive: true)
 * @returns A viem-compatible account for transaction signing
 */
export async function getLedgerAccount(options?: {
  derivationPath?: string
  ledgerLive?: boolean
  accountIndex?: number
}): Promise<Account> {
  // Validate that incompatible options aren't provided together
  if (options?.derivationPath && options?.ledgerLive)
    throw new Error(
      "Cannot use both 'derivationPath' and 'ledgerLive' options together"
    )

  // Dynamically import Ledger packages to avoid issues if they're not installed
  const TransportNodeHid = await import('@ledgerhq/hw-transport-node-hid')
  const { default: Eth } = await import('@ledgerhq/hw-app-eth')

  // Determine the derivation path
  let derivationPath: string
  if (options?.ledgerLive) {
    // Ledger Live uses a different derivation path format
    const accountIndex = options?.accountIndex ?? 0
    derivationPath = `m/44'/60'/${accountIndex}'/0/0`
  }
  // Use provided path or default
  else derivationPath = options?.derivationPath ?? "m/44'/60'/0'/0/0"

  try {
    consola.info(`Connecting to Ledger device...`)
    consola.info(`Using derivation path: ${derivationPath}`)

    // Open connection to Ledger device
    const transport = await TransportNodeHid.default.create()
    const eth = new Eth(transport)

    // Get address from device
    const { address } = await eth.getAddress(derivationPath)
    consola.success(`Connected to Ledger with address: ${address}`)

    // Create and return a viem-compatible account
    return await createLedgerAccount({
      address: address as Address,
      transport,
      derivationPath,
    })
  } catch (error: any) {
    consola.error(`Failed to connect to Ledger device:`, error)
    throw new Error(`Ledger connection failed: ${error.message}`)
  }
}

/**
 * Creates a viem-compatible account from a Ledger transport
 *
 * @param params Configuration for the account
 * @param params.address The Ethereum address from the Ledger
 * @param params.transport The Ledger transport instance
 * @param params.derivationPath The derivation path used
 * @returns A viem-compatible account
 */
async function createLedgerAccount({
  address,
  transport,
  derivationPath,
}: {
  address: Address
  transport: Transport
  derivationPath: string
}): Promise<Account> {
  // Get the public key from Ledger
  const { default: Eth } = await import('@ledgerhq/hw-app-eth')
  const eth = new Eth(transport)
  const { publicKey } = await eth.getAddress(derivationPath)

  return {
    address,
    type: 'local',
    publicKey: `0x${publicKey}`,
    source: 'ledger',
    async signMessage({ message }) {
      const Eth = (await import('@ledgerhq/hw-app-eth')).default
      const eth = new Eth(transport)

      let messageHex: string
      if (typeof message === 'string')
        // Convert string message to hex
        messageHex = Buffer.from(message).toString('hex')
      else if ('raw' in message)
        // Use raw hex data directly
        messageHex = (message.raw as Hex).replace(/^0x/, '')
      else throw new Error('Unsupported message format for Ledger signing')

      // Sign the message with Ledger device
      const result = await eth.signPersonalMessage(derivationPath, messageHex)

      // Format the signature for Ethereum
      return `0x${result.r}${result.s}${result.v.toString(16)}`
    },
    async signTransaction<
      TTransactionSerializable extends TransactionSerializable
    >(transaction: TTransactionSerializable) {
      try {
        // Load all needed imports first
        const { default: Eth } = await import('@ledgerhq/hw-app-eth')
        const { serializeTransaction } = await import('viem')

        // Create Eth instance
        const eth = new Eth(transport)

        // Get the chain ID from the transaction or default to mainnet
        const chainId = transaction.chainId ?? 1

        // Create a transaction object with chainId explicitly included
        const txWithChainId = {
          ...transaction,
          chainId,
        }

        // Serialize the transaction to hex format as required by Ledger
        const serializedTx = serializeTransaction(txWithChainId)

        // Use the raw hex without '0x' prefix as required by Ledger
        const rawTxHex = serializedTx.slice(2)

        // Import Ledger transaction resolution service
        const { ledgerService } = await import('@ledgerhq/hw-app-eth')

        // First, resolve the transaction to provide metadata to the Ledger
        consola.log('Resolving transaction with Ledger service...')
        let resolution = null
        try {
          // This provides context for the transaction to be displayed on the Ledger device
          resolution = await ledgerService.resolveTransaction(
            rawTxHex,
            {}, // LoadConfig - using default configuration
            {
              externalPlugins: true, // Enable external plugins for better transaction information
              erc20: true, // Enable ERC20 token resolution
            }
          )
          consola.log('Transaction resolved successfully with Ledger service')
        } catch (resolveError) {
          consola.warn(
            'Failed to resolve transaction with Ledger service:',
            resolveError
          )
          consola.log('Continuing with null resolution (blind signing)')
          // Proceed with null resolution which will lead to "blind signing" on the device
        }

        // Sign the transaction with the Ledger device
        // According to Ledger docs:
        // - path: BIP32 path
        // - rawTxHex: Raw transaction hex (without 0x prefix)
        // - resolution: Optional transaction metadata
        consola.log('Requesting signature from Ledger device...')
        consola.log(`Using derivation path: ${derivationPath}`)

        const signature = await eth.signTransaction(
          derivationPath,
          rawTxHex,
          resolution
        )

        // We can use viem's serializeTransaction to create the final signed transaction
        const { serializeTransaction: serializeSignedTransaction } =
          await import('viem')

        // Create a signed transaction object with the signature from Ledger
        const signedTx = {
          ...txWithChainId, // Original transaction data

          // Add signature components from Ledger
          r: `0x${signature.r}`,
          s: `0x${signature.s}`,
          v: BigInt(`0x${signature.v}`),
        }

        // Serialize the signed transaction
        const serializedSignedTx = serializeSignedTransaction(signedTx)

        return serializedSignedTx
      } catch (error: any) {
        consola.error('Error in Ledger signTransaction:', error)
        throw new Error(`Ledger transaction signing failed: ${error.message}`)
      }
    },
    // Implement signTypedData method for EIP-712 support
    async signTypedData<
      const TTypedData extends TypedData | Record<string, unknown>,
      TPrimaryType extends keyof TTypedData | 'EIP712Domain' = keyof TTypedData
    >(parameters: TypedDataDefinition<TTypedData, TPrimaryType>) {
      const { default: Eth } = await import('@ledgerhq/hw-app-eth')
      const eth = new Eth(transport)

      // Encode the typed data according to EIP-712
      // Sign the typed data with Ledger
      // Note: Some Ledger firmware versions might not support all EIP-712 features
      const result = await eth.signEIP712Message(derivationPath, {
        domain: parameters.domain as Partial<{
          name: string
          chainId: number
          version: string
          verifyingContract: string
          salt: string
        }>,
        types: parameters.types as any,
        primaryType: parameters.primaryType,
        message: parameters.message as Record<string, unknown>,
      })

      // Format the signature
      return `0x${result.r}${result.s}${result.v.toString(16)}`
    },
  }
}

/**
 * Utility function to get multiple Ledger accounts
 *
 * @param count Number of accounts to get (default: 3)
 * @param startIndex Starting index (default: 0)
 * @param ledgerLive Use Ledger Live derivation path if true
 * @returns Array of viem accounts
 */
export async function getLedgerAccounts(
  count = 3,
  startIndex = 0,
  ledgerLive = true
): Promise<Account[]> {
  const accounts: Account[] = []

  consola.info(
    `Getting ${count} Ledger accounts starting from index ${startIndex}...`
  )

  for (let i = 0; i < count; i++) {
    const index = startIndex + i
    try {
      const account = await getLedgerAccount({
        ledgerLive,
        accountIndex: index,
      })
      accounts.push(account)
      consola.success(`Got account ${i + 1}/${count}: ${account.address}`)
    } catch (error) {
      consola.error(`Failed to get account at index ${index}:`, error)
      break
    }
  }

  return accounts
}
