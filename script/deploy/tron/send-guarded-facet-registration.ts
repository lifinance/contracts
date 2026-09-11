/**
 * The batched diamondCut that registers facets, pre-flighted. Import it from
 * `register-facets-to-diamond.ts`; it lives here so a test can reach the real
 * send without loading that script's artifact and key handling.
 */

import { tronEnergyCostInSun } from './tron-energy-estimate.js'
import { sendGuardedTronContractCall } from './tron-guarded-send.js'

/** Fee limit the batched facet registration runs under. */
export const DIAMOND_CUT_FEE_LIMIT_SUN = 5_000_000_000 // 5000 TRX

/**
 * Pre-flights the fee limit, then broadcasts the batched diamondCut. The only
 * `.send()` on the facet-registration path.
 *
 * @param params - Clients, the diamond wrapper, the cuts, the energy already
 * estimated for them, and the cap the send runs under.
 * @returns The transaction id.
 * @throws Before broadcasting, when the fee limit cannot be shown to cover the
 * cut.
 */
export async function sendGuardedFacetRegistration(params: {
  tronWeb: { trx: { getEnergyPrices: () => Promise<string> } }
  diamond: {
    diamondCut: (
      facetCuts: unknown[],
      init: string,
      calldata: string
    ) => { send: (options: Record<string, unknown>) => Promise<string> }
  }
  network: string
  facetCuts: unknown[]
  /** Energy already estimated for these cuts, safety margin included. */
  estimatedEnergy: number
  feeLimitSun: number
}): Promise<string> {
  return sendGuardedTronContractCall({
    networkName: params.network,
    operation: `diamondCut registering ${params.facetCuts.length} facets`,
    feeLimitSun: params.feeLimitSun,
    estimateEnergy: async () => BigInt(params.estimatedEnergy),
    // Not the devkit's getCurrentPrices, which the printed estimate above uses:
    // it substitutes a constant when the read fails and returns 0 for an empty
    // price string, and a cost of zero clears any fee limit.
    costInSun: (energy) => tronEnergyCostInSun(params.tronWeb, energy),
    raiseFeeLimitHint: (requiredSun) =>
      `Register fewer facets at a time, or raise DIAMOND_CUT_FEE_LIMIT_SUN in ` +
      `script/deploy/tron/send-guarded-facet-registration.ts to at least ${requiredSun}.`,
    broadcast: () =>
      params.diamond
        .diamondCut(
          params.facetCuts,
          '0x0000000000000000000000000000000000000000',
          '0x'
        )
        .send({
          feeLimit: params.feeLimitSun,
          shouldPollResponse: true,
        }),
  })
}
