import chalk from 'chalk'
import { providers, Wallet, BigNumber } from 'ethers'
import { ERC20__factory } from '../../typechain'
import * as fs from 'fs'
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token'

const msg = (text: string) => {
  console.log(chalk.green(text))
}

const error = (text: string) => {
  console.log(chalk.red(text))
}

interface AddressesConfig {
  [chainId: string]: {
    usdc: string
  }
}

// Polymer api types
interface RoutesResponse {
  routes: Route[]
}

interface RouteStep {
  action: any
  estimate: any
  tool: string
  toolDetails: any
}

interface Route {
  steps: RouteStep[]
}

interface TransactionRequest {
  to: string
  data: string
  gasLimit: string
  value?: string
}

interface StepTransactionResponse {
  transactionRequest: TransactionRequest
  polymerTransactionData?: any
}

interface StatusResponse {
  status: string
  substatus: string
  substatusMessage: string
}

// Parse command line arguments
const args = process.argv.slice(2)
if (args.length < 5) {
  console.log(
    'Usage: ts-node demoPolymer.ts <POLYMER_API_URL> <ADDRESSES_FILE> <FROM_RPC_URL> <TO_RPC_URL> <PRIVATE_KEY>'
  )
  console.log(
    'Example: ts-node demoPolymer.ts http://localhost:8080 testnet-addresses.json https://sepolia.optimism.io https://sepolia.base.org 0x...'
  )
  process.exit(1)
}

const [POLYMER_API_URL, ADDRESSES_FILE, FROM_RPC_URL, TO_RPC_URL, PRIVATE_KEY] =
  args

// Configuration
const FROM_AMOUNT = process.env.FROM_AMOUNT || '1000000'
const MAX_RETRIES = 60
const RETRY_INTERVAL = 10000 // 10 seconds in milliseconds

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSolanaRpc(rpc: string): boolean {
  return rpc.toLowerCase().includes('solana')
}

async function getChainId(rpc: string): Promise<number> {
  if (isSolanaRpc(rpc)) {
    return 2 // Note: even though SOLANA's custom chain id in LifiData.sol is 1151111081099710, polymer's chain id for solana is 2, so we pass in 2 for the polymer endpoint.
  }
  const provider = new providers.JsonRpcProvider(rpc)
  return (await provider.getNetwork()).chainId
}

async function getSolanaTokenBalance(
  connection: Connection,
  walletPublicKey: PublicKey,
  tokenMintAddress: string
): Promise<bigint> {
  try {
    const tokenMint = new PublicKey(tokenMintAddress)
    const tokenAccount = await getAssociatedTokenAddress(
      tokenMint,
      walletPublicKey
    )
    const accountInfo = await getAccount(connection, tokenAccount)
    return accountInfo.amount
  } catch (e) {
    // Token account might not exist yet
    return BigInt(0)
  }
}

function solanaKeypairFromPrivateKey(privateKey: string): Keypair {
  // Remove 0x prefix if present
  const key = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  // Convert hex string to Uint8Array (32 bytes for Solana private key)
  const secretKey = Uint8Array.from(Buffer.from(key.slice(0, 64), 'hex'))
  return Keypair.fromSeed(secretKey)
}

async function getChainInfo(fromRpc: string, toRpc: string) {
  console.log('Querying chain IDs from RPC URLs...')
  const fromChainId = await getChainId(fromRpc)
  const toChainId = await getChainId(toRpc)

  console.log(`From Chain ID: ${fromChainId}`)
  console.log(`To Chain ID: ${toChainId}`)
  console.log('')

  return { fromChainId, toChainId }
}

async function loadTokenAddresses(
  fromChainId: number,
  toChainId: number
): Promise<{ fromToken: string; toToken: string }> {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    error(`Error: Addresses file '${ADDRESSES_FILE}' not found`)
    process.exit(1)
  }

  const addressesData: AddressesConfig = JSON.parse(
    fs.readFileSync(ADDRESSES_FILE, 'utf-8')
  )
  const fromToken = addressesData[fromChainId.toString()]?.usdc
  const toToken = addressesData[toChainId.toString()]?.usdc

  if (!fromToken) {
    error(
      `Error: USDC address not found for chain ID ${fromChainId} in ${ADDRESSES_FILE}`
    )
    process.exit(1)
  }

  if (!toToken) {
    error(
      `Error: USDC address not found for chain ID ${toChainId} in ${ADDRESSES_FILE}`
    )
    process.exit(1)
  }

  return { fromToken, toToken }
}

