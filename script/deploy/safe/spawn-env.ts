/**
 * The credential values handed to children spawned by the placement probes.
 *
 * Set rather than deleted: bun re-loads the repo `.env` inside the child for
 * every name the passed environment leaves unset, so deleting a credential
 * hands the real one back instead of withholding it.
 *
 * Malformed rather than merely wrong, so a child that reaches past the check
 * under test dies before it can act: a key viem cannot parse throws where a
 * valid-but-unfunded one would derive an address, and a URI the driver rejects
 * on construction throws where an unreachable host would first spend its 30 s
 * server-selection budget.
 *
 * The store URIs matter as much as the keys, because a key is not always the
 * first credential a run reaches: `execute-pending-timelock-tx.ts` opens the
 * timelock queue in its fleet prefetch before it reads any key.
 */
const MALFORMED_KEY = 'malformed-in-tests'
const MALFORMED_STORE = 'malformed-in-tests://no-store'

const SIGNING_KEYS = [
  'PRIVATE_KEY',
  'PRIVATE_KEY_PRODUCTION',
  'SAFE_SIGNER_PRIVATE_KEY',
] as const

const PROPOSAL_STORES = ['MONGODB_URI', 'SC_MONGODB_URI'] as const

export const withholdCredentials = (env: Record<string, string>): void => {
  for (const name of SIGNING_KEYS) env[name] = MALFORMED_KEY
  for (const name of PROPOSAL_STORES) env[name] = MALFORMED_STORE
}
