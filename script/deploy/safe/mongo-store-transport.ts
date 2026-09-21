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

/**
 * The shape a connection string must have before any of it can be trusted.
 *
 * The host group excludes `@`, `?` and `#` so that a URI carrying one of them
 * unencoded fails the match rather than splitting mid-credential. A permissive
 * host group read the `ss@host` of `user:pa@ss@host` as the host and put that
 * half of the password into the refusal message below.
 *
 * This is deliberately stricter than the driver, which is not a parser we can
 * borrow here: the connection-string spec requires a literal `@`, `?` or `#` in
 * userinfo to be percent-encoded, but `mongodb-connection-string-url` accepts
 * such a URI anyway by splitting on the last `@` and dropping any fragment. We
 * refuse instead, because the cost of guessing which half is the password is a
 * leaked credential and the cost of refusing is an operator encoding one.
 */
const MONGO_URI =
  /^(mongodb(?:\+srv)?):\/\/(?:([^@/?#]*)@)?([^@/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?$/i

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
 * Options that keep TLS on the wire but stop it proving who is on the other
 * end of it.
 *
 * A session that accepts any certificate or any hostname is one an impersonator
 * can terminate, and the driver hands over the credentials during
 * authentication — before anything the store says could give it away. So these
 * belong with `tls=false` rather than with TLS.
 */
const PEER_VALIDATION_DISABLED = new Set([
  'tlsinsecure',
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
])

/**
 * The peer-validation options this URI turns on, in the spelling it used.
 *
 * Last occurrence wins, matching `negotiatesTls`. The driver does not get that
 * far — it refuses a repeated option outright — so this only keeps the guard
 * from being the one to report a URI the driver would reject anyway.
 */
const relaxedTlsOptions = (query: string): string[] => {
  const relaxed = new Map<string, string>()
  for (const [name, value] of new URLSearchParams(query)) {
    const option = name.toLowerCase()
    if (!PEER_VALIDATION_DISABLED.has(option)) continue
    if (value.toLowerCase() === 'true') relaxed.set(option, name)
    else relaxed.delete(option)
  }
  return [...relaxed.values()]
}

/**
 * Throws unless every host this URI names can carry its credentials safely.
 *
 * @param uri - A MongoDB connection string. Never included in a thrown message:
 *   the value it is checked for carrying is exactly what must not reach a log.
 * @param variableName - The environment variable the URI came from, so the
 *   refusal names what to fix.
 * @throws Error if the URI is unparseable, or carries credentials to a host it
 *   would reach over a connection that is unencrypted, or encrypted without
 *   verifying the peer.
 */
export function assertStoreCredentialsAreEncrypted(
  uri: string,
  variableName = 'SC_MONGODB_URI'
): void {
  const parsed = MONGO_URI.exec(uri.trim())
  if (!parsed)
    throw new Error(
      `${variableName} is not a MongoDB connection string, so its transport cannot be checked. A literal @, ? or # in the username or password has to be percent-encoded.`
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

  const exposed = hostList.split(',').filter((host) => !isLoopbackHost(host))
  if (exposed.length === 0) return

  if (!negotiatesTls(scheme, query))
    throw new Error(
      `${variableName} carries credentials to ${exposed.join(
        ', '
      )} over an unencrypted connection. This URI reaches a credentialed store, not a local one — add tls=true, or point it at the localhost port that \`lifi-connect prod smart-contracts\` forwards.`
    )

  const relaxed = relaxedTlsOptions(query)
  if (relaxed.length > 0)
    throw new Error(
      `${variableName} carries credentials to ${exposed.join(
        ', '
      )} over a TLS connection that does not verify the peer (${relaxed.join(
        ', '
      )}). An unverified peer can be impersonated, so the credentials are no better protected than in the clear — drop the option, or point it at the localhost port that \`lifi-connect prod smart-contracts\` forwards.`
    )
}
