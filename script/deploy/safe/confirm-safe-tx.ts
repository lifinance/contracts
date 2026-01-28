/**
 * Confirm Safe Transactions
 *
 * This script allows users to confirm and execute pending Safe transactions.
 * It fetches pending transactions from MongoDB, displays their details,
 * and provides options to sign and/or execute them.
 */

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
import { type Collection } from 'mongodb'
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
} from 'viem'

import networksData from '../../../config/networks.json'
import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { buildExplorerContractPageUrl } from '../../utils/viemScriptHelpers'

import type { ILedgerAccountResult } from './ledger'
import {
  decodeDiamondCut,
  decodeTransactionData,
  getNetworksWithActionableTransactions,
  getNetworksWithPendingTransactions,
  getPendingTransactionsByNetwork,
  getPrivateKey,
  getSafeMongoCollection,
  hasEnoughSignatures,
  initializeSafeClient,
  initializeSafeTransaction,
  isAddressASafeOwner,
  isSignedByCurrentSigner,
  isSignedByProductionWallet,
  PrivateKeyTypeEnum,
  shouldShowSignAndExecuteWithDeployer,
  wouldMeetThreshold,
  type IAugmentedSafeTxDocument,
  type ISafeTransaction,
  type ISafeTxDocument,
  type ViemSafe,
} from './safe-utils'

dotenv.config()

const storedResponses: Record<string, string> = {}

interface IWhitelistContractSelectorMeta {
  contractLabel?: string
  signature?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let whitelistCache: unknown | undefined
function getWhitelistJson(): unknown {
  if (whitelistCache) return whitelistCache

  // Read from repo root so script works regardless of TS JSON settings
  const whitelistPath = path.join(process.cwd(), 'config', 'whitelist.json')
  const raw = fs.readFileSync(whitelistPath, 'utf8')
  whitelistCache = JSON.parse(raw)
  return whitelistCache
}

function safeNormalizeAddress(address: string): string {
  try {
    return getAddress(address as Address).toLowerCase()
  } catch {
    return address.toLowerCase()
  }
}

function computeSelectorFromSignature(signature: string): string {
  const hash = keccak256(stringToHex(signature))
  return `0x${hash.slice(2, 10)}`
}

function lookupWhitelistMetaForContractSelector(
  network: string,
  contractAddress: string,
  selector: string
): IWhitelistContractSelectorMeta {
  const whitelist = getWhitelistJson()
  if (!isRecord(whitelist)) return {}

  const networkKey = network.toLowerCase()
  const addr = safeNormalizeAddress(contractAddress)
  const sel = selector.toLowerCase()

  // 1) PERIPHERY has explicit name + selectors[] entries.
  const peripheryRoot = whitelist['PERIPHERY']
  if (isRecord(peripheryRoot)) {
    const peripheryNetwork = peripheryRoot[networkKey]
    if (Array.isArray(peripheryNetwork)) {
      const entry = peripheryNetwork.find((e) => {
        if (!isRecord(e)) return false
        const address = typeof e.address === 'string' ? e.address : ''
        return safeNormalizeAddress(address) === addr
      })

      if (isRecord(entry)) {
        const entryName =
          typeof entry.name === 'string' ? entry.name : undefined
        const selectorsArr = entry.selectors

        let signature: string | undefined
        if (Array.isArray(selectorsArr)) {
          const selectorEntry = selectorsArr.find((s) => {
            if (!isRecord(s)) return false
            const sSel = typeof s.selector === 'string' ? s.selector : ''
            return sSel.toLowerCase() === sel
          })
          if (isRecord(selectorEntry)) {
            const sig = selectorEntry.signature
            if (typeof sig === 'string') signature = sig
          }
        }

        return {
          contractLabel: entryName ? `PERIPHERY/${entryName}` : 'PERIPHERY',
          signature: signature ? String(signature) : undefined,
        }
      }
    }
  }

  // 2) Generic: any top-level array section with items that have `.contracts[networkKey]`
  //    mapping to [{ address, functions: { [selector]: signature } }].
  for (const [sectionKey, sectionVal] of Object.entries(whitelist)) {
    if (!Array.isArray(sectionVal)) continue

    for (const item of sectionVal) {
      if (!isRecord(item)) continue

      const contracts = item.contracts
      if (!isRecord(contracts)) continue

      const contractsByNetwork = contracts[networkKey]
      if (!Array.isArray(contractsByNetwork)) continue

      const contractEntry = contractsByNetwork.find((c) => {
        if (!isRecord(c)) return false
        const address = typeof c.address === 'string' ? c.address : ''
        return safeNormalizeAddress(address) === addr
      })
      if (!isRecord(contractEntry)) continue

      let signature: string | undefined
      const functions = contractEntry.functions
      if (isRecord(functions)) {
        const sig = functions[sel]
        if (typeof sig === 'string') signature = sig
      }

      const itemName = typeof item.name === 'string' ? item.name : undefined
      return {
        contractLabel: itemName ? `${sectionKey}/${itemName}` : sectionKey,
        signature: signature ? String(signature) : undefined,
      }
    }
  }

  return {}
}

/**
 * Gets the name of a target address by matching it against known contracts
 * @param address - The address to look up
 * @param network - The network name
 * @returns The contract name or empty string if not found
 */
async function getTargetName(
  address: Address,
  network: string
): Promise<string> {
  try {
    const normalizedAddress = getAddress(address).toLowerCase()
    const networkKey = network.toLowerCase() as SupportedChain

    // Check safe address from networks.json
    const networkConfig = networksData[networkKey as keyof typeof networksData]
    if (networkConfig?.safeAddress) {
      const safeAddress = getAddress(networkConfig.safeAddress).toLowerCase()
      if (safeAddress === normalizedAddress) return '(Multisig Safe)'
    }

    // Check deployment addresses (diamond and timelock)
    try {
      const deployments = await getDeployments(
        networkKey,
        EnvironmentEnum.production
      )

      // Check diamond address
      if (deployments.LiFiDiamond) {
        const diamondAddress = getAddress(
          deployments.LiFiDiamond as Address
        ).toLowerCase()
        if (diamondAddress === normalizedAddress) return '(LiFiDiamond)'
      }

      // Check timelock address
      if (deployments.LiFiTimelockController) {
        const timelockAddress = getAddress(
          deployments.LiFiTimelockController as Address
        ).toLowerCase()
        if (timelockAddress === normalizedAddress)
          return '(LiFiTimelockController)'
      }
    } catch (error) {
      // Deployment file might not exist for this network, continue silently
    }
  } catch (error) {
    // If address normalization fails, return empty string
  }

  return ''
}

// Global arrays to record execution failures and timeouts
const globalFailedExecutions: Array<{
  chain: string
  safeTxHash: string
  error: string
}> = []
const globalTimeoutExecutions: Array<{
  chain: string
  safeTxHash: string
  error: string
}> = []

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
  return this.toString()
}

