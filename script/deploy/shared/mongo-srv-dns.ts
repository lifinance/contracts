import dns from 'node:dns'

import { consola } from 'consola'

/**
 * `mongodb+srv://` connections resolve an SRV record before anything else. Some
 * routers re-encode SRV answers with a name-compression pointer in the target
 * field, which RFC 2782 forbids: Node's resolver rejects those packets outright
 * (`querySrv EBADRESP`) while `dig`, `host` and the macOS system resolver accept
 * them - so DNS looks healthy from the shell while every Mongo command fails.
 */

const DEFAULT_FALLBACK_DNS_SERVERS = ['1.1.1.1', '8.8.8.8']

let fallbackApplied = false

const isSrvLookupError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.syscall === 'querySrv'

const getFallbackDnsServers = (): string[] => {
  const configured = process.env.MONGODB_DNS_SERVERS
  if (configured === undefined) return DEFAULT_FALLBACK_DNS_SERVERS

  return configured
    .split(',')
    .map((server) => server.trim())
    .filter((server) => server.length > 0)
}

/**
 * Runs a MongoDB connect call, retrying it once against public DNS servers when the
 * local resolver could not deliver a usable SRV record.
 *
 * The switch is deliberately failure-triggered rather than applied up front: pointing
 * the process at public resolvers unconditionally would bypass any split-horizon DNS
 * used for internal endpoints. It happens at most once, and the process keeps using
 * the fallback servers afterwards.
 *
 * @param connect - Callback performing the connect (e.g. `() => client.connect()`)
 * @returns Whatever the connect callback resolves to
 *
 * @example
 * ```typescript
 * const client = new MongoClient(mongoUri)
 * await withSrvDnsFallback(() => client.connect())
 * ```
 */
export const withSrvDnsFallback = async <T>(
  connect: () => Promise<T>
): Promise<T> => {
  try {
    return await connect()
  } catch (error) {
    if (fallbackApplied || !isSrvLookupError(error)) throw error

    const fallbackServers = getFallbackDnsServers()
    if (fallbackServers.length === 0) throw error

    const localServers = dns.getServers().join(', ')
    consola.warn(
      `MongoDB SRV lookup failed via the local DNS resolver (${localServers}). ` +
        `Retrying via ${fallbackServers.join(', ')} - ` +
        `set MONGODB_DNS_SERVERS to override.`
    )
    dns.setServers(fallbackServers)
    fallbackApplied = true

    return await connect()
  }
}

/** @internal Test-only hook to clear the once-per-process latch. */
export const resetSrvDnsFallbackForTests = (): void => {
  fallbackApplied = false
}
