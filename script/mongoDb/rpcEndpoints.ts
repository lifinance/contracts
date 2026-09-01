/**
 * Pure selection and ordering logic for the `RpcEndpoints` collection, kept free of any MongoDB
 * or filesystem dependency so it can be unit tested without a database connection.
 */

export interface IRpcEndpoint {
  url: string
  priority: number
  isActive?: boolean
  environment?: string
  network?: string
}

/** Query parameters providers use to carry an API key. */
const CREDENTIAL_QUERY_PARAMS = [
  'apikey',
  'api_key',
  'auth',
  'dkey',
  'key',
  'token',
]

/** A path segment this long and this shaped is a provider key, not a route. */
const CREDENTIAL_PATH_SEGMENT = /^[A-Za-z0-9_-]{20,}$/

/**
 * Whether an RPC URL carries provider credentials — basic auth, a key query parameter, or a
 * key-shaped path segment (the form thirdweb, Alchemy and Infura use).
 *
 * A heuristic, not a guarantee: it answers "does this URL look paid-for", which is what
 * separates a dedicated endpoint from a shared public one subject to strict rate limits.
 */
export function hasApiCredentials(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.username || parsed.password) return true

  for (const [name, value] of parsed.searchParams)
    if (CREDENTIAL_QUERY_PARAMS.includes(name.toLowerCase()) && value)
      return true

  return parsed.pathname
    .split('/')
    .some((segment) => CREDENTIAL_PATH_SEGMENT.test(segment))
}

/**
 * Endpoints usable for `environment`, highest priority first.
 *
 * `isActive` and `environment` are only honored when explicitly set: documents written before
 * those fields existed carry neither, and treating a missing field as a mismatch would drop
 * every endpoint on those chains.
 */
export function selectEndpoints(
  rpcs: IRpcEndpoint[],
  environment: string
): IRpcEndpoint[] {
  return rpcs
    .filter((rpc) => !!rpc.url)
    .filter((rpc) => rpc.isActive !== false)
    .filter((rpc) => !rpc.environment || rpc.environment === environment)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

/**
 * Priority for a newly added endpoint: below every endpoint already on the chain.
 *
 * Adding an endpoint must never change which one is primary — a new URL is a candidate until
 * someone promotes it deliberately with an explicit priority.
 */
export function lowestPriorityFor(rpcs: IRpcEndpoint[]): number {
  if (!rpcs.length) return 1
  return Math.min(...rpcs.map((rpc) => rpc.priority ?? 0)) - 1
}

/** Host of an RPC URL, never its path or query — either can carry the API key. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '<unparsable url>'
  }
}

/** Networks whose primary endpoint carries no provider credentials, with that endpoint's host. */
export function findUncredentialedPrimaries(
  endpointsByNetwork: Record<string, IRpcEndpoint[]>
): { network: string; host: string }[] {
  const flagged: { network: string; host: string }[] = []

  for (const [network, endpoints] of Object.entries(endpointsByNetwork)) {
    const primary = endpoints[0]
    if (!primary || hasApiCredentials(primary.url)) continue
    flagged.push({ network, host: hostOf(primary.url) })
  }

  return flagged.sort((a, b) => a.network.localeCompare(b.network))
}

/**
 * Reorder so every credentialed endpoint outranks every uncredentialed one, keeping the existing
 * relative order within each group — the operator's ranking among comparable endpoints is
 * intentional and is not ours to reshuffle.
 */
export function repairOrder(ordered: IRpcEndpoint[]): IRpcEndpoint[] {
  return [
    ...ordered.filter((endpoint) => hasApiCredentials(endpoint.url)),
    ...ordered.filter((endpoint) => !hasApiCredentials(endpoint.url)),
  ]
}

/** Descending priorities for a repaired order, highest first, leaving no ties. */
export function prioritiesFor(count: number): number[] {
  return Array.from({ length: count }, (_, index) => count - index)
}

/** Suffix carrying the lower-priority endpoints, consumed by the viem fallback transport. */
export const FALLBACKS_ENV_VAR_SUFFIX = '_FALLBACKS'

/**
 * Render the RPC section of the env file: one primary assignment per network plus, where the
 * chain has more than one usable endpoint, a space-separated fallback list.
 *
 * The primary keeps the plain `ETH_NODE_URI_<NETWORK>` name every Foundry and Bash caller
 * already reads, so ordering changes here cannot alter what those callers resolve.
 *
 * @param endpointsByEnvVar - Priority-ordered endpoints keyed by primary env var name.
 */
export function buildEnvLines(
  endpointsByEnvVar: Record<string, IRpcEndpoint[]>
): string[] {
  const byInitial: Record<string, [string, IRpcEndpoint[]][]> = {}

  for (const [envVar, endpoints] of Object.entries(endpointsByEnvVar)) {
    if (!endpoints.length) continue
    const initial = envVar.replace('ETH_NODE_URI_', '').charAt(0)
    byInitial[initial] ??= []
    byInitial[initial].push([envVar, endpoints])
  }

  return Object.keys(byInitial)
    .sort()
    .flatMap((initial, index) => {
      const group = (byInitial[initial] ?? []).sort(([a], [b]) =>
        a.localeCompare(b)
      )

      const entries = group.flatMap(([envVar, endpoints]) => {
        const [primary, ...fallbacks] = endpoints
        const lines = [`${envVar}="${primary?.url}"`]
        if (fallbacks.length)
          lines.push(
            `${envVar}${FALLBACKS_ENV_VAR_SUFFIX}="${fallbacks
              .map((endpoint) => endpoint.url)
              .join(' ')}"`
          )
        return [...lines, '']
      })

      return [
        ...(index === 0 ? [] : ['']),
        `# ====================== ${initial} ======================`,
        ...entries,
      ]
    })
}