async function logBalances(
  fromChainId: number,
  toChainId: number,
  fromData: {
    connection?: Connection
    tokenContract?: any
    tokenMint?: string
    walletPublicKey?: PublicKey
    evmAddress?: string
  },
  toData: {
    connection?: Connection
    tokenContract?: any
    tokenMint?: string
    walletPublicKey?: PublicKey
    evmAddress?: string
  },
  title: string
) {
  console.log(`==================== ${title} ====================`)

  try {
    let fromBalance: string
    if (fromData.connection && fromData.walletPublicKey && fromData.tokenMint) {
      // Solana
      const balance = await getSolanaTokenBalance(
        fromData.connection,
        fromData.walletPublicKey,
        fromData.tokenMint
      )
      fromBalance = balance.toString()
    } else if (fromData.tokenContract && fromData.evmAddress) {
      // EVM
      const balance = await fromData.tokenContract.balanceOf(fromData.evmAddress)
      fromBalance = balance.toString()
    } else {
      fromBalance = '<not configured>'
    }
    console.log(
      `From Chain (${fromChainId}) USDC Balance: ${fromBalance}`
    )
  } catch (e) {
    console.log(`From Chain (${fromChainId}) USDC Balance: <query failed>`)
    console.log(`Error: ${e}`)
  }

  try {
    let toBalance: string
    if (toData.connection && toData.walletPublicKey && toData.tokenMint) {
      // Solana
      const balance = await getSolanaTokenBalance(
        toData.connection,
        toData.walletPublicKey,
        toData.tokenMint
      )
      toBalance = balance.toString()
    } else if (toData.tokenContract && toData.evmAddress) {
      // EVM
      const balance = await toData.tokenContract.balanceOf(toData.evmAddress)
      toBalance = balance.toString()
    } else {
      toBalance = '<not configured>'
    }
    console.log(
      `To Chain (${toChainId}) USDC Balance:     ${toBalance}`
    )
  } catch (e) {
    console.log(`To Chain (${toChainId}) USDC Balance:     <query failed>`)
    console.log(`Error: ${e}`)
  }

  console.log(
    '====================================================================='
  )
  console.log('')
}

async function getRoute(
  fromChainId: number,
  toChainId: number,
  fromToken: string,
  toToken: string,
  fromAddress: string,
  toAddress: string
): Promise<RouteStep> {
  console.log('Step 1: Getting available routes...')
  console.log(`From Chain: ${fromChainId} -> To Chain: ${toChainId}`)
  console.log(`Amount: ${FROM_AMOUNT}`)
  console.log('')

  console.log("calling req w body", JSON.stringify({
      fromChainId,
      toChainId,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount: FROM_AMOUNT,
      fromAddress,
      toAddress,
    }))

  const routesResponse = await fetch(`${POLYMER_API_URL}/v1/routes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromChainId,
      toChainId,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      fromAmount: FROM_AMOUNT,
      fromAddress,
      toAddress,
    }),
  })

  console.log("got routes response", routesResponse)
  const routesData: RoutesResponse = await routesResponse.json()

  if ('error' in routesData) {
    error('Error fetching routes:')
    console.log(JSON.stringify(routesData, null, 2))
    process.exit(1)
  }

  // Routes[0] contains the slow route, Routes[1] contains the fast route - we want the fast route
  const firstStep = routesData.routes[1]?.steps[0]

  if (!firstStep) {
    error('No routes found')
    process.exit(1)
  }

  msg('✓ Routes retrieved successfully')
  console.log('')

  return firstStep
}

async function getTransactionCalldata(
  step: RouteStep
): Promise<StepTransactionResponse> {
  console.log('Step 2: Getting transaction calldata...')

  const stepTxResponse = await fetch(`${POLYMER_API_URL}/v1/stepTransaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(step),
  })

  if (stepTxResponse.status !== 200) {
    error(
      `Error: v1/stepTransaction returned HTTP status code ${stepTxResponse.status} (expected 200)`
    )
    const errorData = await stepTxResponse.json()
    console.log(JSON.stringify(errorData, null, 2))
    process.exit(1)
  }

  const stepTxData: StepTransactionResponse = await stepTxResponse.json()

  if ('error' in stepTxData) {
    error('Error fetching step transaction:')
    console.log(JSON.stringify(stepTxData, null, 2))
    process.exit(1)
  }

  msg('✓ Transaction calldata retrieved successfully')
  console.log('')

  return stepTxData
}

