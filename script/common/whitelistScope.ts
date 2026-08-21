/**
 * Per-contract network scoping for diamond-called periphery whitelisting.
 *
 * `config/global.json` → `whitelistPeripheryFunctions` says *which selectors* a
 * periphery contract may be whitelisted with; `whitelistPeripheryNetworks` says
 * *where*. A contract absent from the network map is whitelisted on every network
 * it is deployed to, which is the behaviour for all but deliberately narrowed
 * contracts.
 */

export type IWhitelistNetworkScope = Record<string, string[]>

/**
 * Whether a periphery contract may be whitelisted on a given network.
 *
 * @param contractName - Periphery contract name as it appears in the deployment logs.
 * @param networkName - Network name as it appears in `config/networks.json`.
 * @param scope - Contents of `whitelistPeripheryNetworks`.
 * @returns `true` when the contract is unscoped, or scoped and `networkName` is listed.
 */
export function isNetworkInScope(
  contractName: string,
  networkName: string,
  scope: IWhitelistNetworkScope = {}
): boolean {
  const allowedNetworks = scope[contractName]
  if (!allowedNetworks) return true
  return allowedNetworks.some(
    (allowed) => allowed.toLowerCase() === networkName.toLowerCase()
  )
}
