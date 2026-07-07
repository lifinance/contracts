/**
 * Tron TVM chain executor — broadcasts Safe `execTransaction` via TronWeb native protocol.
 */

import {
  tronScanTransactionUrl,
  type TronTvmNetworkName,
  type TronWalletClient,
} from '@lifi/tron-devkit'

import type {
  IChainExecutionParams,
  IChainExecutionResult,
  IChainExecutor,
} from '../../../common/types'
import { waitForConfirmation } from '../../../troncast/utils/tronweb'

/**
 * Maps a Tron `getTransactionInfo` result to a normalized execution status.
 *
 * Tron populates `receipt.result` only on failure (e.g. 'REVERT',
 * 'OUT_OF_ENERGY', 'FAILED'); a successful contract call leaves it 'SUCCESS' or
 * unset. Anything set and not 'SUCCESS' is a revert, which on Tron's TVM rolls
 * back the Safe `nonce++` exactly as on EVM — so the nonce was not consumed.
 *
 * @param info - Raw object returned by `tronWeb.trx.getTransactionInfo`.
 * @returns 'reverted' when `receipt.result` is set and not 'SUCCESS'; otherwise 'success'.
 */
export function resolveTronExecutionStatus(
  info: unknown
): 'success' | 'reverted' {
  const result =
    typeof info === 'object' && info !== null && 'receipt' in info
      ? (info as { receipt?: { result?: unknown } }).receipt?.result
      : undefined
  return typeof result === 'string' && result !== 'SUCCESS'
    ? 'reverted'
    : 'success'
}

export class TronChainExecutor implements IChainExecutor {
  public constructor(
    private readonly tronWalletClient: TronWalletClient,
    private readonly networkKey: TronTvmNetworkName
  ) {}

  public async executeTransaction(
    params: IChainExecutionParams
  ): Promise<IChainExecutionResult> {
    const { txId, hash } =
      await this.tronWalletClient.executeSafeExecTransaction({
        networkName: this.networkKey,
        safeAddressEvm: params.safeAddress,
        to: params.to,
        value: params.value,
        data: params.data,
        operation: params.operation,
        signatures: params.signatures,
      })

    const displayHash = hash.replace(/^0x/i, '').toLowerCase()
    const explorerUrl = tronScanTransactionUrl(this.networkKey, displayHash)

    // Tron has no reconciliation back-fill (reconcile.ts skips Tron), so the
    // status must be resolved synchronously here — a deferred 'submitted' row
    // would never be corrected. waitForConfirmation throws on timeout, which
    // surfaces loudly rather than silently mis-marking the tx as executed.
    const tronWeb = this.tronWalletClient.getTronWeb(this.networkKey)
    const info = await waitForConfirmation(tronWeb, txId)
    const status = resolveTronExecutionStatus(info)

    return { hash, status, displayHash, explorerUrl }
  }
}