/**
 * Decodes nested timelock schedule calls that may contain diamondCut
 * @param decoded - The decoded schedule function data
 * @param chainId - Chain ID for ABI fetching
 * @param network - Network name for address lookup
 */
async function decodeNestedTimelockCall(
  decoded: { functionName?: string; args?: unknown[] },
  chainId: number,
  network: string
) {
  if (decoded.functionName === 'schedule') {
    consola.info('Timelock Schedule Details:')
    consola.info('-'.repeat(80))

    if (
      !decoded.args ||
      !Array.isArray(decoded.args) ||
      decoded.args.length < 6
    ) {
      consola.warn('Invalid decoded args for timelock schedule')
      return
    }

    const [target, value, data, predecessor, salt, delay] = decoded.args

    // Get target name for display (network is available from chain context)
    const targetName = await getTargetName(target as Address, network)
    const targetDisplay = targetName
      ? `${target} \u001b[33m${targetName}\u001b[0m`
      : target

    consola.info(`Target:      \u001b[32m${targetDisplay}\u001b[0m`)
    consola.info(`Value:       \u001b[32m${value}\u001b[0m`)
    consola.info(`Predecessor: \u001b[32m${predecessor}\u001b[0m`)
    consola.info(`Salt:        \u001b[32m${salt}\u001b[0m`)
    consola.info(`Delay:       \u001b[32m${delay}\u001b[0m seconds`)
    consola.info('-'.repeat(80))

    // Try to decode the nested data
    if (data && data !== '0x')
      try {
        const nestedDecoded = await decodeTransactionData(data as Hex)
        if (nestedDecoded.functionName) {
          consola.info(
            `Nested Function: \u001b[34m${nestedDecoded.functionName}\u001b[0m`
          )

          // If the nested call is diamondCut, decode it further
          if (nestedDecoded.functionName.includes('diamondCut')) {
            const fullAbiString = `function ${nestedDecoded.functionName}`
            const abiInterface = parseAbi([fullAbiString])
            const nestedDecodedData = decodeFunctionData({
              abi: abiInterface,
              data: data as Hex,
            })

            if (nestedDecodedData.functionName === 'diamondCut') {
              consola.info('Nested Diamond Cut detected - decoding...')
              await decodeDiamondCut(nestedDecodedData, chainId)
            } else
              consola.info(
                'Nested Data:',
                JSON.stringify(nestedDecodedData, null, 2)
              )
          }
          // Decode the nested function arguments properly
          else
            try {
              const fullAbiString = `function ${nestedDecoded.functionName}`
              const abiInterface = parseAbi([fullAbiString])
              const nestedDecodedData = decodeFunctionData({
                abi: abiInterface,
                data: data as Hex,
              })

              if (nestedDecodedData.args && nestedDecodedData.args.length > 0) {
                if (
                  nestedDecodedData.functionName ===
                  'batchSetContractSelectorWhitelist'
                ) {
                  formatBatchSetContractSelectorWhitelist(
                    nestedDecodedData.args,
                    network
                  )
                } else if (
                  nestedDecodedData.functionName === 'registerPeripheryContract'
                ) {
                  consola.info('Nested Decoded Arguments:')
                  nestedDecodedData.args.forEach(
                    (arg: unknown, index: number) => {
                      // Handle different types of arguments
                      let displayValue = arg
                      if (typeof arg === 'bigint') displayValue = arg.toString()
                      else if (typeof arg === 'object' && arg !== null)
                        displayValue = JSON.stringify(arg)

                      // Special handling for address argument (index 1)
                      if (index === 1 && typeof arg === 'string') {
                        const address = arg as string
                        let addressLine = `  [${index}]: \u001b[33m${address}\u001b[0m`
                        const explorerUrl = buildExplorerContractPageUrl(
                          network,
                          address
                        )
                        if (explorerUrl)
                          addressLine += ` \u001b[36m${explorerUrl}\u001b[0m`
                        consola.info(addressLine)
                      } else {
                        consola.info(
                          `  [${index}]: \u001b[33m${displayValue}\u001b[0m`
                        )
                      }
                    }
                  )
                } else {
                  consola.info('Nested Decoded Arguments:')
                  nestedDecodedData.args.forEach(
                    (arg: unknown, index: number) => {
                      // Handle different types of arguments
                      let displayValue = arg
                      if (typeof arg === 'bigint') displayValue = arg.toString()
                      else if (typeof arg === 'object' && arg !== null)
                        displayValue = JSON.stringify(arg)

                      consola.info(
                        `  [${index}]: \u001b[33m${displayValue}\u001b[0m`
                      )
                    }
                  )
                }
              } else
                consola.info(
                  'No nested arguments or failed to decode nested arguments'
                )
            } catch (decodeError: unknown) {
              const errorMsg =
                decodeError instanceof Error
                  ? decodeError.message
                  : String(decodeError)
              consola.warn(
                `Failed to decode nested function arguments: ${errorMsg}`
              )
              consola.info(
                'Nested Data:',
                JSON.stringify(nestedDecoded.decodedData, null, 2)
              )
            }
        } else consola.info(`Nested Data: ${data}`)
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.warn(`Failed to decode nested data: ${errorMsg}`)
        consola.info(`Raw nested data: ${data}`)
      }
  }
}

