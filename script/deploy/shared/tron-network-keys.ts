/**
 * Tron network-key detection — repo-owned source of truth.
 *
 * Per `[CONV:TRON-NETWORK-KEY]` in `.agents/rules/202-tron-scripts.md`, the
 * canonical mechanism for Tron-vs-EVM branching in this repo is the network
 * name as it appears in `config/networks.json` — not a hardcoded list inside
 * `@lifi/tron-devkit`. The devkit happens to ship its own `isTronNetworkKey`
 * with the same semantics today, but if this repo ever adds another Tron
 * variant (e.g. a new testnet) the change belongs here, not in the lib.
 *
 * Callers MUST import from this file (not the devkit) for any branching that
 * is sensitive to which networks this repo treats as Tron.
 */

/** Network keys this repo treats as Tron TVM (matches `config/networks.json`). */
const TRON_NETWORK_KEYS = ['tron', 'tronshasta'] as const

/**
 * Returns `true` when `networkName` is one of this repo's Tron network keys.
 *
 * Case-insensitive — call sites pass either the canonical config key or a
 * user-supplied string (e.g. CLI argument).
 */
export function isTronNetworkKey(
  networkName: string | undefined
): networkName is string {
  if (networkName === undefined) return false
  return (TRON_NETWORK_KEYS as readonly string[]).includes(
    networkName.toLowerCase()
  )
}
