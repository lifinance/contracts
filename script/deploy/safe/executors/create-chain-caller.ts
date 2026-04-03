/**
 * Factory for creating a chain-agnostic {@link IChainCaller} (see `script/common/types.ts`).
 *
 * Picks the implementation from `networkName` via {@link isTronNetworkKey} so callers do not branch on chain type.
 */

import type { Account, PublicClient, WalletClient } from 'viem'

import type { IChainCaller } from '../../../common/types'
import { isTronNetworkKey } from '../../shared/tron-network-keys'
import type { TronTvmNetworkName } from '../../tron/types'

export interface ICreateChainCallerParams {
  networkName: string
  walletClient: WalletClient
  publicClient: PublicClient
  /** Required for EVM — extracted from walletClient.account if not provided. */
  account?: Account
  /** Required for Tron — raw hex private key for TronWeb signing. */
  privateKeyHex?: string
}

export async function createChainCaller(
  params: ICreateChainCallerParams
): Promise<IChainCaller> {
  // Tron TVM: TronWeb signing path — no viem wallet account; needs hex private key (see ICreateChainCallerParams.privateKeyHex).
  if (isTronNetworkKey(params.networkName)) {
    if (!params.privateKeyHex)
      throw new Error(
        'Tron chain caller requires a private key (privateKeyHex). ' +
          'Set PRIVATE_KEY_PRODUCTION in .env.'
      )

    // Lazy-loaded so EVM-only runs never pull in TronWeb (see [CONV:TRON-NETWORK-KEY] / 200-typescript.mdc).
    const { TronChainCaller } = await import('./tron-caller')
    return new TronChainCaller(
      params.networkName.toLowerCase() as TronTvmNetworkName,
      params.privateKeyHex
    )
  }

  // EVM: viem WalletClient + PublicClient + Account (from params or walletClient.account).
  const account =
    params.account ?? (params.walletClient.account as Account | undefined)
  if (!account)
    throw new Error(
      'EVM chain caller requires an account on the walletClient or passed explicitly.'
    )

  const { EvmChainCaller } = await import('./evm-caller')
  return new EvmChainCaller(params.walletClient, params.publicClient, account)
}