async function approveToken(
  tokenContract: Contract,
  wallet: Wallet,
  spender: string,
  amount: BigNumber
): Promise<string> {
  console.log('Approving USDC spending...')
  console.log(
    `  Approval Amount: ${amount.toString()} (Bridge Amount: ${FROM_AMOUNT})`
  )
  console.log(`  Spender: ${spender}`)
  console.log('')

  const tokenWithSigner = tokenContract.connect(wallet)
  const approveTx = await tokenWithSigner.approve(spender, amount)
  const approveReceipt = await approveTx.wait()

  console.log(`Approve tx hash: ${approveReceipt.transactionHash}`)

  if (!approveReceipt.transactionHash) {
    error('Error: Approval transaction failed')
    process.exit(1)
  }

  msg('✓ Approval transaction successful')
  console.log(`Approval Transaction Hash: ${approveReceipt.transactionHash}`)
  console.log('')

  return approveReceipt.transactionHash
}

async function submitTransaction(
  wallet: Wallet,
  txTo: string,
  txData: string,
  txGasLimit: string
): Promise<string> {
  console.log('Step 3: Submitting transaction...')
  console.log(`To Address:  ${txTo}`)
  console.log(`Gas Limit:   ${txGasLimit}`)
  console.log('')

  const tx = await wallet.sendTransaction({
    to: txTo,
    data: txData,
    gasLimit: BigNumber.from(txGasLimit),
  })

  console.log(`Burn tx hash: ${tx.hash}`)

  if (!tx.hash) {
    error('Error: Transaction submission failed')
    process.exit(1)
  }

  msg('✓ Transaction submitted successfully')
  console.log(`Transaction Hash: ${tx.hash}`)
  console.log('')

  // Wait for transaction to be mined
  console.log('Waiting for transaction to be mined...')
  const txReceipt = await tx.wait()

  if (txReceipt.status === 0) {
    error('✗ Transaction reverted')
    console.log(`Transaction Hash: ${tx.hash}`)
    console.log('Receipt:')
    console.log(JSON.stringify(txReceipt, null, 2))
    process.exit(1)
  }

  msg('✓ Transaction mined successfully')
  console.log('')

  return tx.hash
}

async function monitorTransferStatus(txHash: string): Promise<void> {
  console.log(
    `Step 4: Monitoring CCTP transfer status at url ${POLYMER_API_URL}/v1/status/${txHash}`
  )
  let retryCount = 0

  while (retryCount < MAX_RETRIES) {
    const statusResponse = await fetch(`${POLYMER_API_URL}/v1/status/${txHash}`)
    const statusData: StatusResponse = await statusResponse.json()

    const { status, substatus, substatusMessage } = statusData

    console.log(`Status: ${status} | Substatus: ${substatus}`)

    if (status === 'DONE') {
      msg('✓ CCTP transfer completed successfully')
      console.log('')
      break
    } else if (status === 'FAILED' || status === 'INVALID') {
      error(`✗ CCTP transfer failed: ${substatusMessage}`)
      console.log('Full response:')
      console.log(JSON.stringify(statusData, null, 2))
      process.exit(1)
    } else if (status === 'PENDING' || status === 'NOT_FOUND') {
      console.log(`  Message: ${substatusMessage}`)
      console.log(`  Waiting ${RETRY_INTERVAL / 1000}s before next check...`)
      await sleep(RETRY_INTERVAL)
      retryCount++
    } else {
      console.log(`  Unknown status: ${status}`)
      await sleep(RETRY_INTERVAL)
      retryCount++
    }
  }

  if (retryCount === MAX_RETRIES) {
    error('✗ Timeout: CCTP transfer did not complete within the expected time')
    process.exit(1)
  }
}

