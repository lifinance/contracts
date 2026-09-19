/**
 * Refuses a Safe-proposal-store URI that would put its credentials on the wire
 * in the clear.
 *
 * The classifier is the credential, not the host. A URI that carries one
 * reaches a real store — `lifi-connect` forwards production Mongo to a
 * `localhost` port, so the host says nothing about which store is on the other
 * end, and a rule that read "loopback" as "a local store" would clear the
 * production one. A URI that carries none reaches a store that has nothing to
 * protect, and is let through untouched.
 *
 * Loopback appears below only as a property of the wire: a connection that
 * cannot leave the machine cannot be read off it, which is why
 * `docs/Setup.md` pairs the credentialed production URI with `tls=false` —
 * TLS terminates at the tunnel. It is never taken as evidence about the store.
 */

/** The shape a connection string must have before any of it can be trusted. */
const MONGO_URI =
  /^(mongodb(?:\+srv)?):\/\/(?:([^@/]*)@)?([^/?]+)(?:\/[^?]*)?(?:\?(.*))?$/i

/** An octet, bounded: `127.999.999.999` is not an address and must not read as one. */
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`
const IPV4_LOOPBACK = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)
const isIpv4Loopback = (hostname: string): boolean =>
  IPV4_LOOPBACK.test(hostname)

/** Hosts a packet cannot leave the machine to reach. */
const isLoopbackHost = (host: string): boolean => {
  const hostname = (
    host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : host.split(':')[0] ?? host
  ).toLowerCase()
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    // Trailing-dot and IPv4-mapped spellings resolve to the same interface, so a
    // tunnel URI written either way must not be refused.
    hostname === 'localhost.' ||
    hostname === '::ffff:127.0.0.1' ||
    isIpv4Loopback(hostname) ||
    // A unix-domain socket, which reaches the driver as a percent-encoded path.
    hostname.startsWith('%2f') ||
    hostname.startsWith('/')
  )
}

/**
 * Whether the driver will negotiate TLS for this URI.
 *
 * `mongodb+srv` turns TLS on by default and plain `mongodb` leaves it off, so
 * the default is read from the scheme and only then overridden by an explicit
 * option. `tls` and `ssl` are aliases and Mongo matches option names
 * case-insensitively, hence the lowercased scan rather than a `URLSearchParams`
 * lookup on one spelling.
 */
const negotiatesTls = (scheme: string, query: string): boolean => {
  let enabled = scheme.toLowerCase() === 'mongodb+srv'
  for (const [name, value] of new URLSearchParams(query))
    if (name.toLowerCase() === 'tls' || name.toLowerCase() === 'ssl')
      enabled = value.toLowerCase() === 'true'
  return enabled
}

/**
 * Throws unless every host this URI names can carry its credentials safely.
 *
 * @param uri - A MongoDB connection string. Never included in a thrown message:
 *   the value it is checked for carrying is exactly what must not reach a log.
 * @param variableName - The environment variable the URI came from, so the
 *   refusal names what to fix.
 * @throws Error if the URI is unparseable, or carries credentials to a host it
 *   would reach over an unencrypted connection.
 */
export function assertStoreCredentialsAreEncrypted(
  uri: string,
  variableName = 'SC_MONGODB_URI'
): void {
  const parsed = MONGO_URI.exec(uri.trim())
  if (!parsed)
    throw new Error(
      `${variableName} is not a MongoDB connection string, so its transport cannot be checked.`
    )

  // Groups 1 and 3 are unconditional in the pattern, so the fallbacks below are
  // unreachable on a match; they are empty rather than absent so that a pattern
  // change which did make them optional fails closed instead of skipping a host.
  const scheme = parsed[1] ?? ''
  const userInfo = parsed[2]
  const hostList = parsed[3] ?? ''
  const query = parsed[4] ?? ''

  // Any userinfo at all, including a password with no username: what matters is
  // that a secret is in the string, not that both halves of one are.
  if (!userInfo) return

  if (negotiatesTls(scheme, query)) return

  const exposed = hostList.split(',').filter((host) => !isLoopbackHost(host))
  if (exposed.length === 0) return

  throw new Error(
    `${variableName} carries credentials to ${exposed.join(
      ', '
    )} over an unencrypted connection. This URI reaches a credentialed store, not a local one — add tls=true, or point it at the localhost port that \`lifi-connect prod smart-contracts\` forwards.`
  )
}