/**
 * Formats and displays batchSetContractSelectorWhitelist arguments in a readable, grouped format
 * @param args - Decoded function arguments: [contracts: address[], selectors: bytes4[], whitelisted: bool]
 */
function formatBatchSetContractSelectorWhitelist(
  args: readonly unknown[],
  network?: string
) {
  if (!args || args.length < 3) {
    consola.warn('Invalid arguments for batchSetContractSelectorWhitelist')
    return
  }

  const contracts = args[0] as readonly string[]
  const selectors = args[1] as readonly string[]
  const whitelisted = args[2] as boolean

  // Validate arrays have same length
  if (contracts.length !== selectors.length) {
    consola.warn(
      `Mismatch: contracts array length (${contracts.length}) != selectors array length (${selectors.length})`
    )
    return
  }

  // Group selectors by contract address
  const contractToSelectors = new Map<string, string[]>()
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i]?.toLowerCase()
    const selector = selectors[i]

    if (!contract || !selector) continue

    if (!contractToSelectors.has(contract)) {
      contractToSelectors.set(contract, [])
    }
    const selectorList = contractToSelectors.get(contract)
    if (selectorList) {
      selectorList.push(selector)
    }
  }

  // Display action type
  const actionText = whitelisted ? 'Adding pairs' : 'Removing pairs'
  const actionColor = whitelisted ? '\u001b[32m' : '\u001b[33m' // Green for adding, yellow for removing
  consola.info(`Action: ${actionColor}${actionText}\u001b[0m`)
  consola.info(`Total pairs: ${contracts.length}`)
  consola.info('Pairs:')

  // Display grouped pairs
  contractToSelectors.forEach((selectorList, contract) => {
    // Find original case for contract address (use first occurrence)
    const originalContract =
      contracts.find((c) => c.toLowerCase() === contract) || contract

    let contractLabel = ''
    if (network) {
      const meta = lookupWhitelistMetaForContractSelector(
        network,
        originalContract,
        selectorList[0] ?? ''
      )
      if (meta.contractLabel)
        contractLabel = ` \u001b[35m(${meta.contractLabel})\u001b[0m`
    }

    let contractLine = `  Contract: \u001b[34m${originalContract}\u001b[0m${contractLabel}`
    if (network) {
      const explorerUrl = buildExplorerContractPageUrl(
        network,
        originalContract
      )
      if (explorerUrl) contractLine += ` \u001b[36m${explorerUrl}\u001b[0m`
    }
    consola.info(contractLine)
    consola.info('    Selectors:')
    selectorList.forEach((selector) => {
      if (!network) {
        consola.info(`      - \u001b[33m${selector}\u001b[0m`)
        return
      }

      const meta = lookupWhitelistMetaForContractSelector(
        network,
        originalContract,
        selector
      )
      const signature = meta.signature?.trim()
      if (!signature) {
        consola.info(
          `      - \u001b[33m${selector}\u001b[0m \u001b[90m(signature unknown in whitelist)\u001b[0m`
        )
        return
      }

      const expected = computeSelectorFromSignature(signature)
      const ok = expected.toLowerCase() === selector.toLowerCase()
      const status = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
      const mismatch = ok ? '' : ` \u001b[31m(expected ${expected})\u001b[0m`
      consola.info(
        `      - \u001b[33m${selector}\u001b[0m \u001b[36m${signature}\u001b[0m ${status}${mismatch}`
      )
    })
  })
}

