/**
 * Move Native Funds to New Wallet
 *
 * This script transfers native tokens (ETH, MATIC, etc.) from an old wallet to a new wallet
 * across all supported networks in parallel.
 *
 * USAGE:
 *   bun run script/tasks/moveNativeFundsToNewWallet.ts <newWalletAddress> [options]
 *
 * REQUIRED ARGUMENTS:
 *   newWalletAddress    Address of the new wallet (where funds should be sent to)
 *
 * OPTIONAL ARGUMENTS:
 *   --private-key <key>           Private key of the old wallet (hex string, with or without 0x prefix)
 *   --private-key-env-key <key>  Environment variable key for private key (default: prompts for PRIVATE_KEY or PRIVATE_KEY_PRODUCTION)
 *
 * EXAMPLES:
 *   # Basic usage - will prompt for which private key to use from .env
 *   bun run script/tasks/moveNativeFundsToNewWallet.ts 0x1234567890123456789012345678901234567890
 *
 *   # Using a specific private key from command line
 *   bun run script/tasks/moveNativeFundsToNewWallet.ts 0x1234567890123456789012345678901234567890 --private-key 0xabcdef...
 *
 *   # Using a specific environment variable for private key
 *   bun run script/tasks/moveNativeFundsToNewWallet.ts 0x1234567890123456789012345678901234567890 --private-key-env-key PRIVATE_KEY_OLD
 *
 * NOTES:
 *   - The script will automatically derive the old wallet address from the provided private key
 *   - Transfers are executed in parallel batches (controlled by MAX_CONCURRENT_JOBS)
 *   - The script will skip networks with zero balance or insufficient balance to cover gas costs
 *   - Each network transfer is retried up to 5 times on failure
 *   - The script handles EIP-1559 and legacy gas pricing automatically
 *   - For EIP-7702 delegated addresses, the script uses cast send instead of viem
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { INetwork } from '../common/types'
import {
  getAllActiveNetworks,
  getViemChainForNetworkName,
  networks,
} from '../utils/viemScriptHelpers'
import { sleep } from '../utils/delay'

// ANSI color codes
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

const logSuccess = (msg: string) => console.log(`${GREEN}${msg}${RESET}`)
const logError = (msg: string) => console.log(`${RED}${msg}${RESET}`)

const MAX_RETRIES = 5
const HTTP_TIMEOUT = 15000
const TX_CONFIRMATION_TIMEOUT = 15000 // 15 seconds - most networks confirm in 1-5 seconds, this covers slower networks
const BALANCE_CHECK_TIMEOUT = 10000

function getMaxConcurrentJobs(): number {
  if (process.env.MAX_CONCURRENT_JOBS) {
    const parsed = parseInt(process.env.MAX_CONCURRENT_JOBS, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  try {
    const configPath = path.resolve('script/config.sh')
    if (fs.existsSync(configPath)) {
      const match = fs
        .readFileSync(configPath, 'utf-8')
        .match(/MAX_CONCURRENT_JOBS=(\d+)/)
      if (match?.[1]) {
        const parsed = parseInt(match[1], 10)
        if (!isNaN(parsed) && parsed > 0) return parsed
      }
    }
  } catch {
    // Fall through to default
  }
  return 100
}

const MAX_CONCURRENT_JOBS = getMaxConcurrentJobs()

interface ITransferResult {
  network: string
  success: boolean
  amount?: bigint
  txHash?: string
  error?: string
  skipReason?: 'zero_balance' | 'insufficient_balance'
  errorDetails?: string
  attempts?: number
  usedPremiumRpc?: boolean
}

interface INetworkTransferResult extends ITransferResult {
  amountFormatted?: string
  nativeCurrency?: string
}

interface IGasInfo {
  gasLimit: bigint
  gasPrice: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  supportsEIP1559: boolean
}

/**
 * Extract error message from viem error object
 * @param error - The error to extract message from
 * @param includeDetails - Whether to include verbose details (default: false)
 */
function extractErrorMessage(error: unknown, includeDetails = false): string {
  if (typeof error === 'string') return error
  if (!(error instanceof Error)) return String(error)

  const parts: string[] = [error.message]
  const obj = error as unknown as Record<string, unknown>

  // Prefer shortMessage if available (viem's concise error)
  if (obj.shortMessage && typeof obj.shortMessage === 'string') {
    parts.push(obj.shortMessage)
  }

  // Only include details if explicitly requested (for summary)
  if (includeDetails) {
    if (obj.details && typeof obj.details === 'string') parts.push(obj.details)
    if (obj.reason && typeof obj.reason === 'string') parts.push(obj.reason)

    if (obj.cause) {
      if (typeof obj.cause === 'string') parts.push(obj.cause)
      else if (obj.cause instanceof Error) parts.push(obj.cause.message)
    }
  }

  let message = parts.filter(Boolean).join(' ').trim() || error.message

  // Remove verbose sections that shouldn't be shown during execution
  if (!includeDetails) {
    // Remove "Request Arguments:" section and everything after it
    const requestArgsIndex = message.indexOf('Request Arguments:')
    if (requestArgsIndex !== -1) {
      message = message.substring(0, requestArgsIndex).trim()
    }

    // Remove "Details:" section and everything after it
    const detailsIndex = message.indexOf('Details:')
    if (detailsIndex !== -1) {
      message = message.substring(0, detailsIndex).trim()
    }

    // Remove "URL:" section and everything after it
    const urlIndex = message.indexOf('URL:')
    if (urlIndex !== -1) {
      message = message.substring(0, urlIndex).trim()
    }

    // Truncate very long messages
    if (message.length > 150) {
      message = message.substring(0, 150) + '...'
    }
  }

  return message
}

