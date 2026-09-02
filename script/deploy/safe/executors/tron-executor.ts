/**
 * Tron TVM chain executor — broadcasts Safe `execTransaction` via TronWeb native protocol.
 *
 * The execution is pre-flighted for energy first. The devkit broadcasts under a
 * fixed `fee_limit` from the environment, so a batch needing more energy than
 * the limit buys is not rejected — it runs until the limit is spent and aborts
 * part-way, leaving the Safe operation neither applied nor abandoned.
 */

import {
  evmHexToTronBase58,
  tronScanTransactionUrl,
  type TronTvmNetworkName,
  type TronWalletClient,
} from '@lifi/tron-devkit'
import { encodeFunctionData, type Hex } from 'viem'

import type {
  IChainExecutionParams,
  IChainExecutionResult,
  IChainExecutor,
} from '../../../common/types'
import { waitForConfirmation } from '../../../troncast/utils/tronweb'

import {
  configuredTronFeeLimitSun,
  estimateTronEnergy,
  tronEnergyCostInSun,
  type ITronEnergyCost,
} from './tron-energy-estimate'
import { assertTronBroadcastAffordable } from './tron-energy-preflight'

/**
 * Safe v1.4.1 `execTransaction`, and the zeroed gas parameters the devkit sends
 * with it.
 *
 * This has to stay identical to what `broadcastTronSafeExecTransaction` encodes,
 * because the estimate is only meaningful if it prices the call that is actually
 * broadcast. The devkit exposes no builder to borrow, so the shape is repeated
 * here rather than derived.
 */
const SAFE_EXEC_TRANSACTION_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    name: 'execTransaction',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Seams for the tests that prove a refusal never reaches the network. Nothing
 * in production overrides these; the defaults are the real implementations.
 */
export interface ITronExecutorDeps {
  estimateEnergy?: (
    calldata: Hex,
    params: IChainExecutionParams
  ) => Promise<bigint>
  costInSun?: (energy: bigint) => Promise<ITronEnergyCost>
}

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
    private readonly networkKey: TronTvmNetworkName,
    private readonly deps: ITronExecutorDeps = {}
  ) {}

  public async executeTransaction(
    params: IChainExecutionParams
  ): Promise<IChainExecutionResult> {
    await this.assertAffordable(params)

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

  /**
   * Refuses before the send when the execution has no usable energy estimate,
   * or needs more energy than the devkit's fee limit can pay for.
   *
   * @param params - The Safe execution about to be broadcast.
   * @throws When broadcasting would be a guess — see
   * {@link assertTronBroadcastAffordable}.
   */
  private async assertAffordable(params: IChainExecutionParams): Promise<void> {
    const calldata = encodeFunctionData({
      abi: SAFE_EXEC_TRANSACTION_ABI,
      functionName: 'execTransaction',
      args: [
        params.to,
        params.value,
        params.data,
        params.operation,
        0n,
        0n,
        0n,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        params.signatures,
      ],
    }) as Hex

    const estimate =
      this.deps.estimateEnergy ??
      ((data: Hex, execution: IChainExecutionParams) =>
        this.estimateEnergyOnChain(data, execution))
    const costInSun =
      this.deps.costInSun ?? ((energy: bigint) => this.costInSunOnChain(energy))

    await assertTronBroadcastAffordable(
      async () => ({
        estimatedResource: await estimate(calldata, params),
        resourceLabel: 'energy',
        estimateFailed: false,
      }),
      {
        networkName: this.networkKey,
        operation: `Safe execution on ${params.safeAddress}`,
        feeLimitSun: configuredTronFeeLimitSun(),
        costInSun,
      }
    )
  }

  private async estimateEnergyOnChain(
    calldata: Hex,
    params: IChainExecutionParams
  ): Promise<bigint> {
    const tronWeb = this.tronWalletClient.getTronWeb(this.networkKey)

    const ownerBase58 = tronWeb.defaultAddress.base58 as string
    if (!ownerBase58?.startsWith('T'))
      throw new Error('TronWeb defaultAddress.base58 missing after init')

    return estimateTronEnergy({
      networkKey: this.networkKey,
      ownerBase58,
      contractBase58: evmHexToTronBase58(tronWeb, params.safeAddress),
      data: calldata,
      callValue: params.value,
    })
  }

  private async costInSunOnChain(energy: bigint): Promise<ITronEnergyCost> {
    return tronEnergyCostInSun(
      this.tronWalletClient.getTronWeb(this.networkKey),
      energy
    )
  }
}