/**
 * Main function to process Safe transactions for a given network
 * @param network - Network name
 * @param privateKey - Private key of the signer (optional if useLedger is true)
 * @param privKeyType - Type of private key (SAFE_SIGNER or DEPLOYER)
 * @param pendingTxs - Pending transactions to process
 * @param pendingTransactions - MongoDB collection
 * @param rpcUrl - Optional RPC URL override
 * @param useLedger - Whether to use a Ledger device for signing
 * @param ledgerOptions - Options for Ledger connection
 */
const processTxs = async (
  network: string,
  privateKey: string | undefined,
  privKeyType: PrivateKeyTypeEnum,
  pendingTxs: ISafeTxDocument[],
  pendingTransactions: Collection<ISafeTxDocument>,
  rpcUrl?: string,
  useLedger?: boolean,
  ledgerOptions?: {
    derivationPath?: string
    ledgerLive?: boolean
    accountIndex?: number
  },
  account?: Account
) => {
  consola.info(' ')
  consola.info('-'.repeat(80))

  // Initialize Safe client using safeAddress from first transaction
  const txSafeAddress = pendingTxs[0]?.safeAddress as Address
  const { safe, chain, safeAddress } = await initializeSafeClient(
    network,
    privateKey,
    rpcUrl,
    useLedger,
    ledgerOptions,
    txSafeAddress,
    account
  )

  // Get signer address
  const signerAddress = safe.account.address

  consola.info('Chain:', chain.name)
  consola.info('Signer:', signerAddress)

  // Check if the current signer is an owner
  try {
    const existingOwners = await safe.getOwners()
    if (!isAddressASafeOwner(existingOwners, signerAddress)) {
      consola.error('The current signer is not an owner of this Safe')
      consola.error('Signer address:', signerAddress)
      consola.error('Current owners:', existingOwners)
      consola.error('Cannot sign or execute transactions - exiting')
      return
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.error(`Failed to check if signer is an owner: ${errorMsg}`)
    consola.error('Skipping this network and moving to the next one')
    return
  }

  /**
   * Signs a SafeTransaction
   * @param safeTransaction - The transaction to sign
   * @returns The signed transaction
   */
  const signTransaction = async (safeTransaction: ISafeTransaction) => {
    consola.info('Signing transaction')
    try {
      const signedTx = await safe.signTransaction(safeTransaction)
      consola.success('Transaction signed')
      return signedTx
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error('Error signing transaction:', error)
      throw new Error(`Failed to sign transaction: ${errorMsg}`)
    }
  }

  /**
   * Executes a SafeTransaction and updates its status in MongoDB
   * @param safeTransaction - The transaction to execute
   * @param safeClient - The Safe client to use for execution (defaults to main safe client)
   */
  async function executeTransaction(
    safeTransaction: ISafeTransaction,
    safeClient: ViemSafe = safe
  ) {
    consola.info('Preparing to execute Safe transaction...')
    let safeTxHash = ''
    try {
      // Get the Safe transaction hash for reference
      safeTxHash = await safeClient.getTransactionHash(safeTransaction)
      consola.info(`Safe Transaction Hash: \u001b[36m${safeTxHash}\u001b[0m`)

      // Execute the transaction on-chain (timeout/polling handled in safeClient)
      consola.info('Submitting execution transaction to blockchain...')
      const exec = await safeClient.executeTransaction(safeTransaction)
      const executionHash = exec.hash

      consola.success(`✅ Transaction submitted successfully`)

      // Update MongoDB transaction status
      await pendingTransactions.updateOne(
        { safeTxHash: safeTxHash },
        { $set: { status: 'executed', executionHash: executionHash } }
      )

      if (exec.receipt)
        consola.success(
          `✅ Safe transaction confirmed and recorded in database`
        )
      else
        consola.success(
          `✅ Safe transaction submitted and recorded in database (confirmation pending)`
        )

      consola.info(`   - Safe Tx Hash:   \u001b[36m${safeTxHash}\u001b[0m`)
      consola.info(`   - Execution Hash: \u001b[33m${executionHash}\u001b[0m`)
      consola.log(' ')
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error('❌ Error executing Safe transaction:')
      consola.error(`   ${errorMsg}`)
      if (errorMsg.includes('GS026')) {
        consola.error(
          '   This appears to be a signature validation error (GS026).'
        )
        consola.error(
          '   Possible causes: invalid signature format or incorrect signer.'
        )
      }
      // Record error in global arrays
      if (errorMsg.toLowerCase().includes('timeout'))
        globalTimeoutExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: errorMsg,
        })
      else
        globalFailedExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: errorMsg,
        })

      throw new Error(`Transaction execution failed: ${errorMsg}`)
    }
  }

  // Get current threshold
  let threshold
  try {
    threshold = Number(await safe.getThreshold())
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.error(`Failed to get threshold: ${errorMsg}`)
    throw new Error(
      `Could not get threshold for Safe ${safeAddress} on ${network}`
    )
  }

  // Filter and augment transactions with signature status
  const txs = await Promise.all(
    pendingTxs.map(
      async (tx: ISafeTxDocument): Promise<IAugmentedSafeTxDocument> => {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
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
      }
    )
  ).then((txs: IAugmentedSafeTxDocument[]) =>
    txs.filter((tx) => {
      // If the transaction has enough signatures to execute AND the current signer has signed,
      // still show it so they can execute it
      if (tx.canExecute) return true

      // Otherwise, don't show transactions that have already been signed by the current signer
      if (tx.hasSignedAlready) return false

      // Show transactions that need more signatures
      return tx.safeTransaction.signatures.size < tx.threshold
    })
  )

  if (!txs.length) {
    consola.success('No pending transactions')
    return
  }

  // Sort transactions by nonce in ascending order to process them in sequence
  // This ensures we handle transactions in the correct order as required by the Safe
  for (const tx of txs.sort((a, b) => {
    if (a.safeTx.data.nonce < b.safeTx.data.nonce) return -1
    if (a.safeTx.data.nonce > b.safeTx.data.nonce) return 1
    return 0
  })) {
    let abi
    let abiInterface: Abi
    let decoded

    try {
      if (tx.safeTx.data) {
        const { functionName } = await decodeTransactionData(
          tx.safeTx.data.data as Hex
        )
        if (functionName) {
          abi = functionName
          const fullAbiString = `function ${abi}`
          abiInterface = parseAbi([fullAbiString])
          decoded = decodeFunctionData({
            abi: abiInterface,
            data: tx.safeTx.data.data as Hex,
          })
        }
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.warn(`Failed to decode transaction data: ${errorMsg}`)
    }

    consola.info('-'.repeat(80))
    consola.info('Transaction Details:')
    consola.info('-'.repeat(80))

    if (abi)
      if (decoded && decoded.functionName === 'diamondCut')
        await decodeDiamondCut(decoded, chain.id)
      else if (decoded && decoded.functionName === 'schedule') {
        await decodeNestedTimelockCall(
          {
            functionName: decoded.functionName,
            args: decoded.args ? [...decoded.args] : undefined,
          },
          chain.id,
          network
        )
      } else {
        consola.info('Method:', abi)
        if (decoded) {
          consola.info('Function Name:', decoded.functionName)

          // If this is a registerPeripheryContract call, show an explorer link for the periphery address.
          if (
            decoded.functionName === 'registerPeripheryContract' &&
            decoded.args &&
            decoded.args.length >= 2
          ) {
            const peripheryAddress = decoded.args[1] as string
            let peripheryLine = `Periphery Address: \u001b[34m${peripheryAddress}\u001b[0m`
            const explorerUrl = buildExplorerContractPageUrl(
              network,
              peripheryAddress
            )
            if (explorerUrl)
              peripheryLine += ` \u001b[36m${explorerUrl}\u001b[0m`
            consola.info(peripheryLine)
          }

          if (decoded.args && decoded.args.length > 0) {
            if (decoded.functionName === 'batchSetContractSelectorWhitelist') {
              formatBatchSetContractSelectorWhitelist(decoded.args, network)
            } else {
              consola.info('Decoded Arguments:')
              decoded.args.forEach((arg: unknown, index: number) => {
                // Handle different types of arguments
                let displayValue = arg
                if (typeof arg === 'bigint') displayValue = arg.toString()
                else if (typeof arg === 'object' && arg !== null)
                  displayValue = JSON.stringify(arg)

                consola.info(`  [${index}]: \u001b[33m${displayValue}\u001b[0m`)
              })
            }
          } else consola.info('No arguments or failed to decode arguments')

          // Only show full decoded data if it contains useful information beyond what we've already shown
          if (decoded.args === undefined)
            consola.info('Full Decoded Data:', JSON.stringify(decoded, null, 2))
        }
      }

    // Get target name for display
    const targetName = await getTargetName(tx.safeTx.data.to, network)
    const toDisplay = targetName
      ? `${tx.safeTx.data.to} \u001b[33m${targetName}\u001b[0m`
      : tx.safeTx.data.to

    consola.info(`Safe Transaction Details:
    Nonce:           \u001b[32m${tx.safeTx.data.nonce}\u001b[0m
    To:              \u001b[32m${toDisplay}\u001b[0m
    Value:           \u001b[32m${tx.safeTx.data.value}\u001b[0m
    Operation:       \u001b[32m${
      tx.safeTx.data.operation === 0 ? 'Call' : 'DelegateCall'
    }\u001b[0m
    Data:            \u001b[32m${tx.safeTx.data.data}\u001b[0m
    Proposer:        \u001b[32m${tx.proposer}\u001b[0m
    Safe Tx Hash:    \u001b[36m${tx.safeTxHash}\u001b[0m
    Signatures:      \u001b[32m${tx.safeTransaction.signatures.size}/${
      tx.threshold
    }\u001b[0m required
    Execution Ready: \u001b[${tx.canExecute ? '32m✓' : '31m✗'}\u001b[0m`)

    const storedResponse = tx.safeTx.data.data
      ? storedResponses[tx.safeTx.data.data]
      : undefined

    // Determine available actions based on signature status
    const canExecuteNow = hasEnoughSignatures(tx.safeTransaction, tx.threshold)
    const isDeployerCurrentSigner =
      !useLedger && privKeyType === PrivateKeyTypeEnum.DEPLOYER
    let action: string
    if (privKeyType === PrivateKeyTypeEnum.SAFE_SIGNER) {
      const options = ['Do Nothing']
      if (!tx.hasSignedAlready) {
        options.push('Sign')

        // Check if signing with current user + deployer (if needed) would meet threshold
        if (
          shouldShowSignAndExecuteWithDeployer(
            tx.safeTransaction,
            tx.threshold,
            signerAddress
          )
        )
          options.push('Sign and Execute With Deployer')
      }

      if (canExecuteNow) {
        options.push('Execute')
        options.push('Execute with Deployer')
      }

      action =
        storedResponse ||
        (await consola.prompt('Select action:', {
          type: 'select',
          options,
        }))
    } else {
      const options = ['Do Nothing']
      if (!tx.hasSignedAlready) {
        options.push('Sign')
        if (wouldMeetThreshold(tx.safeTransaction, tx.threshold))
          options.push('Sign & Execute')

        // Check if signing with current user + deployer (if needed) would meet threshold
        if (
          shouldShowSignAndExecuteWithDeployer(
            tx.safeTransaction,
            tx.threshold,
            signerAddress
          )
        )
          options.push('Sign and Execute With Deployer')
      }

      if (canExecuteNow) {
        options.push('Execute')
        if (!isDeployerCurrentSigner) options.push('Execute with Deployer')
      }

      action =
        storedResponse ||
        (await consola.prompt('Select action:', {
          type: 'select',
          options,
        }))
    }

    if (action === 'Do Nothing') continue

    // eslint-disable-next-line require-atomic-updates
    storedResponses[tx.safeTx.data.data] = action

    if (action === 'Sign')
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
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
        consola.success('Transaction signed and stored in MongoDB')
      } catch (error) {
        consola.error('Error signing transaction:', error)
      }

    if (action === 'Sign & Execute')
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
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
        consola.success('Transaction signed and stored in MongoDB')
        await executeTransaction(signedTx)
      } catch (error) {
        consola.error('Error signing and executing transaction:', error)
      }

    if (action === 'Sign and Execute With Deployer')
      try {
        // Step 1: Sign with current user
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        const signedTx = await signTransaction(safeTransaction)

        // Step 2: Update MongoDB with current user's signature
        await pendingTransactions.updateOne(
          { safeTxHash: tx.safeTxHash },
          {
            $set: {
              [`safeTx`]: signedTx,
            },
          }
        )
        consola.success('Transaction signed and stored in MongoDB')

        // Step 3: Initialize deployer Safe client
        consola.info('Initializing deployer wallet...')
        const deployerPrivateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
        const { safe: deployerSafe } = await initializeSafeClient(
          network,
          deployerPrivateKey,
          rpcUrl,
          false, // Not using ledger for deployer
          undefined,
          txSafeAddress
        )

        // Step 4: Check if deployer needs to sign
        const needsDeployerSignature = !isSignedByProductionWallet(signedTx)
        let finalTx = signedTx

        if (needsDeployerSignature) {
          consola.info('Deployer signature needed - signing with deployer...')
          // Sign with deployer
          const deployerSignedTx = await deployerSafe.signTransaction(signedTx)

          // Update MongoDB with deployer's signature
          await pendingTransactions.updateOne(
            { safeTxHash: tx.safeTxHash },
            {
              $set: {
                [`safeTx`]: deployerSignedTx,
              },
            }
          )
          consola.success(
            'Transaction signed with deployer and stored in MongoDB'
          )
          finalTx = deployerSignedTx
        } else
          consola.info(
            'Deployer has already signed - proceeding to execution...'
          )

        // Step 5: Execute with deployer using shared executeTransaction function
        const executeWithDeployer = async (
          safeTransaction: ISafeTransaction
        ) => {
          consola.info('Executing transaction with deployer wallet...')
          await executeTransaction(safeTransaction, deployerSafe)
        }

        await executeWithDeployer(finalTx)
      } catch (error) {
        consola.error(
          'Error signing and executing transaction with deployer:',
          error
        )
      }

    if (action === 'Execute')
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        await executeTransaction(safeTransaction)
      } catch (error) {
        consola.error('Error executing transaction:', error)
      }

    if (action === 'Execute with Deployer')
      try {
        const safeTransaction = await initializeSafeTransaction(tx, safe)
        consola.info('Initializing deployer wallet...')
        const deployerPrivateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
        const { safe: deployerSafe } = await initializeSafeClient(
          network,
          deployerPrivateKey,
          rpcUrl,
          false,
          undefined,
          txSafeAddress
        )
        await executeTransaction(safeTransaction, deployerSafe)
      } catch (error) {
        consola.error('Error executing transaction with deployer:', error)
      }
  }
  try {
    await safe.cleanup()
  } catch (e) {
    consola.error('Error:', e)
  }
}