/**
 * Check if error indicates insufficient funds
 */
function isInsufficientFundsError(errorText: string): boolean {
  const patterns = [
    'insufficient funds',
    'exceeds the balance',
    'gas * price + value',
    'l1fee + gas * price + value',
    'ERR_GAS_PAYMENT_OUT_OF_FUND',
    'InsufficientFunds',
    'insufficient balance',
    // On Arbitrum and some L2s, insufficient funds during gas estimation shows as "gas required exceeds allowance"
    'gas required exceeds allowance',
  ]
  return patterns.some((p) => errorText.toLowerCase().includes(p.toLowerCase()))
}

/**
 * Check if error indicates gas estimation needed
 */
function isGasEstimationError(errorText: string): boolean {
  const patterns = [
    'intrinsic gas too low',
    'gas too low',
    'Not enough gas for transaction validation',
    'insufficient to cover the transaction cost',
    'gas limit.*insufficient',
    'gas.*too low',
    // Note: "gas required exceeds allowance" is handled as insufficient funds, not gas estimation
    'minimum needed',
    /transaction cost of \d+ gas/i,
  ]
  return patterns.some((p) =>
    typeof p === 'string'
      ? errorText.toLowerCase().includes(p.toLowerCase())
      : p.test(errorText)
  )
}

/**
 * Extract numeric values from error message (tx cost, overshot, balance, required gas)
 */
function extractErrorValues(errorText: string): {
  txCost?: bigint
  overshot?: bigint
  balance?: bigint
  requiredGas?: bigint
} {
  const txCostMatch = errorText.match(/tx cost (\d+)/i)
  const overshotMatch = errorText.match(/overshot (\d+)/i)
  const balanceMatch = errorText.match(/balance (\d+)/i)

  // Extract required gas from various error message patterns:
  // - "insufficient to cover the transaction cost of 621000 gas"
  // - "minimum needed 60543000"
  // - "transaction cost of 621000 gas"
  // - "gas limit.*(\d+)"
  // - "gas required exceeds allowance (16059)"
  // - "intrinsic gas too low: gas 21000, minimum needed 60417000"
  const requiredGasMatch =
    errorText.match(/transaction cost of (\d+) gas/i) ||
    errorText.match(/minimum needed (\d+)/i) ||
    errorText.match(/required (\d+) gas/i) ||
    errorText.match(/gas limit.*?(\d+)/i) ||
    errorText.match(/gas required exceeds allowance \((\d+)\)/i) ||
    errorText.match(/intrinsic gas too low:.*minimum needed (\d+)/i) ||
    errorText.match(/minimum needed (\d+)/i)

  return {
    txCost: txCostMatch?.[1] ? BigInt(txCostMatch[1]) : undefined,
    overshot: overshotMatch?.[1] ? BigInt(overshotMatch[1]) : undefined,
    balance: balanceMatch?.[1] ? BigInt(balanceMatch[1]) : undefined,
    requiredGas: requiredGasMatch?.[1]
      ? BigInt(requiredGasMatch[1])
      : undefined,
  }
}

/**
 * Get balance with timeout
 */
async function getBalanceWithTimeout(
  client: PublicClient,
  address: Address,
  timeoutMs = BALANCE_CHECK_TIMEOUT
): Promise<bigint> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Balance check timeout')), timeoutMs)
  )
  return Promise.race([client.getBalance({ address }), timeoutPromise])
}

/**
 * Estimate gas limit for transfer with timeout
 */
async function estimateGasLimit(
  client: PublicClient,
  account: Address,
  to: Address,
  value: bigint,
  isZkEVM: boolean,
  timeoutMs = HTTP_TIMEOUT
): Promise<bigint> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gas estimation timeout')), timeoutMs)
    )

    // Use legacy type to avoid EIP-1559 params for networks that don't support it
    const gasLimit = await Promise.race([
      client.estimateGas({
        account,
        to,
        value,
        type: 'legacy',
      } as Parameters<typeof client.estimateGas>[0]),
      timeoutPromise,
    ])
    // Add buffer: 20% for zkEVMs, 10% for others
    return (gasLimit * (isZkEVM ? 120n : 110n)) / 100n
  } catch (error) {
    // Check if this is an insufficient funds error - if so, propagate it
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (isInsufficientFundsError(errorMessage)) {
      throw error // Re-throw insufficient funds errors so caller can handle them
    }
    // Fallback to standard gas for other errors
    return 21000n
  }
}

/**
 * Get gas pricing information with timeout
 */
async function getGasInfo(
  client: PublicClient,
  supportsEIP1559: boolean,
  timeoutMs = HTTP_TIMEOUT
): Promise<{
  gasPrice: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Gas info fetch timeout')), timeoutMs)
  )

  if (supportsEIP1559) {
    try {
      const feeData = await Promise.race([
        client.estimateFeesPerGas(),
        timeoutPromise,
      ])
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        return {
          gasPrice: feeData.maxFeePerGas,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        }
      }
    } catch {
      // Fall through to getGasPrice
    }

    try {
      const block = await Promise.race([
        client.getBlock({ blockTag: 'latest' }),
        timeoutPromise,
      ])
      if (block.baseFeePerGas) {
        const priorityFee = block.baseFeePerGas / 10n
        return {
          gasPrice: block.baseFeePerGas + priorityFee,
          maxFeePerGas: block.baseFeePerGas + priorityFee,
          maxPriorityFeePerGas: priorityFee,
        }
      }
    } catch {
      // Fall through
    }
  }

  const gasPrice = await Promise.race([client.getGasPrice(), timeoutPromise])
  return { gasPrice }
}

