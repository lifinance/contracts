/**
 * Hostnames that honor TronGrid `TRON-PRO-API-KEY` (aligned with `tron` / `tronshasta` in
 * config/networks.json). Extend only when adding officially supported TronGrid RPC hosts.
 */
const TRONGRID_RPC_HOSTS = new Set([
  'api.trongrid.io',
  'api.shasta.trongrid.io',
])

function tronGridHostnameFromUrlString(urlString: string): string | null {
  const trimmed = urlString.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).hostname.toLowerCase()
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase()
    } catch {
      return null
    }
  }
}

/** Whether `rpcUrl` points at TronGrid (API key sent as `TRON-PRO-API-KEY`). */
export function isTronGridRpcUrl(rpcUrl: string): boolean {
  const host = tronGridHostnameFromUrlString(rpcUrl)
  return host !== null && TRONGRID_RPC_HOSTS.has(host)
}