/**
 * Main command definition for the script
 */
const main = defineCommand({
  meta: {
    name: 'confirm-safe-tx',
    description: 'Confirm and execute transactions in a Gnosis Safe',
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
      description: 'Private key of the signer (not needed if using --ledger)',
      required: false,
    },
    ledger: {
      type: 'boolean',
      description: 'Use Ledger hardware wallet for signing',
      required: false,
    },
    ledgerLive: {
      type: 'boolean',
      description: 'Use Ledger Live derivation path',
      required: false,
    },
    accountIndex: {
      type: 'string',
      description: 'Ledger account index (default: 0)',
      required: false,
    },
    derivationPath: {
      type: 'string',
      description: 'Custom derivation path for Ledger (overrides ledgerLive)',
      required: false,
    },
  },
  async run({ args }) {
    // Set up signing options
    let privateKey: string | undefined
    let keyType = PrivateKeyTypeEnum.DEPLOYER // default value
    const useLedger = args.ledger || false
    const ledgerOptions = {
      ledgerLive: args.ledgerLive || false,
      accountIndex: args.accountIndex ? Number(args.accountIndex) : 0,
      derivationPath: args.derivationPath,
    }

    // Validate that incompatible Ledger options aren't provided together
    if (args.derivationPath && args.ledgerLive)
      throw new Error(
        "Cannot use both 'derivationPath' and 'ledgerLive' options together"
      )

    // If using ledger, we don't need a private key
    if (useLedger) {
      consola.info('Using Ledger hardware wallet for signing')
      if (args.ledgerLive)
        consola.info(
          `Using Ledger Live derivation path with account index ${ledgerOptions.accountIndex}`
        )
      else if (args.derivationPath)
        consola.info(`Using custom derivation path: ${args.derivationPath}`)
      else consola.info(`Using default derivation path: m/44'/60'/0'/0/0`)

      privateKey = undefined
    } else if (!args.privateKey) {
      // If no private key and not using ledger, ask for key from env
      const keyChoice = await consola.prompt(
        'Which private key do you want to use from your .env file?',
        {
          type: 'select',
          options: ['PRIVATE_KEY_PRODUCTION', 'SAFE_SIGNER_PRIVATE_KEY'],
        }
      )

      privateKey = getPrivateKey(
        keyChoice as 'PRIVATE_KEY_PRODUCTION' | 'SAFE_SIGNER_PRIVATE_KEY'
      )
      keyType =
        keyChoice === 'SAFE_SIGNER_PRIVATE_KEY'
          ? PrivateKeyTypeEnum.SAFE_SIGNER
          : PrivateKeyTypeEnum.DEPLOYER
    } else privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)

    // Create ledger connection once if using ledger
    let ledgerResult: ILedgerAccountResult | undefined
    if (useLedger)
      try {
        const { getLedgerAccount } = await import('./ledger')
        ledgerResult = await getLedgerAccount(ledgerOptions)
        consola.success('Ledger connected successfully for all networks')
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.error(`Failed to connect to Ledger: ${errorMsg}`)
        throw error
      }

    try {
      // Connect to MongoDB early to use it for network detection
      const { client: mongoClient, pendingTransactions } =
        await getSafeMongoCollection()

      // Get signer address early (needed for filtering actionable networks)
      let signerAddress: Address
      if (useLedger && ledgerResult?.account) {
        signerAddress = ledgerResult.account.address
      } else if (privateKey) {
        const { privateKeyToAccount } = await import('viem/accounts')
        const account = privateKeyToAccount(`0x${privateKey}` as Hex)
        signerAddress = account.address
      } else {
        throw new Error('No signer available (missing private key or Ledger)')
      }

      let networks: string[]

      if (args.network) {
        // If a specific network is provided, validate it exists and is active
        const networkConfig =
          networksData[args.network.toLowerCase() as keyof typeof networksData]
        if (!networkConfig)
          throw new Error(`Network ${args.network} not found in networks.json`)

        if (networkConfig.status !== 'active')
          throw new Error(`Network ${args.network} is not active`)

        networks = [args.network]
      } else {
        // First, get all networks with pending transactions (for informational purposes)
        const allNetworksWithPendingTxs =
          await getNetworksWithPendingTransactions(pendingTransactions)

        if (allNetworksWithPendingTxs.length === 0) {
          consola.info('No networks have pending transactions')
          await mongoClient.close(true)
          return
        }

        consola.info(
          `Found pending transactions on ${
            allNetworksWithPendingTxs.length
          } network(s): ${allNetworksWithPendingTxs.join(', ')}`
        )
        consola.info(`Checking ownership for signer: ${signerAddress}`)

        // Filter to only networks where the user can take action (is a Safe owner)
        networks = await getNetworksWithActionableTransactions(
          pendingTransactions,
          signerAddress,
          privateKey,
          useLedger,
          ledgerOptions,
          ledgerResult?.account,
          args.rpcUrl
        )

        if (networks.length === 0) {
          consola.info(
            'No networks found where you can take action. All pending transactions are either already signed by you or have enough signatures to execute.'
          )
          consola.info('Check the summary above for details on each network.')
          await mongoClient.close(true)
          return
        }

        // Show which networks are actionable
        if (networks.length < allNetworksWithPendingTxs.length) {
          const nonActionableNetworks = allNetworksWithPendingTxs.filter(
            (n) => !networks.includes(n)
          )
          consola.info(
            `You can take action on ${
              networks.length
            } network(s): ${networks.join(', ')}`
          )
          consola.info(
            `Skipping ${
              nonActionableNetworks.length
            } network(s) where you are not a Safe owner: ${nonActionableNetworks.join(
              ', '
            )}`
          )
        } else {
          consola.info(
            `You can take action on all ${networks.length} network(s) with pending transactions`
          )
        }
      }

      // Fetch all pending transactions for the networks we're processing
      const txsByNetwork = await getPendingTransactionsByNetwork(
        pendingTransactions,
        networks
      )

      // Process transactions for each network
      for (const network of networks) {
        const networkTxs = txsByNetwork[network.toLowerCase()]
        if (!networkTxs || networkTxs.length === 0)
          // This should not happen with our new approach, but keep as safety check
          continue

        await processTxs(
          network,
          privateKey,
          keyType,
          networkTxs,
          pendingTransactions,
          args.rpcUrl,
          useLedger,
          ledgerOptions,
          ledgerResult?.account
        )
      }

      // Close MongoDB connection
      await mongoClient.close(true)
      // Print summary of any failed or timed out executions
      if (
        globalFailedExecutions.length > 0 ||
        globalTimeoutExecutions.length > 0
      ) {
        consola.info('=== Execution Summary ===')
        if (globalFailedExecutions.length > 0) {
          consola.info('Failed Executions:')
          globalFailedExecutions.forEach((item) => {
            consola.info(
              `Chain: ${item.chain}, SafeTxHash: ${item.safeTxHash}, Error: ${item.error}`
            )
          })
        }
        if (globalTimeoutExecutions.length > 0) {
          consola.info('Timed Out Executions (saved in MongoDB):')
          globalTimeoutExecutions.forEach((item) => {
            consola.info(
              `Chain: ${item.chain}, SafeTxHash: ${item.safeTxHash}, Error: ${item.error}`
            )
          })
        }
      }
    } finally {
      // Always close ledger connection if it was created
      if (ledgerResult) {
        const { closeLedgerConnection } = await import('./ledger')
        await closeLedgerConnection(ledgerResult.transport)
      }
    }
  },
})

runMain(main)