/**
 * Calculate optimal transfer amount using binary search
 */
function calculateTransferAmount(
  balance: bigint,
  gasCost: bigint,
  errorValues?: { txCost?: bigint; overshot?: bigint }
): bigint {
  // If we have overshot, use it for precise calculation
  if (errorValues?.overshot) {
    const safeAmount =
      balance - gasCost - errorValues.overshot - errorValues.overshot / 20n
    return safeAmount > 0n ? safeAmount : 0n
  }

  // If we have tx cost, calculate from it
  if (errorValues?.txCost) {
    const safeBalance = (balance * 999n) / 1000n
    const safeAmount = safeBalance > gasCost ? safeBalance - gasCost : 0n
    return safeAmount > 0n ? safeAmount : 0n
  }

  // Default: leave 2% buffer
  const safeBalance = (balance * 98n) / 100n
  return safeBalance > gasCost ? safeBalance - gasCost : 0n
}

/**
 * Check if address has EIP-7702 delegation (has bytecode but is technically an EOA)
 * EIP-7702 delegations have exactly 23 bytes: 0xef0100 (3 bytes) + 20-byte delegate address
 */
async function hasEIP7702Delegation(
  client: PublicClient,
  address: Address
): Promise<boolean> {
  try {
    const bytecode = await client.getBytecode({ address })
    if (!bytecode || bytecode === '0x') return false
    // EIP-7702 delegations have exactly 23 bytes of code (0xef0100 + 20-byte address = 23 bytes)
    // In hex: 0x prefix (2 chars) + 23 bytes (46 hex chars) = 48 total characters
    // Regular contracts have more code, EOAs have none
    return bytecode.length === 48 && bytecode.startsWith('0xef0100')
  } catch {
    return false
  }
}

/**
 * Send native tokens using cast send (for EIP-7702 delegated addresses)
 */
async function sendViaCastSend(
  rpcUrl: string,
  to: Address,
  value: bigint,
  privateKey: string
): Promise<`0x${string}`> {
  // Declare stderr in outer scope so it's accessible in the outer catch block
  let stderr = ''
  try {
    // Escape shell arguments to prevent injection
    const escapedRpcUrl = rpcUrl.replace(/'/g, "'\"'\"'")
    const escapedTo = to.replace(/'/g, "'\"'\"'")
    const escapedPrivateKey = privateKey.replace(/'/g, "'\"'\"'")
    // Cast expects value in wei as decimal string (not hex)
    const valueWei = value.toString()

    // Build cast send command
    const command = `cast send "${escapedTo}" --value "${valueWei}" --rpc-url "${escapedRpcUrl}" --private-key "${escapedPrivateKey}"`

    // Execute command and capture output (both stdout and stderr)
    let output: string
    let combinedOutput = ''
    try {
      output = execSync(command, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: HTTP_TIMEOUT * 2, // 30 seconds timeout
      })
    } catch (error) {
      // Cast may output warnings to stderr but still succeed
      // execSync throws when there's output to stderr, but the command might have succeeded
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const execError = error as any
      stderr = execError.stderr?.toString() || execError.message || ''
      const stdout = execError.stdout?.toString() || ''
      combinedOutput = stdout + '\n' + stderr

      // Try to parse transaction hash from combined output
      const txHashMatch = combinedOutput.match(
        /transactionHash:\s*(0x[a-fA-F0-9]{64})/i
      )
      if (txHashMatch && txHashMatch[1]) {
        return txHashMatch[1] as `0x${string}`
      }

      // If exit code is 0, it might have succeeded despite warnings
      if (execError.status === 0 || execError.code === 0) {
        const hashMatch = combinedOutput.match(/(0x[a-fA-F0-9]{64})/)
        if (hashMatch && hashMatch[1]) {
          return hashMatch[1] as `0x${string}`
        }
      }

      // If we can't find a hash, throw the error
      throw error
    }

    // Parse transaction hash from cast output (check combined output if we have stderr)
    // Cast output format: "blockHash: 0x...\ntransactionHash: 0x..."
    const parseOutput = stderr ? combinedOutput : output
    const txHashMatch = parseOutput.match(
      /transactionHash:\s*(0x[a-fA-F0-9]{64})/i
    )
    if (txHashMatch && txHashMatch[1]) {
      return txHashMatch[1] as `0x${string}`
    }

    // Fallback: try to find any 0x hash in the output
    const hashMatch = parseOutput.match(/(0x[a-fA-F0-9]{64})/)
    if (hashMatch && hashMatch[1]) {
      return hashMatch[1] as `0x${string}`
    }

    // If we only have warnings in stderr but no hash, check if it's just warnings
    if (stderr && !stderr.match(/(0x[a-fA-F0-9]{64})/)) {
      const hasOnlyWarnings =
        (stderr.includes('Warning:') || stderr.includes('warning:')) &&
        !stderr.match(/Error:/i) &&
        !stderr.match(/error code/i)

      if (!hasOnlyWarnings) {
        throw new Error(
          `Could not parse transaction hash from cast output. stdout: ${output.substring(
            0,
            200
          )}, stderr: ${stderr.substring(0, 200)}`
        )
      }
    }

    throw new Error(
      `Could not parse transaction hash from cast output: ${output.substring(
        0,
        200
      )}`
    )
  } catch (error) {
    // Preserve full error details for summary, but throw concise message for execution logs
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Combine stderr with error message to check for insufficient funds
    const fullErrorText = stderr ? `${errorMessage}\n${stderr}` : errorMessage

    // If it's an insufficient funds error, preserve it so the caller can detect it
    if (
      isInsufficientFundsError(fullErrorText) ||
      isInsufficientFundsError(errorMessage)
    ) {
      throw error // Re-throw as-is so caller can detect it
    }

    // Extract just the first line or key error message (avoid verbose cast output)
    const firstLine = errorMessage.split('\n')[0] || errorMessage
    const conciseMessage = firstLine.replace(/^error:\s*/i, '').trim()
    throw new Error(`cast send failed: ${conciseMessage}`)
  }
}

