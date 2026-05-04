/**
 * Tron TVM network keys as in `networks.json`, CLI, and Mongo (addresses may be base58).
 */

export function isTronNetworkKey(
  networkName: string | undefined
): networkName is string {
  if (networkName === undefined) return false
  const key = networkName.toLowerCase()
  return key === 'tron' || key === 'tronshasta'
}
