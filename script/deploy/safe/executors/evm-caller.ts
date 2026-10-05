/**
 * EVM chain caller — broadcasts arbitrary contract calls via viem JSON-RPC.
 */

import { consola } from 'consola'
import type {
  Account,
  Address,
  Chain,
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

    const { hash: txHash, rawTransaction } = await this.broadcast(params, gas)

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

      const explorerUrl = this.networkName
        ? buildExplorerTxUrl(this.networkName, txHash)
        : undefined

      if (receipt.status === 'success')
        return {
          hash: txHash,
          receipt,
          gasUsed: receipt.gasUsed,
          explorerUrl,
          rawTransaction,
        }
      else throw new Error(`Transaction failed with status: ${receipt.status}`)
    } catch (timeoutError: unknown) {
      const errorMsg =
        timeoutError instanceof Error
          ? timeoutError.message
          : String(timeoutError)
      if (errorMsg.includes('timeout')) {
        consola.warn(
          `⚠️  Transaction submitted but confirmation timed out after 30 seconds`
        )
        consola.warn(`   Transaction hash: ${txHash}`)
        consola.warn(`   Please manually verify transaction status later`)
        const explorerUrl = this.networkName
          ? buildExplorerTxUrl(this.networkName, txHash)
          : undefined
        return { hash: txHash, explorerUrl, rawTransaction }
      }
      throw timeoutError
    }
  }

  /**
   * A local account signs here and the signed bytes are kept, so a caller can
   * re-send the identical transaction (same nonce) to another endpoint when the
   * first one accepts it and then drops it.
   */
  private async broadcast(
    params: IChainCallParams,
    gas: bigint
  ): Promise<{ hash: Hex; rawTransaction?: Hex }> {
    const request = {
      account: this.account,
      chain: this.walletClient.chain as Chain | null,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
      gas,
    }

    if (this.account.type !== 'local')
      return { hash: await this.walletClient.sendTransaction(request) }

    const prepared = await this.walletClient.prepareTransactionRequest(request)
    const rawTransaction = await this.walletClient.signTransaction(prepared)
    const hash = await this.walletClient.sendRawTransaction({
      serializedTransaction: rawTransaction,
    })
    return { hash, rawTransaction }
  }
}