/**
 * Send transaction (EIP-1559 or legacy)
 * Note: walletClient already has account and chain set, so we don't need to pass them explicitly
 */
async function sendTransferTransaction(
  walletClient: WalletClient,
  to: Address,
  value: bigint,
  gasInfo: IGasInfo
): Promise<`0x${string}`> {
  if (!walletClient.account) {
    throw new Error('Wallet client missing account')
  }

  // For simple ETH transfers, walletClient already has account and chain set
  // Passing them explicitly can cause issues - let viem use the ones from walletClient
  if (
    gasInfo.supportsEIP1559 &&
    gasInfo.maxFeePerGas &&
    gasInfo.maxPriorityFeePerGas
  ) {
    return walletClient.sendTransaction({
      to,
      value,
      gas: gasInfo.gasLimit,
      maxFeePerGas: gasInfo.maxFeePerGas,
      maxPriorityFeePerGas: gasInfo.maxPriorityFeePerGas,
    } as Parameters<typeof walletClient.sendTransaction>[0])
  }

  return walletClient.sendTransaction({
    to,
    value,
    gas: gasInfo.gasLimit,
    gasPrice: gasInfo.gasPrice,
  } as Parameters<typeof walletClient.sendTransaction>[0])
}

/**
 * Wait for transaction with timeout
 */
async function waitForTransaction(
  txHash: `0x${string}`,
  networkName: string,
  transferAmount: bigint,
  client: PublicClient,
  timeoutMs = TX_CONFIRMATION_TIMEOUT
): Promise<ITransferResult> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Transaction confirmation timeout')),
        timeoutMs
      )
    )

    const receipt = await Promise.race([
      client.waitForTransactionReceipt({ hash: txHash }),
      timeoutPromise,
    ])

    if (receipt.status === 'success') {
      return {
        network: networkName,
        success: true,
        amount: transferAmount,
        txHash,
      }
    }

    // Transaction was included but failed - return failure result instead of throwing
    // Build block explorer URL for transaction
    const network = networks[networkName]
    let explorerUrl = `https://etherscan.io/tx/${txHash}` // Fallback
    if (network?.explorerUrl) {
      const base = network.explorerUrl.replace(/\/+$/, '')
      // Handle different explorer URL patterns
      if (network.verificationType === 'tronscan') {
        explorerUrl = `${base}/#/transaction/${txHash}`
      } else {
        // Default pattern for most explorers (Etherscan, Blockscout, OKLink, etc.)
        explorerUrl = `${base}/tx/${txHash}`
      }
    }

    return {
      network: networkName,
      success: false,
      amount: transferAmount,
      txHash,
      error: `Transaction reverted. Tx hash: ${txHash}`,
      errorDetails: `Transaction was included in block ${receipt.blockNumber} but reverted. Check block explorer for revert reason: ${explorerUrl}`,
      attempts: 1, // This is from waitForTransaction, not from retries
    }
  } catch (error) {
    const errorMessage = extractErrorMessage(error, false)
    if (errorMessage.includes('timeout')) {
      return {
        network: networkName,
        success: true, // Optimistic: transaction was sent
        amount: transferAmount,
        txHash,
        errorDetails: `Transaction confirmation timed out after ${timeoutMs}ms. Tx hash: ${txHash}. Please verify manually.`,
      }
    }
    throw error
  }
}

/**
 * Transfer native tokens on a single network
 */
