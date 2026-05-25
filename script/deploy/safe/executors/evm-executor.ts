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

    const explorerUrl = this.networkName
      ? buildExplorerTxUrl(this.networkName, txHash)
      : undefined

    // After broadcast we must never throw — the tx may have landed on-chain
    // even when receipt polling fails (timeout, RPC drop, parse error). The
    // caller persists the hash and the reconciliation step resolves the final
    // status on the next run. A reverted receipt is returned as-is so the
    // caller can record status: 'reverted' rather than treat it as unknown.
    let receipt: TransactionReceipt | undefined
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
    } catch (pollError: unknown) {
      const errorMsg =
        pollError instanceof Error ? pollError.message : String(pollError)
      consola.warn(`⚠️  Could not confirm transaction within 30s: ${errorMsg}`)
      consola.warn(`   Transaction hash: ${txHash}`)
      consola.warn(`   Reconciliation will resolve the final status next run.`)
    }

    return { hash: txHash, receipt, explorerUrl }
  }
}
