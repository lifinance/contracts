/**
 * EVM chain caller — broadcasts arbitrary contract calls via viem JSON-RPC.
 */

import { consola } from 'consola'
import type {
  Account,
  Address,
  Chain,
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

export class EvmChainCaller implements IChainCaller {
  public readonly senderAddress: Address

  public constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly account: Account
  ) {
    this.senderAddress = account.address
  }

  public async simulate(
    params: IChainCallParams
  ): Promise<IChainSimulateResult> {
    const estimatedGas = await this.publicClient.estimateGas({
      account: this.senderAddress,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
    })

    return { estimatedResource: estimatedGas, resourceLabel: 'gas' }
  }

  public async call(params: IChainCallParams): Promise<IChainCallResult> {
    const txHash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.walletClient.chain as Chain | null,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
    })

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

      if (receipt.status === 'success')
        return { hash: txHash, receipt, gasUsed: receipt.gasUsed }
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
        return { hash: txHash }
      }
      throw timeoutError
    }
  }
}
