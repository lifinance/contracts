/**
 * EVM chain executor — broadcasts Safe `execTransaction` via viem JSON-RPC.
 */

import { consola } from 'consola'
import type {
  Account,
  Address,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from 'viem'

import type {
  IChainExecutionParams,
  IChainExecutionResult,
  IChainExecutor,
} from '../../../common/types'
import { SAFE_SINGLETON_ABI } from '../config'

export class EvmChainExecutor implements IChainExecutor {
  public constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly account: Account
  ) {}

  public async executeTransaction(
    params: IChainExecutionParams
  ): Promise<IChainExecutionResult> {
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: null,
      address: params.safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'execTransaction',
      args: [
        params.to,
        params.value,
        params.data,
        params.operation,
        0n, // safeTxGas
        0n, // baseGas
        0n, // gasPrice
        '0x0000000000000000000000000000000000000000' as Address, // gasToken
        '0x0000000000000000000000000000000000000000' as Address, // refundReceiver
        params.signatures,
      ],
    })

    consola.info(`Blockchain Transaction Hash: \u001b[33m${txHash}\u001b[0m`)

    // Try to get receipt with 30 second timeout
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

      if (receipt.status === 'success') return { hash: txHash, receipt }
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
