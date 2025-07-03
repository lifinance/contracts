import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { IEnvironmentEnum } from '../common/types'
import {
  getNextNonce,
  getSafeMongoCollection,
  initializeSafeClient,
  OperationTypeEnum,
  storeTransactionInMongoDB,
} from '../deploy/safe/safe-utils'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

/**
 * Sends the calldata directly to the Diamond (if staging or override enabled),
 * or proposes it to the Safe (if production).
 */
export async function sendOrPropose({
  calldata,
  network,
  environment,
  diamondAddress,
}: {
  calldata: `0x${string}`
  network: string
  environment: IEnvironmentEnum
  diamondAddress: string
}) {
  const isProd = environment === IEnvironmentEnum.production
  const sendDirectly =
    environment === IEnvironmentEnum.staging ||
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true'

  // ───────────── DIRECT TX FLOW ───────────── //
  if (sendDirectly) {
    consola.info('📤 Sending transaction directly to the Diamond...')

    const pk = process.env[isProd ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY']
    if (!pk) throw new Error('Missing private key in environment')

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
  const pk = process.env.SAFE_SIGNER_PRIVATE_KEY
  if (!pk) throw new Error('Missing SAFE_SIGNER_PRIVATE_KEY in environment')

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
