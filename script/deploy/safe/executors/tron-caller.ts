/**
 * Tron TVM chain caller — broadcasts arbitrary contract calls via TronWeb native protocol.
 */

import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type {
  IChainCallParams,
  IChainCallResult,
  IChainCaller,
  IChainSimulateResult,
} from '../../../common/types'
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout'
import {
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
} from '../../tron/constants'
import {
  buildTronWalletJsonPostHeaders,
  getTronRPCConfig,
} from '../../tron/helpers/tronRpcConfig'
import { broadcastTronContractCall } from '../../tron/helpers/tronSafeExecBroadcast'
import {
  createTronWebForTvmNetworkKey,
  resolveTronWebRpcUrlToFullHost,
} from '../../tron/helpers/tronWebFactory'
import { evmHexToTronBase58 } from '../../tron/tronAddressHelpers'
import type { TronTvmNetworkName } from '../../tron/types'

export class TronChainCaller implements IChainCaller {
  public readonly senderAddress: Address

  public constructor(
    private readonly networkKey: TronTvmNetworkName,
    private readonly privateKeyHex: string
  ) {
    const normalized = privateKeyHex.startsWith('0x')
      ? privateKeyHex
      : `0x${privateKeyHex}`
    this.senderAddress = privateKeyToAccount(
      normalized as `0x${string}`
    ).address
  }

  public async simulate(
    params: IChainCallParams
  ): Promise<IChainSimulateResult> {
    const tronWeb = createTronWebForTvmNetworkKey({
      networkKey: this.networkKey,
      privateKey: this.privateKeyHex,
    })

    const ownerBase58 = tronWeb.defaultAddress.base58 as string
    if (!ownerBase58?.startsWith('T'))
      throw new Error('TronWeb defaultAddress.base58 missing after init')

    const contractBase58 = evmHexToTronBase58(tronWeb, params.to)

    const { rpcUrl } = getTronRPCConfig(this.networkKey)
    const fullHost = resolveTronWebRpcUrlToFullHost(rpcUrl, this.networkKey)
    const apiUrl =
      fullHost.replace(/\/$/, '') + '/wallet/triggerconstantcontract'

    const dataHexNo0x = params.data.slice(2)
    const callValue =
      params.value && params.value > 0n ? Number(params.value) : 0

    const payload = {
      owner_address: ownerBase58,
      contract_address: contractBase58,
      data: dataHexNo0x,
      fee_limit: TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
      call_value: callValue,
      visible: true,
    }

    const res = await fetchWithTimeout(
      apiUrl,
      {
        method: 'POST',
        headers: buildTronWalletJsonPostHeaders(fullHost),
        body: JSON.stringify(payload),
      },
      TRON_WALLET_API_FETCH_TIMEOUT_MS
    )

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`triggerconstantcontract failed: ${res.status} ${text}`)
    }

    const result = (await res.json()) as {
      energy_used?: number
      result?: { result?: boolean; message?: string }
    }

    if (
      result.result?.result === false ||
      result.energy_used === undefined ||
      result.energy_used === null
    )
      throw new Error(
        `Tron simulation failed: ${JSON.stringify(result.result ?? result)}`
      )

    return {
      estimatedResource: BigInt(result.energy_used),
      resourceLabel: 'energy',
    }
  }

  public async call(params: IChainCallParams): Promise<IChainCallResult> {
    const { hash } = await broadcastTronContractCall({
      networkKey: this.networkKey,
      privateKeyHex: this.privateKeyHex,
      contractAddress: params.to,
      calldata: params.data,
      callValue: params.value,
    })

    return { hash }
  }
}
