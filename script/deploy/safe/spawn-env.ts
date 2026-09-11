/**
 * The credential values handed to children spawned by the placement probes.
 *
 * Set rather than deleted: bun re-loads the repo `.env` inside the child for
 * every name the passed environment leaves unset, so deleting a credential
 * hands the real one back instead of withholding it.
 *
 * Malformed rather than merely wrong, so a child that reaches past the check
 * under test cannot act on the value: a key viem cannot parse throws where a
 * valid-but-unfunded one would derive an address, a URI the driver rejects on
 * construction throws where an unreachable host would first spend its 30 s
 * server-selection budget, and a scheme `fetch` refuses never reaches the
 * network where a real webhook would post to a live channel. The endpoint is
 * the weakest of the four: viem builds a transport from it without complaint
 * and only the first request fails, after its retries.
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
 * The names withheld whether or not the spawning process holds them.
 *
 * Every class below is swept out of the environment being passed, which cannot
 * reach a name the parent does not have — and the child re-loads the file for
 * exactly those names. The Safe signer key is unset in the store, so the sweep
 * never sees it and this list is its only cover.
 *
 * Names only: each still takes its value from the class that claims it, so
 * there is no second copy of the value here to disagree with that one.
 */
export const ALWAYS_WITHHELD: readonly string[] = [
  'PRIVATE_KEY',
  'PRIVATE_KEY_PRODUCTION',
  'SAFE_SIGNER_PRIVATE_KEY',
  'MONGODB_URI',
  'SC_MONGODB_URI',
]

/**
 * What counts as a credential, by the substring its name carries.
 *
 * Matched by substring rather than enumerated because every class comes in
 * open-ended families — the wallet keys by generation, the endpoints and
 * explorer keys one per network — so an enumeration stops covering the next
 * network on the day it is added.
 *
 * `spawn-env-credentials.test.ts` derives its source-scanning pattern from
 * these cores, so widening one widens the guard with it.
 *
 * Each core spans the whole credential-bearing part of the name, never the
 * vendor alone: `MONGODB_URI` rather than `MONGODB` leaves a logging toggle
 * alone, and `SYNC_TOKEN` rather than `TOKEN` leaves a token-contract list
 * alone.
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
 * Names a core matches that hold no secret, so replacing their value would
 * change what a child does rather than withhold anything from it.
 *
 * `NO_ETHERSCAN_API_KEY_REQUIRED` names a marker rather than holding a key:
 * `helperFunctions.sh` compares the name against this literal to allow an
 * empty key, and exports the value as the explorer key when it is set, so a
 * malformed value would be sent as a present one. The two anvil entries are
 * the publicly known local-node key and `127.0.0.1`.
 */
const NOT_A_CREDENTIAL: ReadonlySet<string> = new Set([
  'NO_ETHERSCAN_API_KEY_REQUIRED',
  'PRIVATE_KEY_ANVIL',
  'ETH_NODE_URI_LOCALANVIL',
])

/** The substrings that make a name a credential, for the guard to scan for. */
export const CREDENTIAL_CORES: readonly string[] = CREDENTIAL_CLASSES.flatMap(
  (credentialClass) => credentialClass.cores
)

/** The names both the guard and the sweep must treat as holding no credential. */
export const NON_CREDENTIAL_NAMES: readonly string[] = [...NOT_A_CREDENTIAL]

/**
 * Decides what a child may see in place of `name`.
 *
 * @param name - an environment variable name
 * @returns the malformed stand-in for the class that claims `name`, or
 * `undefined` when no class claims it or it is a reviewed non-credential
 */
export const withheldValueFor = (name: string): string | undefined => {
  if (NOT_A_CREDENTIAL.has(name)) return undefined

  return CREDENTIAL_CLASSES.find((credentialClass) =>
    credentialClass.cores.some((core) => name.includes(core))
  )?.value
}

/**
 * Replaces every credential in a child's environment with a malformed value.
 *
 * @param env - the environment about to be handed to a spawned child, mutated
 * in place. Names it does not hold cannot be swept, so a caller that built it
 * from something other than a `.env`-loaded parent is covered only by
 * {@link ALWAYS_WITHHELD}.
 */
export const withholdCredentials = (env: Record<string, string>): void => {
  for (const name of [...ALWAYS_WITHHELD, ...Object.keys(env)]) {
    const value = withheldValueFor(name)
    if (value !== undefined) env[name] = value
  }
}
