/**
 * Per-contract network scoping for diamond-called periphery whitelisting.
 *
 * `config/global.json` → `whitelistPeripheryFunctions` says *which selectors* a
 * periphery contract may be whitelisted with; `whitelistPeripheryNetworks` says
 * *where*. A contract absent from the network map is whitelisted on every network
 * it is deployed to, which is the behaviour for all but deliberately narrowed
 * contracts.
 */

export type WhitelistNetworkScope = Record<string, string[]>

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
  scope: WhitelistNetworkScope = {}
): boolean {
  const allowedNetworks = scope[contractName]
  if (!allowedNetworks) return true
  return allowedNetworks.some(
    (allowed) => allowed.toLowerCase() === networkName.toLowerCase()
  )
}

/**
 * Rejects a scope map that names a contract absent from the eligible set.
 *
 * Lookups in `isNetworkInScope` are case-sensitive and unmatched names fall through to
 * "unscoped", so a typo would silently widen a contract to the whole fleet — the exact
 * failure the scope map exists to prevent. Fail closed instead.
 *
 * @param scope - Contents of `whitelistPeripheryNetworks`.
 * @param eligibleContracts - Keys of `whitelistPeripheryFunctions`.
 * @throws When the scope map names a contract that is not whitelist-eligible.
 */
export function assertScopeContractsEligible(
  scope: WhitelistNetworkScope,
  eligibleContracts: Iterable<string>
): void {
  const eligible = new Set(eligibleContracts)
  const unknown = Object.keys(scope).filter((name) => !eligible.has(name))
  if (unknown.length > 0)
    throw new Error(
      `config/global.json whitelistPeripheryNetworks names contract(s) absent from whitelistPeripheryFunctions: ${unknown.join(
        ', '
      )}`
    )
}
