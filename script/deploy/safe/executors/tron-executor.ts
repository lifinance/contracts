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

export class TronChainExecutor implements IChainExecutor {
  public constructor(
    private readonly tronWalletClient: TronWalletClient,
    private readonly networkKey: TronTvmNetworkName
  ) {}

  public async executeTransaction(
    params: IChainExecutionParams
  ): Promise<IChainExecutionResult> {
    const { hash } = await this.tronWalletClient.executeSafeExecTransaction({
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

    return { hash, displayHash, explorerUrl }
  }
}
