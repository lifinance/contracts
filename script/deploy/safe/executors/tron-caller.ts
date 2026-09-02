/**
 * Tron TVM chain caller — broadcasts arbitrary contract calls via TronWeb native protocol.
 *
 * Every broadcast is pre-flighted for energy first. The devkit sends under a
 * fixed `fee_limit` from the environment, so without a pre-flight a call that
 * needs more energy than the limit buys is not rejected — it runs until the
 * limit is spent and aborts part-way.
 */

import {
  createTronWebForTvmNetworkKey,
  evmHexToTronBase58,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import { broadcastTronContractCall } from '@lifi/tron-devkit/safe'
import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type {
  IChainCallParams,
  IChainCallResult,
  IChainCaller,
  IChainSimulateResult,
} from '../../../common/types'

import {
  configuredTronFeeLimitSun,
  estimateTronEnergy,
  tronEnergyCostInSun,
} from './tron-energy-estimate'
import { assertTronBroadcastAffordable } from './tron-energy-preflight'

/**
 * Seams for the tests that prove a refusal never reaches the network. Nothing
 * in production overrides these; the defaults are the real implementations.
 */
export interface ITronCallerDeps {
  broadcast?: typeof broadcastTronContractCall
  estimateEnergy?: (params: IChainCallParams) => Promise<bigint>
  costInSun?: (energy: bigint) => Promise<bigint>
}

export class TronChainCaller implements IChainCaller {
  public readonly senderAddress: Address

  private readonly broadcast: typeof broadcastTronContractCall
  private readonly estimateEnergy: (params: IChainCallParams) => Promise<bigint>
  private readonly costInSun: (energy: bigint) => Promise<bigint>

  public constructor(
    private readonly networkKey: TronTvmNetworkName,
    private readonly privateKeyHex: string,
    deps: ITronCallerDeps = {}
  ) {
    this.broadcast = deps.broadcast ?? broadcastTronContractCall
    this.estimateEnergy =
      deps.estimateEnergy ?? ((params) => this.estimateEnergyOnChain(params))
    this.costInSun =
      deps.costInSun ?? ((energy) => this.costInSunOnChain(energy))
    const normalized = privateKeyHex.startsWith('0x')
      ? privateKeyHex
      : `0x${privateKeyHex}`
    this.senderAddress = privateKeyToAccount(
      normalized as `0x${string}`
    ).address
  }

  /**
   * Estimates without broadcasting.
   *
   * Throws when there is no estimate rather than returning a fallback figure:
   * there is no meaningful fixed energy number to report, and a dry run must
   * not read as green when the executing path would refuse on the same
   * failure. {@link assertTronBroadcastAffordable} treats the throw as the
   * absence of an estimate.
   */
  public async simulate(
    params: IChainCallParams
  ): Promise<IChainSimulateResult> {
    return {
      estimatedResource: await this.estimateEnergy(params),
      resourceLabel: 'energy',
      estimateFailed: false,
    }
  }

  public async call(params: IChainCallParams): Promise<IChainCallResult> {
    await assertTronBroadcastAffordable(() => this.simulate(params), {
      networkName: this.networkKey,
      operation: `contract call to ${params.to}`,
      feeLimitSun: configuredTronFeeLimitSun(),
      costInSun: this.costInSun,
    })

    const { hash } = await this.broadcast({
      networkKey: this.networkKey,
      privateKeyHex: this.privateKeyHex,
      contractAddress: params.to,
      calldata: params.data,
      callValue: params.value,
    })

    return { hash }
  }

  private tronWeb(): ReturnType<typeof createTronWebForTvmNetworkKey> {
    return createTronWebForTvmNetworkKey({
      networkKey: this.networkKey,
      privateKey: this.privateKeyHex,
    })
  }

  private async estimateEnergyOnChain(
    params: IChainCallParams
  ): Promise<bigint> {
    const tronWeb = this.tronWeb()

    const ownerBase58 = tronWeb.defaultAddress.base58 as string
    if (!ownerBase58?.startsWith('T'))
      throw new Error('TronWeb defaultAddress.base58 missing after init')

    return estimateTronEnergy({
      networkKey: this.networkKey,
      ownerBase58,
      contractBase58: evmHexToTronBase58(tronWeb, params.to),
      data: params.data,
      callValue: params.value ?? 0n,
    })
  }

  private async costInSunOnChain(energy: bigint): Promise<bigint> {
    return tronEnergyCostInSun(this.tronWeb(), energy)
  }
}
