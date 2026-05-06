import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { EnvironmentEnum } from '../common/types'
import {
  getNextNonce,
  getSafeMongoCollection,
  initializeSafeClient,
  OperationTypeEnum,
  storeTransactionInMongoDB,
} from '../deploy/safe/safe-utils'
import {
  getViemChainForNetworkName,
  isTestnetNetwork,
} from '../utils/viemScriptHelpers'

/**
 * Sends calldata directly to the Diamond when staging, testnet, or SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true
 * (e.g. new production networks before ownership transfer). Otherwise proposes to the Safe.
 * Timelock wrapping is not handled here; use propose-to-safe with --timelock when creating proposals if needed.
 */
export async function sendOrPropose({
  calldata,
  network,
  environment,
  diamondAddress,
}: {
  calldata: `0x${string}`
  network: string
  environment: EnvironmentEnum
  diamondAddress: string
}) {
  const isProd = environment === EnvironmentEnum.production
  const isTestnet = isTestnetNetwork(network)
  const sendDirectly =
    environment === EnvironmentEnum.staging ||
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true' ||
    isTestnet

  // ───────────── DIRECT TX FLOW ───────────── //
  if (sendDirectly) {
    consola.info('📤 Sending transaction directly to the Diamond...')

    // Testnet diamonds are owned by deployerWallet, so use the production key.
    const pkVar = isProd || isTestnet ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY'
    const pk = process.env[pkVar]
    if (!pk) throw new Error(`Missing ${pkVar} in environment`)

    // add 0x to privKey, if not there already
    const normalizedPk = pk.startsWith('0x') ? pk : `0x${pk}`
    const account = privateKeyToAccount(normalizedPk as `0x${string}`)

    const chain = getViemChainForNetworkName(network)

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    })

    // Use PublicClient to wait for tx
    const publicClient = createPublicClient({
      chain,
      transport: http(),
    })

    const hash = await walletClient
      .sendTransaction({
        to: getAddress(diamondAddress),
        data: calldata,
      })
      .catch((err: any) => {
        consola.error('❌ Failed to broadcast tx:', err)
        throw err
      })

    consola.info(`⏳ Waiting for tx ${hash} to be mined...`)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status !== 'success')
      throw new Error(`Tx reverted in block ${receipt.blockNumber}`)

    consola.success(`✅ Tx confirmed in block ${receipt.blockNumber}`)

    return
  }

  // ───────────── SAFE PROPOSAL FLOW ───────────── //
  const pk = process.env.PRIVATE_KEY_PRODUCTION
  if (!pk) throw new Error('Missing PRIVATE_KEY_PRODUCTION in environment')

  const { safe, chain, safeAddress } = await initializeSafeClient(network, pk)
  consola.info(`🔐 Proposing transaction to Safe ${safeAddress}`)

  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()

  const currentSafeNonce = await safe.getNonce()

  const nextNonce = await getNextNonce(
    pendingTransactions,
    safeAddress,
    network,
    chain.id,
    currentSafeNonce
  )

  const safeTransaction = await safe.createTransaction({
    transactions: [
      {
        to: diamondAddress as Address,
        value: 0n,
        data: calldata,
        operation: OperationTypeEnum.Call,
        nonce: nextNonce,
      },
    ],
  })

  const signedTx = await safe.signTransaction(safeTransaction)
  const safeTxHash = await safe.getTransactionHash(signedTx)

  consola.info('📝 Safe Address:', safeAddress)
  consola.info('🧾 Safe Tx Hash:', safeTxHash)

  try {
    const result = await storeTransactionInMongoDB(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      signedTx,
      safeTxHash,
      safe.account.address
    )

    if (result === null) {
      consola.info('ℹ️ Proposal already exists - no new proposal created')
      await mongoClient.close()
      return
    }

    if (!result.acknowledged)
      throw new Error('MongoDB insert was not acknowledged')

    consola.success('✅ Safe transaction proposed and stored in MongoDB')
  } catch (err: any) {
    consola.error('❌ Failed to store transaction in MongoDB:', err)
    await mongoClient.close()
    throw new Error(`Failed to store transaction in MongoDB: ${err.message}`)
  }

  await mongoClient.close()
}
