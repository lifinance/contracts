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
  OperationTypeEnum,
  getNextNonce,
  getSafeMongoCollection,
  initializeSafeClient,
  isAddressASafeOwner,
  resolveSafeSigningOptions,
  storeTransactionInMongoDB,
  type ISafeSigningOptions,
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
  signing,
}: {
  calldata: `0x${string}`
  network: string
  environment: EnvironmentEnum
  diamondAddress: string
  /**
   * Ledger flags for the Safe-proposal path; the direct-send path broadcasts
   * with the environment key and warns if a Ledger was asked for. Required, not
   * optional-with-a-default, so a new call site cannot silently omit it and fall
   * back to key-only signing.
   */
  signing: Omit<ISafeSigningOptions, 'envPrivateKey' | 'envPrivateKeyName'>
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

    if (signing.ledger)
      consola.warn(
        'Ignoring --ledger: this route broadcasts directly to the Diamond and signs with the environment key, not via the Safe.'
      )

    const pkVar = isProd ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY'
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
  const { useLedger, privateKey, ledgerOptions } = resolveSafeSigningOptions({
    ...signing,
    envPrivateKey: process.env.PRIVATE_KEY_PRODUCTION,
    envPrivateKeyName: 'PRIVATE_KEY_PRODUCTION',
  })

  if (useLedger) consola.info('Using Ledger hardware wallet for signing')

  const { safe, chain, safeAddress } = await initializeSafeClient(
    network,
    privateKey,
    undefined,
    useLedger,
    ledgerOptions
  )

  // Every other TS proposal funnel checks this. Without it a proposal signed by
  // a non-owner is stored and occupies a nonce, failing only at execution time —
  // and an operator-selected Ledger can now derive an unexpected address here.
  const signerAddress = safe.account.address
  const owners = await safe.getOwners()
  if (!isAddressASafeOwner(owners, signerAddress))
    throw new Error(
      `Cannot propose transactions: signer ${signerAddress} is not an owner of Safe ${safeAddress}`
    )

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
