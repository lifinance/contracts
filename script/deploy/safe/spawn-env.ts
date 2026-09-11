/**
 * The credential values handed to children spawned by the placement probes.
 *
 * Set rather than deleted: bun re-loads the repo `.env` inside the child for
 * every name the passed environment leaves unset, so deleting a credential
 * hands the real one back instead of withholding it.
 *
 * Malformed rather than merely wrong, so a child that reaches past the check
 * under test dies before it can act: a key viem cannot parse throws where a
 * valid-but-unfunded one would derive an address, a URI the driver rejects on
 * construction throws where an unreachable host would first spend its 30 s
 * server-selection budget, and a webhook URL `fetch` refuses never leaves the
 * machine where a real one would post to a live channel.
 *
 * The store URIs matter as much as the keys, because a key is not always the
 * first credential a run reaches: `execute-pending-timelock-tx.ts` opens the
 * timelock queue in its fleet prefetch before it reads any key.
 */
const MALFORMED_KEY = 'malformed-in-tests'
const MALFORMED_STORE = 'malformed-in-tests://no-store'
const MALFORMED_ENDPOINT = 'malformed-in-tests://no-endpoint'
const MALFORMED_WEBHOOK = 'malformed-in-tests://no-webhook'

/**
 * The names withheld whether or not the spawning process happens to hold them.
 *
 * Every other class below is swept out of the environment actually being
 * passed, which cannot cover a name the parent does not have — and a child
 * re-loads the repo `.env` for exactly those names. These five buy a signature
 * or the proposal store rather than a provider quota, so they are pinned by
 * name and do not depend on the parent having been started with a `.env`.
 */
const ALWAYS_WITHHELD: readonly (readonly [string, string])[] = [
  ['PRIVATE_KEY', MALFORMED_KEY],
  ['PRIVATE_KEY_PRODUCTION', MALFORMED_KEY],
  ['SAFE_SIGNER_PRIVATE_KEY', MALFORMED_KEY],
  ['MONGODB_URI', MALFORMED_STORE],
  ['SC_MONGODB_URI', MALFORMED_STORE],
]

/**
 * What counts as a credential, by the substring its name carries.
 *
 * Matched by substring rather than enumerated because every class comes in
 * open-ended families: the wallet keys come in generations (pauser, refund and
 * withdraw sit alongside several retired deployer ones), the endpoints come one
 * per network, and the explorer keys one per chain — 225 names in the store
 * today, of which 87 are `ETH_NODE_URI_*`. An enumeration would silently stop
 * covering the next network added, on the day it was added.
 *
 * `spawn-env-credentials.test.ts` derives its source-scanning pattern from
 * these same cores, so widening one widens the guard with it. That is the point
 * of the table: a guard that no longer matches what this function withholds
 * reports a clean tree while the fix has stopped covering it.
 *
 * The cores are anchored on the full credential-bearing suffix, never on the
 * vendor alone, so a name that merely shares a prefix is not swept up:
 * `MONGODB_URI` rather than `MONGODB` keeps `ENABLE_MONGODB_LOGGING` out, and
 * `SYNC_TOKEN` rather than `TOKEN` keeps `ALLOW_TOKEN_CONTRACTS` out.
 */
const CREDENTIAL_CLASSES: readonly {
  readonly cores: readonly string[]
  readonly value: string
}[] = [
  { cores: ['PRIVATE_KEY', 'MNEMONIC'], value: MALFORMED_KEY },
  { cores: ['MONGODB_URI'], value: MALFORMED_STORE },
  { cores: ['ETH_NODE_URI'], value: MALFORMED_ENDPOINT },
  { cores: ['API_KEY', 'ACCESS_KEY', 'SYNC_TOKEN'], value: MALFORMED_KEY },
  { cores: ['WEBHOOK'], value: MALFORMED_WEBHOOK },
]

/**
 * Names a class core matches that hold no credential.
 *
 * `NO_ETHERSCAN_API_KEY_REQUIRED` is the name of a marker, not a key: the
 * verification helper compares the *name* against this literal to decide that
 * an empty key is legitimate (`script/helperFunctions.sh`). Giving it a
 * malformed value would make it look like a key that is present, which is a
 * behaviour change rather than a withholding.
 */
const NOT_A_CREDENTIAL: ReadonlySet<string> = new Set([
  'NO_ETHERSCAN_API_KEY_REQUIRED',
])

/** The substrings that make a name a credential, for the guard to scan for. */
export const CREDENTIAL_CORES: readonly string[] = CREDENTIAL_CLASSES.flatMap(
  (credentialClass) => credentialClass.cores
)

/** The names the guard must treat as clean even though a core matches them. */
export const NON_CREDENTIAL_NAMES: readonly string[] = [...NOT_A_CREDENTIAL]

/** The class value for `name`, or `undefined` if no class claims it. */
export const withheldValueFor = (name: string): string | undefined => {
  if (NOT_A_CREDENTIAL.has(name)) return undefined

  return CREDENTIAL_CLASSES.find((credentialClass) =>
    credentialClass.cores.some((core) => name.includes(core))
  )?.value
}

export const withholdCredentials = (env: Record<string, string>): void => {
  for (const [name, value] of ALWAYS_WITHHELD) env[name] = value

  for (const name of Object.keys(env)) {
    const value = withheldValueFor(name)
    if (value !== undefined) env[name] = value
  }
}
