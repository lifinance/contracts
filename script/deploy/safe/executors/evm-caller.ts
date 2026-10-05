/**
 * EVM chain caller — broadcasts arbitrary contract calls via viem JSON-RPC.
 */

import { consola } from 'consola'
import type {
  Account,
  Address,
  Chain,
  Hash,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from 'viem'

import type {
  IChainCallParams,
  IChainCallResult,
  IChainCaller,
  IChainSimulateResult,
} from '../../../common/types'
import { buildExplorerTxUrl } from '../../../utils/viemScriptHelpers'

import { getGasWithFallback, resolveGas } from './gas-with-fallback'
import { rebroadcastRawTransaction } from './rebroadcast-raw-tx'

export class EvmChainCaller implements IChainCaller {
  public readonly senderAddress: Address

  public constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly account: Account,
    private readonly networkName?: string
  ) {
    this.senderAddress = account.address
  }

  public async simulate(
    params: IChainCallParams
  ): Promise<IChainSimulateResult> {
    // Mirrors the multiplier `call()` applies so the dry-run figure reflects the
    // limit that would actually be used. Unlike `call()` this reports rather than
    // broadcasts, so a failed estimate falls back instead of refusing — a
    // simulation that throws tells the operator less than one that says "unknown,
    // assuming the fixed limit".
    const { gas, estimateFailed } = await resolveGas(
      () =>
        this.publicClient.estimateGas({
          account: this.senderAddress,
          to: params.to,
          data: params.data,
          value: params.value ?? 0n,
        }),
      {
        onEstimateFailure: 'fallback',
        networkName: this.networkName,
        operation: 'simulation',
      }
    )

    return { estimatedResource: gas, resourceLabel: 'gas', estimateFailed }
  }

  public async call(params: IChainCallParams): Promise<IChainCallResult> {
    // viem's default ~20% buffer can under-count post-call overhead — apply
    // GAS_ESTIMATE_MULTIPLIER. A failed estimate refuses rather than guessing,
    // because this path broadcasts.
    const gas = await getGasWithFallback(
      () =>
        this.publicClient.estimateGas({
          account: this.senderAddress,
          to: params.to,
          data: params.data,
          value: params.value ?? 0n,
        }),
      {
        onEstimateFailure: 'refuse',
        networkName: this.networkName,
        operation: 'contract call',
      }
    )

    const request = {
      account: this.account,
      chain: this.walletClient.chain as Chain | null,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
      gas,
    }

    // Signed here rather than inside `sendTransaction` so the exact bytes can be re-sent to
    // other endpoints if the one that accepted them drops the transaction.
    let serializedTransaction: Hex | undefined
    let txHash: Hash
    if (this.account.type === 'local') {
      const prepared = await this.walletClient.prepareTransactionRequest(
        request
      )
      serializedTransaction = await this.walletClient.signTransaction(prepared)
      txHash = await this.walletClient.sendRawTransaction({
        serializedTransaction,
      })
    } else txHash = await this.walletClient.sendTransaction(request)

    consola.info(`Blockchain Transaction Hash: \u001b[33m${txHash}\u001b[0m`)

    // Wait for receipt with 30 second timeout
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

      return this.resultFromReceipt(txHash, receipt)
    } catch (timeoutError: unknown) {
      const errorMsg =
        timeoutError instanceof Error
          ? timeoutError.message
          : String(timeoutError)
      if (errorMsg.includes('timeout')) {
        consola.warn(
          `⚠️  Transaction submitted but confirmation timed out after 30 seconds`
        )
        const rpcUrls = this.walletClient.chain?.rpcUrls.default.http ?? []
        if (serializedTransaction && rpcUrls.length) {
          const { receipt: rebroadcastReceipt } =
            await rebroadcastRawTransaction({
              serializedTransaction,
              hash: txHash,
              rpcUrls,
              networkName: this.networkName,
            })
          if (rebroadcastReceipt)
            return this.resultFromReceipt(txHash, rebroadcastReceipt)
        }
        consola.warn(`   Transaction hash: ${txHash}`)
        consola.warn(`   Please manually verify transaction status later`)
        const explorerUrl = this.networkName
          ? buildExplorerTxUrl(this.networkName, txHash)
          : undefined
        return { hash: txHash, explorerUrl }
      }
      throw timeoutError
    }
  }

  private resultFromReceipt(
    hash: Hash,
    receipt: TransactionReceipt
  ): IChainCallResult {
    if (receipt.status !== 'success')
      throw new Error(`Transaction failed with status: ${receipt.status}`)
    const explorerUrl = this.networkName
      ? buildExplorerTxUrl(this.networkName, hash)
      : undefined
    return { hash, receipt, gasUsed: receipt.gasUsed, explorerUrl }
  }
}
