/**
 * Ledger HID Device Utilities
 *
 * This module provides utilities for connecting to a Ledger hardware device
 * and creating a viem-compatible account for signing transactions.
 * Requires @ledgerhq/hw-app-eth and @ledgerhq/hw-transport-node-hid packages.
 */

import type { Account, Address, Hex, Transport } from 'viem'
import consola from 'consola'

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
  // Dynamically import Ledger packages to avoid issues if they're not installed
  const TransportNodeHid = await import('@ledgerhq/hw-transport-node-hid')
  const { default: Eth } = await import('@ledgerhq/hw-app-eth')

  // Determine the derivation path
  let derivationPath: string
  if (options?.ledgerLive) {
    // Ledger Live uses a different derivation path format
    const accountIndex = options?.accountIndex ?? 0
    derivationPath = `m/44'/60'/${accountIndex}'/0/0`
  } else {
    // Use provided path or default
    derivationPath = options?.derivationPath ?? "m/44'/60'/0'/0/0"
  }

  try {
    consola.info(`Connecting to Ledger device...`)
    consola.info(`Using derivation path: ${derivationPath}`)

    consola.info(
      `TransportNodeHid: ${JSON.stringify(TransportNodeHid, null, 2)}`
    )

    // Open connection to Ledger device
    const transport = await TransportNodeHid.default.create()
    const eth = new Eth(transport)

    // Get address from device
    const { address } = await eth.getAddress(derivationPath)
    consola.success(`Connected to Ledger with address: ${address}`)

    // Create and return a viem-compatible account
    return createLedgerAccount({
      address: address as Address,
      transport,
      derivationPath,
    })
  } catch (error) {
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
function createLedgerAccount({
  address,
  transport,
  derivationPath,
}: {
  address: Address
  transport: Transport
  derivationPath: string
}): Account {
  return {
    address,
    type: 'ledger',
    async signMessage({ message }) {
      const Eth = (await import('@ledgerhq/hw-app-eth')).default
      const eth = new Eth(transport)

      let messageHex: string
      if (typeof message === 'string') {
        // Convert string message to hex
        messageHex = Buffer.from(message).toString('hex')
      } else if ('raw' in message) {
        // Use raw hex data directly
        messageHex = (message.raw as Hex).replace(/^0x/, '')
      } else {
        throw new Error('Unsupported message format for Ledger signing')
      }

      // Sign the message with Ledger device
      const result = await eth.signPersonalMessage(derivationPath, messageHex)

      // Format the signature for Ethereum
      return `0x${result.r}${result.s}${result.v.toString(16)}`
    },
    async signTransaction(transactionRequest: any) {
      const { Ethereum } = await import('@ledgerhq/hw-app-eth')
      const { serializeTransaction } = await import('viem')
      const { getChainId } = await import('viem/actions')

      const eth = new Ethereum(transport)

      // Get the chain ID from the client
      const chainId =
        transactionRequest.chainId ??
        (transactionRequest.client
          ? await getChainId(transactionRequest.client)
          : 1) // Default to Ethereum mainnet

      // Serialize the transaction for signing
      const serializedTx = serializeTransaction({
        ...transactionRequest,
        chainId,
      })

      // Sign the transaction with Ledger device
      const signature = await eth.signTransaction(
        derivationPath,
        serializedTx.slice(2) // Remove '0x' prefix
      )

      // Return signed transaction hex
      return `0x${signature.r}${signature.s}${signature.v.toString(16)}`
    },
    // Implement signTypedData method for EIP-712 support
    async signTypedData(params: any) {
      const { Ethereum } = await import('@ledgerhq/hw-app-eth')
      const eth = new Ethereum(transport)

      // Encode the typed data according to EIP-712
      const domainSeparator = params.domain
      const types = params.types
      const message = params.message

      // Sign the typed data with Ledger
      // Note: Some Ledger firmware versions might not support all EIP-712 features
      const result = await eth.signEIP712HashedMessage(
        derivationPath,
        JSON.stringify({
          domain: domainSeparator,
          types,
          message,
        })
      )

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
