/**
 * Tron TVM wallet for scripts: same secp256k1 key as viem’s local account, TronWeb + full-node HTTP.
 * Re-exports chain and Safe-exec types/helpers used with {@link TronWalletClient}.
 */

import type { TronWeb } from 'tronweb'

import type {
  IExecuteSafeExecTronWebResult,
  ITronSafeExecParams,
  TronTvmNetworkName,
} from '../types'

import { broadcastTronSafeExecTransaction } from './tronSafeExecBroadcast'
import { createTronWebForTvmNetworkKey } from './tronWebFactory'

export type {
  IExecuteSafeExecTronWebResult,
  ITronSafeExecParams,
  TronTvmNetworkName,
} from '../types'
export { getTronNetworkKeyForChainId, isTronTvmChainId } from './tronTvmChain'

export class TronWalletClient {
  private readonly privateKeyHex: string

  /**
   * @param privateKeyHex - 32-byte hex, with or without `0x` (same string you pass to viem `privateKeyToAccount`).
   */
  public constructor(privateKeyHex: string) {
    this.privateKeyHex = privateKeyHex
  }

  public getTronWeb(networkName: TronTvmNetworkName): TronWeb {
    return createTronWebForTvmNetworkKey({
      networkKey: networkName,
      privateKey: this.privateKeyHex,
    })
  }

  public async executeSafeExecTransaction(
    params: ITronSafeExecParams
  ): Promise<IExecuteSafeExecTronWebResult> {
    return broadcastTronSafeExecTransaction({
      ...params,
      privateKeyHex: this.privateKeyHex,
    })
  }
}
