/**
 * Helpers for rotating the owner of every EVM staging LiFiDiamond — the shared,
 * network-independent pieces behind `rotateStagingDiamondOwner.ts`: the OwnershipFacet
 * ABI, staging-diamond enumeration, and pure ownership-state classification.
 *
 * Import this when you need to reason about staging diamond ownership without wiring up
 * RPC clients yourself (the classification is pure and unit-tested).
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { getAddress, parseAbi, type Address } from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../common/types'
import { getDeployments } from '../utils/deploymentHelpers'
import { getAllActiveNetworks } from '../utils/viemScriptHelpers'

/**
 * OwnershipFacet surface used during rotation. `owner()` is the only view the facet
 * exposes — the pending owner (`s.newOwner`) is private, so the intermediate
 * "transferred but not yet accepted" state is detected by simulating
 * `confirmOwnershipTransfer` from the incoming owner (see `classifyOwnershipState`).
 */
export const OWNERSHIP_FACET_ABI = parseAbi([
  'function owner() view returns (address)',
  'function transferOwnership(address _newOwner)',
  'function confirmOwnershipTransfer()',
])

/**
 * State of a single staging diamond within the two-step ownership transfer:
 * - `done`: owner already equals the incoming wallet (nothing left to do).
 * - `pending`: transfer initiated, awaiting `confirmOwnershipTransfer` from the incoming wallet.
 * - `not-started`: still owned by the outgoing wallet with no pending transfer to the incoming one.
 */
export type OwnershipState = 'done' | 'pending' | 'not-started'

export interface IStagingDiamond {
  network: SupportedChain
  diamond: Address
}

/**
 * Classifies a staging diamond's ownership-transfer progress from on-chain facts.
 *
 * @param currentOwner - Address returned by the diamond's `owner()`.
 * @param incomingOwner - The wallet we are rotating ownership to.
 * @param confirmWouldSucceed - Whether a read-only simulation of `confirmOwnershipTransfer`
 *   from `incomingOwner` succeeds (true ⇒ `incomingOwner` is the pending owner).
 * @returns The {@link OwnershipState}.
 */
export function classifyOwnershipState(
  currentOwner: Address,
  incomingOwner: Address,
  confirmWouldSucceed: boolean
): OwnershipState {
  if (getAddress(currentOwner) === getAddress(incomingOwner)) return 'done'
  return confirmWouldSucceed ? 'pending' : 'not-started'
}

/**
 * Enumerates every active EVM network (from `config/networks.json`) that has a staging
 * `LiFiDiamond` deployment. Tron networks are excluded — they use separate tooling.
 *
 * @returns The staging diamonds keyed by network, with checksummed addresses.
 */
export async function getStagingDiamonds(): Promise<IStagingDiamond[]> {
  const evmNetworks = getAllActiveNetworks().filter(
    (network) => !isTronNetworkKey(network.id)
  )

  const diamonds = await Promise.all(
    evmNetworks.map(async (network): Promise<IStagingDiamond | null> => {
      try {
        const deployments = await getDeployments(
          network.id as SupportedChain,
          EnvironmentEnum.staging
        )
        if (!deployments.LiFiDiamond) return null
        return {
          network: network.id as SupportedChain,
          diamond: getAddress(deployments.LiFiDiamond),
        }
      } catch {
        // No staging deployment file for this network — not an error, just skip it.
        return null
      }
    })
  )

  return diamonds.filter((entry): entry is IStagingDiamond => entry !== null)
}
