/**
 * The direct-EOA `transferOwnership` broadcast, pre-flighted. Import it from
 * `transfer-ownership-to-timelock.ts`; it lives here so a test can reach the
 * real send without loading that script's deployment and key handling.
 */

import { TRANSFER_OWNERSHIP_FEE_LIMIT_SUN } from './constants.js'
import { tronEnergyCostInSun } from './tron-energy-estimate.js'
import {
  estimateTronEnergyBySelector,
  sendGuardedTronContractCall,
  type ITronConstantContractCaller,
} from './tron-guarded-send.js'

/**
 * TronWeb's contract wrapper resolves methods dynamically, so its own type
 * carries none of them and a call site has to name the one it uses.
 */
export interface ITronOwnershipDiamond {
  transferOwnership: (to: string) => {
    send: (options: Record<string, unknown>) => Promise<string>
  }
}

/**
 * Pre-flights the fee limit, then broadcasts the ownership transfer. The only
 * `.send()` on this path.
 *
 * @param params - Clients, the diamond wrapper, and the addresses involved.
 * @returns The transaction id.
 * @throws Before broadcasting, when the fee limit cannot be shown to cover the
 * call.
 */
export const sendTransferOwnership = async (params: {
  tronWeb: ITronConstantContractCaller & {
    trx: { getEnergyPrices: () => Promise<string> }
  }
  diamond: ITronOwnershipDiamond
  networkName: string
  diamondAddress: string
  timelockBase58: string
}): Promise<string> =>
  sendGuardedTronContractCall({
    networkName: params.networkName,
    operation: `transferOwnership(${params.timelockBase58}) on ${params.diamondAddress}`,
    feeLimitSun: TRANSFER_OWNERSHIP_FEE_LIMIT_SUN,
    estimateEnergy: () =>
      estimateTronEnergyBySelector({
        tronWeb: params.tronWeb,
        contractAddress: params.diamondAddress,
        functionSelector: 'transferOwnership(address)',
        parameters: [{ type: 'address', value: params.timelockBase58 }],
      }),
    costInSun: (energy) => tronEnergyCostInSun(params.tronWeb, energy),
    raiseFeeLimitHint: (requiredSun) =>
      `Raise TRANSFER_OWNERSHIP_FEE_LIMIT_SUN in script/deploy/tron/constants.ts ` +
      `to at least ${requiredSun}.`,
    broadcast: () =>
      params.diamond.transferOwnership(params.timelockBase58).send({
        feeLimit: TRANSFER_OWNERSHIP_FEE_LIMIT_SUN,
        shouldPollResponse: true,
      }),
  })