async function main() {
  // Get chain IDs
  const { fromChainId, toChainId } = await getChainInfo(FROM_RPC_URL, TO_RPC_URL)

  const isFromSolana = isSolanaRpc(FROM_RPC_URL)
  const isToSolana = isSolanaRpc(TO_RPC_URL)

  // Create providers/connections for each chain
  const fromProvider = isFromSolana ? null : new providers.JsonRpcProvider(FROM_RPC_URL)
  const toProvider = isToSolana ? null : new providers.JsonRpcProvider(TO_RPC_URL)
  const fromConnection = isFromSolana ? new Connection(FROM_RPC_URL, 'confirmed') : null
  const toConnection = isToSolana ? new Connection(TO_RPC_URL, 'confirmed') : null

  // Load token addresses
  const { fromToken, toToken } = await loadTokenAddresses(
    fromChainId,
    toChainId
  )

  // Create wallet and derive both EVM and Solana addresses
  const solanaKeypair = solanaKeypairFromPrivateKey(PRIVATE_KEY)
  const solanaAddress = solanaKeypair.publicKey.toBase58()

  let wallet: Wallet
  let evmAddress: string

  if (isFromSolana) {
    // For Solana -> EVM, we still need an EVM wallet for the destination
    wallet = new Wallet(PRIVATE_KEY, toProvider || fromProvider)
  } else {
    wallet = new Wallet(PRIVATE_KEY, fromProvider!)
  }
  evmAddress = await wallet.getAddress()

  console.log(`EVM Address: ${evmAddress}`)
  console.log(`Solana Address: ${solanaAddress}`)
  console.log('')

  // Set from/to addresses based on chain types
  const fromUserAddress = isFromSolana ? solanaAddress : evmAddress
  const toUserAddress = isToSolana ? solanaAddress : evmAddress

  console.log(`From Address (${isFromSolana ? 'Solana' : 'EVM'}): ${fromUserAddress}`)
  console.log(`To Address (${isToSolana ? 'Solana' : 'EVM'}): ${toUserAddress}`)
  console.log('')

  // Create token contracts (EVM only)
  const fromTokenContract = !isFromSolana ? ERC20__factory.connect(fromToken, fromProvider!) : null
  const toTokenContract = !isToSolana ? ERC20__factory.connect(toToken, toProvider!) : null

  // Prepare data for balance logging
  const fromBalanceData = isFromSolana
    ? { connection: fromConnection!, walletPublicKey: solanaKeypair.publicKey, tokenMint: fromToken }
    : { tokenContract: fromTokenContract!, evmAddress: evmAddress }

  const toBalanceData = isToSolana
    ? { connection: toConnection!, walletPublicKey: solanaKeypair.publicKey, tokenMint: toToken }
    : { tokenContract: toTokenContract!, evmAddress: evmAddress }

  // Log balances before transaction
  await logBalances(
    fromChainId,
    toChainId,
    fromBalanceData,
    toBalanceData,
    'Balances Before Transaction'
  )

  console.log('Fetching calldata from CCTP service...')

  // Get route information from polymer api
  const step = await getRoute(
    fromChainId,
    toChainId,
    fromToken,
    toToken,
    fromUserAddress,
    toUserAddress
  )

  // Get transaction calldata from polymer api
  const stepTxData = await getTransactionCalldata(step)
  const {
    to: txTo,
    data: txData,
    gasLimit: txGasLimit,
  } = stepTxData.transactionRequest

  let txHash: string

  if (isFromSolana) {
    error('Solana transaction submission is not yet implemented')
    console.log('Transaction data received from API:')
    console.log(JSON.stringify(stepTxData, null, 2))
    process.exit(1)
  } else {
    // EVM flow: Approve token and submit transaction
    const approvalAmount = BigNumber.from(FROM_AMOUNT)
    await approveToken(fromTokenContract!, wallet!, txTo, approvalAmount)

    console.log('Sleeping to avoid nonce/tx replacement issues ...')
    await sleep(4000)

    // Submit transaction
    txHash = await submitTransaction(wallet!, txTo, txData, txGasLimit)
  }

  // Monitor transfer status
  await monitorTransferStatus(txHash)

  // Log balances after transaction
  await logBalances(
    fromChainId,
    toChainId,
    fromBalanceData,
    toBalanceData,
    'Balances After Transaction'
  )
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Error')
    console.error(error)
    process.exit(1)
  })
