/**
 * Factory for creating a chain-agnostic {@link IChainCaller}.
 *
 * Picks EVM vs Tron based on the network name so that calling scripts
 * never branch on chain type.
 */

import type { Account, PublicClient, WalletClient } from 'viem'

import { isTronNetworkKey } from '../../shared/tron-network-keys'
import type { TronTvmNetworkName } from '../../tron/helpers/tronTvmChain'
import type { IChainCaller } from '../chain-executor'

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
  if (isTronNetworkKey(params.networkName)) {
    if (!params.privateKeyHex)
      throw new Error(
        'Tron chain caller requires a private key (privateKeyHex). ' +
          'Set PRIVATE_KEY_PRODUCTION in .env.'
      )

    const { TronChainCaller } = await import('./tron-caller')
    return new TronChainCaller(
      params.networkName.toLowerCase() as TronTvmNetworkName,
      params.privateKeyHex
    )
  }

  const account =
    params.account ?? (params.walletClient.account as Account | undefined)
  if (!account)
    throw new Error(
      'EVM chain caller requires an account on the walletClient or passed explicitly.'
    )

  const { EvmChainCaller } = await import('./evm-caller')
  return new EvmChainCaller(params.walletClient, params.publicClient, account)
}
