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
import { buildExplorerTxUrl } from '../../../utils/viemScriptHelpers'
import { SAFE_SINGLETON_ABI } from '../config'

import { getGasWithFallback } from './gas-with-fallback'

export class EvmChainExecutor implements IChainExecutor {
  public constructor(
    private readonly walletClient: WalletClient,
    private readonly publicClient: PublicClient,
    private readonly account: Account,
    private readonly networkName?: string
  ) {}

  public async executeTransaction(
    params: IChainExecutionParams
  ): Promise<IChainExecutionResult> {
    const execArgs = [
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
    ] as const

    // eth_estimateGas can under-count the Safe post-call overhead (ExecutionSuccess
    // event, refund logic), causing OOG reverts on chains with tight simulation vs.
    // execution deltas (e.g. Jovay). On some chains eth_estimateGas also fails
    // outright even when the call would succeed on-chain — getGasWithFallback
    // applies GAS_ESTIMATE_MULTIPLIER and falls back to a fixed gas limit in
    // that case.
    const gas = await getGasWithFallback(() =>
      this.publicClient.estimateContractGas({
        account: this.account,
        address: params.safeAddress,
        abi: SAFE_SINGLETON_ABI,
        functionName: 'execTransaction',
        args: execArgs,
      })
    )

    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: null,
      address: params.safeAddress,
      abi: SAFE_SINGLETON_ABI,
      functionName: 'execTransaction',
      args: execArgs,
      gas,
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

      const explorerUrl = this.networkName
        ? buildExplorerTxUrl(this.networkName, txHash)
        : undefined

      if (receipt.status === 'success')
        return { hash: txHash, receipt, explorerUrl }
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
        return { hash: txHash, explorerUrl }
      }
      throw timeoutError
    }
  }
}