async function transferNativeTokensOnNetwork(
  network: INetwork,
  oldWalletAddress: Address,
  newWalletAddress: Address,
  privateKey: string
): Promise<ITransferResult> {
  const networkName = network.id

  // Create clients once (reused across retries)
  const chain = getViemChainForNetworkName(networkName)
  const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`)
  const rpcUrl = chain.rpcUrls.default.http[0] || network.rpcUrl

  // Track which RPC is being used (premium from env or fallback from networks.json)
  const envKey = `ETH_NODE_URI_${networkName.toUpperCase()}`
  const usingPremiumRpc = !!process.env[envKey]

  const httpTransport = http(rpcUrl, {
    timeout: HTTP_TIMEOUT,
    retryCount: 1, // Reduced from 2 to 1 to prevent long delays
    retryDelay: 500, // Reduced from 1000ms to 500ms
  })

  const publicClient = createPublicClient({ chain, transport: httpTransport })
  const walletClient = createWalletClient({
    chain,
    transport: httpTransport,
    account,
  })

  // Verify account matches
  if (getAddress(account.address) !== getAddress(oldWalletAddress)) {
    return {
      network: networkName,
      success: false,
      error: `Private key does not match old wallet address. Expected ${oldWalletAddress}, got ${account.address}`,
      attempts: 1,
      usedPremiumRpc: usingPremiumRpc,
    }
  }

  let shouldEstimateGas = true // Always try to estimate gas first
  let lastError: Error | undefined
  let extractedGasLimit: bigint | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Get balance with timeout (reused throughout the attempt)
      let balance: bigint
      try {
        balance = await getBalanceWithTimeout(publicClient, oldWalletAddress)
      } catch (error) {
        const errorMessage = extractErrorMessage(error, false)
        if (
          errorMessage.includes('timeout') ||
          errorMessage.includes('Balance check timeout')
        ) {
          return {
            network: networkName,
            success: false,
            error: 'Balance check timeout',
            errorDetails:
              'RPC timeout when checking balance. Network may be slow or unresponsive.',
            attempts: attempt,
            usedPremiumRpc: usingPremiumRpc,
          }
        }
        // Handle RPC errors (e.g., Flow network's unexpected response format)
        if (
          errorMessage.includes('null is not an object') ||
          errorMessage.includes('HTTP request failed') ||
          errorMessage.includes('RPC')
        ) {
          return {
            network: networkName,
            success: false,
            error: `RPC error when checking balance: ${errorMessage}`,
            errorDetails: extractErrorMessage(error, true),
            attempts: attempt,
            usedPremiumRpc: usingPremiumRpc,
          }
        }
        throw error
      }

      // Zero balance check
      if (balance === 0n) {
        console.log(
          `  [${networkName}] ⏭️  No action required, no balance on this network 0 ${network.nativeCurrency}`
        )
        return {
          network: networkName,
          success: false,
          amount: 0n,
          skipReason: 'zero_balance',
          attempts: attempt,
          usedPremiumRpc: usingPremiumRpc,
        }
      }

      // Determine gas limit
      let gasLimit: bigint
      // Use extracted gas limit from previous error if available
      if (extractedGasLimit) {
        gasLimit = extractedGasLimit
        extractedGasLimit = undefined // Clear after use
      } else if (shouldEstimateGas) {
        const estimationValue =
          balance > 1000000000000000n * 10n ? 1000000000000000n : balance / 10n
        try {
          gasLimit = await estimateGasLimit(
            publicClient,
            account.address,
            newWalletAddress,
            estimationValue,
            network.isZkEVM
          )
        } catch (error) {
          const errorMessage = extractErrorMessage(error, false)

          // Check for insufficient funds FIRST (some networks like Arbitrum report this as "gas required exceeds allowance")
          if (isInsufficientFundsError(errorMessage)) {
            console.log(
              `  [${networkName}] ⏭️  Balance too small to cover gas costs`
            )
            return {
              network: networkName,
              success: false,
              amount: 0n,
              skipReason: 'insufficient_balance',
              attempts: attempt,
              usedPremiumRpc: usingPremiumRpc,
            }
          }

          // Try to extract required gas from error message
          if (isGasEstimationError(errorMessage)) {
            const errorValues = extractErrorValues(errorMessage)
            if (errorValues.requiredGas) {
              // Use extracted gas with buffer
              gasLimit = (errorValues.requiredGas * 120n) / 100n // 20% buffer
              // Continue with this gas limit
            } else {
              // Gas estimation failed for other reasons, fall back to 21000
              // but mark that we should retry estimation on next attempt
              gasLimit = 21000n
              shouldEstimateGas = true // Keep trying to estimate
            }
          } else {
            // Other error - fall back to 21000 but keep trying to estimate
            gasLimit = 21000n
            shouldEstimateGas = true
          }
        }
      } else {
        gasLimit = 21000n
      }

      // Check if recipient has EIP-7702 delegation - use cast send for delegated addresses
      const hasDelegation = await hasEIP7702Delegation(
        publicClient,
        newWalletAddress
      )

      // Get block info for EIP-1559 support
      const latestBlock = await publicClient.getBlock({ blockTag: 'latest' })
      const supportsEIP1559 =
        'baseFeePerGas' in latestBlock && latestBlock.baseFeePerGas !== null

      // Get gas pricing
      const gasPricing = await getGasInfo(publicClient, supportsEIP1559)
      const gasInfo: IGasInfo = {
        gasLimit,
        gasPrice: gasPricing.gasPrice,
        maxFeePerGas: gasPricing.maxFeePerGas,
        maxPriorityFeePerGas: gasPricing.maxPriorityFeePerGas,
        supportsEIP1559,
      }

      // Calculate transfer amount (start with 98% of balance minus gas)
      const estimatedGasCost = gasInfo.gasLimit * gasInfo.gasPrice
      let transferAmount = calculateTransferAmount(balance, estimatedGasCost)

      if (transferAmount <= 0n) {
        console.log(
          `  [${networkName}] ⏭️  Balance too small to cover gas costs`
        )
        return {
          network: networkName,
          success: false,
          amount: 0n,
          skipReason: 'insufficient_balance',
          attempts: attempt,
        }
      }

      // Try sending with iterative reduction (max 10 iterations)
      let lastSendError: unknown
      for (let iteration = 0; iteration < 10; iteration++) {
        if (transferAmount <= 0n) break

        try {
          let txHash: `0x${string}`

          // Use cast send for EIP-7702 delegated addresses, viem for regular addresses
          if (hasDelegation) {
            txHash = await sendViaCastSend(
              rpcUrl,
              newWalletAddress,
              transferAmount,
              `0x${privateKey.replace(/^0x/, '')}`
            )
          } else {
            txHash = await sendTransferTransaction(
              walletClient,
              newWalletAddress,
              transferAmount,
              gasInfo
            )
          }

          const result = await waitForTransaction(
            txHash,
            networkName,
            transferAmount,
            publicClient
          )

          // Check if transaction actually succeeded
          if (!result.success) {
            // Transaction was included but reverted - throw to be caught by outer catch
            throw new Error(result.error || 'Transaction reverted')
          }

          const amountFormatted = formatEther(transferAmount)
          logSuccess(
            `  [${networkName}] ✅ Attempt ${attempt}/${MAX_RETRIES}: Sent ${amountFormatted} ${
              network.nativeCurrency
            } from ${oldWalletAddress.slice(0, 10)}...${oldWalletAddress.slice(
              -8
            )} to ${newWalletAddress.slice(0, 10)}...${newWalletAddress.slice(
              -8
            )} (TX: ${txHash})`
          )
          return { ...result, usedPremiumRpc: usingPremiumRpc }
        } catch (sendError) {
          lastSendError = sendError
          const errorText = extractErrorMessage(sendError, false)

          // Check if transaction was included but failed
          if (
            errorText.includes(
              'Transaction was included in block but failed'
            ) ||
            errorText.includes('Transaction reverted') ||
            (errorText.includes('Tx hash:') &&
              errorText.includes('Transaction failed'))
          ) {
            logError(
              `  [${networkName}] ❌ Attempt ${attempt}/${MAX_RETRIES} failed`
            )
            return {
              network: networkName,
              success: false,
              error: errorText,
              errorDetails: extractErrorMessage(sendError, true), // Full details for summary
              attempts: attempt,
              usedPremiumRpc: usingPremiumRpc,
            }
          }

          // Handle gas estimation errors - extract required gas and retry
          if (isGasEstimationError(errorText)) {
            const errorValues = extractErrorValues(errorText)
            if (errorValues.requiredGas) {
              // Store extracted gas for next attempt
              extractedGasLimit = (errorValues.requiredGas * 120n) / 100n // 20% buffer
              logError(
                `  [${networkName}] ❌ Attempt ${attempt}/${MAX_RETRIES} failed (extracted required gas: ${errorValues.requiredGas}, will retry with ${extractedGasLimit})`
              )
              // Break out of iteration loop to retry with new gas limit
              break
            }
          }

          // Handle insufficient funds errors
          if (isInsufficientFundsError(errorText)) {
            const errorValues = extractErrorValues(errorText)
            const newAmount = calculateTransferAmount(
              balance,
              estimatedGasCost,
              errorValues
            )

            if (newAmount >= (transferAmount * 95n) / 100n) {
              // Less than 5% reduction, likely at limit
              break
            }

            transferAmount = newAmount
            continue
          }

          // Other errors - rethrow to be handled by outer catch
          throw sendError
        }
      }

      // If we exhausted iterations, check if balance is too small
      if (balance <= estimatedGasCost) {
        console.log(
          `  [${networkName}] ⏭️  Balance too small to cover gas costs`
        )
        return {
          network: networkName,
          success: false,
          amount: 0n,
          skipReason: 'insufficient_balance',
          attempts: attempt,
        }
      }

      throw (
        lastSendError ||
        new Error('Failed to send transaction after all reduction attempts')
      )
    } catch (error) {
      lastError = error as Error
      const errorMessage = extractErrorMessage(error, false)

      // Check if transaction was included but failed (from waitForTransaction or sendTransaction)
      const isRevertedTransaction =
        errorMessage.includes('Transaction was included in block but failed') ||
        errorMessage.includes('Transaction reverted') ||
        errorMessage.includes('Tx hash:')

      if (isRevertedTransaction) {
        logError(
          `  [${networkName}] ❌ Attempt ${attempt}/${MAX_RETRIES} failed`
        )
        // Extract tx hash from error message if present
        const txHashMatch = errorMessage.match(/Tx hash: (0x[a-fA-F0-9]+)/i)
        const txHash = txHashMatch ? txHashMatch[1] : undefined

        return {
          network: networkName,
          success: false,
          error: errorMessage,
          errorDetails: extractErrorMessage(error, true),
          txHash,
          attempts: attempt,
          usedPremiumRpc: usingPremiumRpc,
        }
      }

      // Log attempt failure (no error details, just attempt number)
      if (attempt < MAX_RETRIES) {
        logError(
          `  [${networkName}] ❌ Attempt ${attempt}/${MAX_RETRIES} failed`
        )
      }

      // Handle gas estimation errors
      if (isGasEstimationError(errorMessage)) {
        // Try to extract required gas from error message
        const errorValues = extractErrorValues(errorMessage)
        if (errorValues.requiredGas) {
          // Use the extracted gas limit with a buffer
          extractedGasLimit = (errorValues.requiredGas * 120n) / 100n // 20% buffer
          if (attempt < MAX_RETRIES) {
            logError(
              `  [${networkName}] ❌ Attempt ${attempt}/${MAX_RETRIES} failed (extracted required gas: ${errorValues.requiredGas}, will retry with ${extractedGasLimit})`
            )
            await sleep(1000 * attempt)
            continue
          }
        } else if (!shouldEstimateGas) {
          // Fallback to estimating gas
          shouldEstimateGas = true
          if (attempt < MAX_RETRIES) {
            await sleep(1000 * attempt)
            continue
          }
        } else {
          logError(
            `  [${networkName}] ❌ Attempt ${attempt}/${MAX_RETRIES} failed`
          )
          return {
            network: networkName,
            success: false,
            error: 'Gas estimation error persists after estimating',
            errorDetails: extractErrorMessage(error, true),
            attempts: attempt,
            usedPremiumRpc: usingPremiumRpc,
          }
        }
      }

      // Handle insufficient funds errors
      if (isInsufficientFundsError(errorMessage)) {
        return {
          network: networkName,
          success: false,
          amount: 0n,
          skipReason: 'insufficient_balance',
          attempts: attempt,
        }
      }

      // Wait before retry
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * attempt)
      }
    }
  }

  // All retries exhausted
  const finalError = lastError || new Error('Unknown error after all retries')
  return {
    network: networkName,
    success: false,
    error: extractErrorMessage(finalError, false),
    errorDetails: extractErrorMessage(finalError, true),
    attempts: MAX_RETRIES,
    usedPremiumRpc: usingPremiumRpc,
  }
}

/**
 * Process networks in batches
 */
async function processNetworksInBatches(
  networks: INetwork[],
  oldWalletAddress: Address,
  newWalletAddress: Address,
  privateKey: string
): Promise<INetworkTransferResult[]> {
  const results: INetworkTransferResult[] = []

  if (networks.length <= MAX_CONCURRENT_JOBS) {
    consola.info(`Processing all ${networks.length} networks in parallel`)
  } else {
    consola.info(
      `Processing ${networks.length} networks in batches of ${MAX_CONCURRENT_JOBS}`
    )
  }

  for (let i = 0; i < networks.length; i += MAX_CONCURRENT_JOBS) {
    const batch = networks.slice(i, i + MAX_CONCURRENT_JOBS)
    const batchNumber = Math.floor(i / MAX_CONCURRENT_JOBS) + 1
    const totalBatches = Math.ceil(networks.length / MAX_CONCURRENT_JOBS)

    if (totalBatches > 1) {
      consola.info(
        `Processing batch ${batchNumber}/${totalBatches} (${batch.length} networks)`
      )
    }

    const batchResults = await Promise.allSettled(
      batch.map((network) =>
        transferNativeTokensOnNetwork(
          network,
          oldWalletAddress,
          newWalletAddress,
          privateKey
        )
      )
    )

    for (let index = 0; index < batchResults.length; index++) {
      const result = batchResults[index]
      const network = batch[index] // Use index to correlate with the batch array

      if (!result) continue // Skip if result is undefined (shouldn't happen, but TypeScript safety)

      if (result.status === 'fulfilled') {
        const transferResult = result.value
        const networkFromResult = networks.find(
          (n) => n.id === transferResult.network
        )

        const networkResult: INetworkTransferResult = {
          ...transferResult,
          amountFormatted: transferResult.amount
            ? formatEther(transferResult.amount)
            : undefined,
          nativeCurrency: networkFromResult?.nativeCurrency,
        }

        results.push(networkResult)

        // Log brief status
        if (
          transferResult.success &&
          transferResult.amount &&
          transferResult.amount > 0n
        ) {
          logSuccess(
            `✅ [${transferResult.network}] ${networkResult.amountFormatted} ${
              networkFromResult?.nativeCurrency || 'tokens'
            }`
          )
        } else if (!transferResult.skipReason) {
          logError(
            `❌ [${transferResult.network}] Failed (attempt ${
              transferResult.attempts || '?'
            }/${MAX_RETRIES})`
          )
        }
      } else {
        // Use the network from the batch array at the same index
        const networkName = network?.id || 'unknown'
        const rejectedReason = result.reason
        results.push({
          network: networkName,
          success: false,
          error: rejectedReason?.message || 'Promise rejected',
          errorDetails: rejectedReason
            ? `${rejectedReason.message || 'Promise rejected'}${
                rejectedReason.stack ? `\n${rejectedReason.stack}` : ''
              }`
            : 'Promise rejected',
          attempts: MAX_RETRIES,
        })
        logError(`❌ [${networkName}] Promise rejected`)
      }
    }
  }

  return results
}

const main = defineCommand({
  meta: {
    name: 'move-native-funds-to-new-wallet',
    description:
      'Moves native funds from an old wallet to a new wallet across all supported networks',
  },
  args: {
    newWalletAddress: {
      type: 'string',
      description: 'Address of the new wallet (where funds should be sent to)',
      required: true,
    },
    privateKey: {
      type: 'string',
      description:
        'Private key of the old wallet (optional, will prompt if not provided)',
      required: false,
    },
    privateKeyEnvKey: {
      type: 'string',
      description:
        'Environment variable key for private key (PRIVATE_KEY, PRIVATE_KEY_PRODUCTION, or custom)',
      required: false,
    },
  },
  async run({ args }) {
    const {
      newWalletAddress,
      privateKey: privateKeyArg,
      privateKeyEnvKey,
    } = args

    // Get private key
    let privateKey: string
    if (privateKeyArg) {
      privateKey = privateKeyArg
    } else {
      let envKey: string
      if (privateKeyEnvKey) {
        envKey = privateKeyEnvKey
      } else {
        const keyChoice = await consola.prompt(
          'Which private key do you want to use from your .env file?',
          {
            type: 'select',
            options: [
              'PRIVATE_KEY',
              'PRIVATE_KEY_PRODUCTION',
              'Enter custom key name',
            ],
          }
        )

        if (keyChoice === 'Enter custom key name') {
          const customKey = await consola.prompt(
            'Enter the environment variable key name:',
            { type: 'text' }
          )
          if (!customKey || typeof customKey !== 'string') {
            consola.error('Invalid key name provided')
            process.exit(1)
          }
          envKey = customKey
        } else {
          envKey = keyChoice as string
        }
      }

      const envPrivateKey = process.env[envKey]
      if (!envPrivateKey) {
        consola.error(
          `Private key not found in environment variable: ${envKey}. Please add it to your .env file.`
        )
        process.exit(1)
      }
      privateKey = envPrivateKey
    }

    // Normalize private key
    privateKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey

    // Derive old wallet address
    const account = privateKeyToAccount(`0x${privateKey}`)
    const oldWallet = account.address

    // Validate new wallet address
    let newWallet: Address
    try {
      newWallet = getAddress(newWalletAddress)
    } catch {
      consola.error('Invalid new wallet address provided')
      process.exit(1)
    }

    if (oldWallet === newWallet) {
      consola.error('Old wallet and new wallet addresses cannot be the same')
      process.exit(1)
    }

    consola.info('Starting native funds transfer across all networks')
    consola.info(`Old wallet (derived from private key): ${oldWallet}`)
    consola.info(`New wallet: ${newWallet}`)
    consola.info(`Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`)
    consola.info(`Max retries per network: ${MAX_RETRIES}\n`)

    // Get all active networks
    const networks = getAllActiveNetworks()
    consola.info(`Found ${networks.length} active networks\n`)

    if (networks.length === 0) {
      consola.error('No active networks found')
      process.exit(1)
    }

    // Process all networks in batches
    let results: INetworkTransferResult[]
    try {
      results = await processNetworksInBatches(
        networks,
        oldWallet,
        newWallet,
        privateKey
      )
    } catch (error) {
      consola.error('Fatal error during network processing:')
      consola.error(extractErrorMessage(error, true))
      process.exit(1)
    }

    // Generate summary - always print, even if there were errors
    try {
      consola.info('\n' + '='.repeat(80))
      consola.info('TRANSFER SUMMARY')
      consola.info('='.repeat(80))

      const successful = results.filter(
        (r) => r.success && r.amount && r.amount > 0n
      )
      const noOps = results.filter((r) => r.skipReason)
      const failed = results.filter((r) => !r.success && !r.skipReason)

      consola.info(`\n✅ Successful transfers: ${successful.length}`)
      if (successful.length > 0) {
        successful.forEach((r) => {
          const txStatus = r.errorDetails
            ? ' (pending confirmation)'
            : ' (confirmed)'
          consola.success(
            `  [${r.network}] ${r.amountFormatted} ${r.nativeCurrency} - TX: ${r.txHash}${txStatus}`
          )
        })
      }

      const noActionRequired = noOps.length
      if (noActionRequired > 0) {
        consola.info(`\n⏭️  No action required: ${noActionRequired}`)
        noOps.forEach((r) => {
          if (r.skipReason === 'zero_balance') {
            consola.info(`  [${r.network}] No balance on this network`)
          } else if (r.skipReason === 'insufficient_balance') {
            consola.info(`  [${r.network}] Balance too low to transfer`)
          }
        })
      }

      if (failed.length > 0) {
        consola.info(`\n❌ Unsuccessful networks: ${failed.length}`)
        failed.forEach((r, index) => {
          if (index > 0) {
            console.log('')
            console.log('#'.repeat(80))
          }
          const errorMessage = r.errorDetails || r.error || 'Transaction failed'
          // Use console.error directly to avoid consola's timestamp formatting
          console.error(`  [${r.network}]`)
          console.error(`     ${errorMessage}`)
        })
      }

      // RPC Usage Summary
      const premiumRpcNetworks = results.filter(
        (r) => r.usedPremiumRpc === true
      )
      const fallbackRpcNetworks = results.filter(
        (r) => r.usedPremiumRpc === false
      )
      if (premiumRpcNetworks.length > 0 || fallbackRpcNetworks.length > 0) {
        consola.info(`\n📡 RPC Usage Summary:`)
        if (premiumRpcNetworks.length > 0) {
          consola.info(
            `  ✅ Premium RPCs (from .env): ${premiumRpcNetworks.length} network(s)`
          )
        }
        if (fallbackRpcNetworks.length > 0) {
          consola.info(
            `  ⚠️  Fallback RPCs (from networks.json): ${fallbackRpcNetworks.length} network(s)`
          )
          consola.info(
            `     Consider adding ETH_NODE_URI_<NETWORK> to .env for better performance`
          )
        }
      }

      consola.info('\n' + '='.repeat(80))

      // Exit with error code if any transfers failed
      if (failed.length > 0) {
        consola.error(
          `\n⚠️  ${failed.length} network(s) failed. Please review the errors above.`
        )
        process.exit(1)
      } else {
        consola.success(
          `\n✅ All transfers completed successfully! ${successful.length} network(s) transferred funds.`
        )
        process.exit(0)
      }
    } catch (error) {
      // If summary printing fails, at least show basic info
      consola.error('Error generating summary:')
      consola.error(extractErrorMessage(error, true))
      consola.info(`Processed ${results.length} networks`)
      process.exit(1)
    }
  },
})

runMain(main)
