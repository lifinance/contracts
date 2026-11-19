/**
 * Runtime codehashes `main` pins for contracts this repo does not build, such as
 * a periphery registration's target built in another repository.
 *
 * Pure: the sign-time gate's dependency assembly owns the read at `origin/main`
 * and hands the parsed lookup to the codehash gate.
 */
import { getAddress, isAddress } from 'viem'

import type { IPinnedCodehash } from './verify-cut-targets'

export const PINNED_CODEHASHES_REPO_PATH =
  'script/deploy/resources/pinnedExternalCodehashes.json'

const CODEHASH_PATTERN = /^0x[0-9a-f]{64}$/

/** Keyed by `pinnedKey`, so case cannot split one address into two entries. */
export type PinnedCodehashes = ReadonlyMap<string, IPinnedCodehash>

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * @param network - the network key, any case
 * @param address - the address, any case
 * @returns The lookup key for one pinned deployment
 */
export const pinnedKey = (network: string, address: string): string =>
  `${network.toLowerCase()}:${address.toLowerCase()}`

/**
 * Validates the pinned-codehash file and indexes it by network and address.
 *
 * Shape: contract name → `{ source, deployments: { <network>: { address,
 * codehash } } }`. Anything else throws, because a malformed entry read as
 * "nothing pinned" would hide the mistake behind an ordinary refusal.
 *
 * @param raw - the file's parsed JSON
 * @returns Every pinned deployment, keyed by `pinnedKey`
 * @throws When the file is malformed, or pins one address twice
 */
export const parsePinnedCodehashes = (
  raw: Record<string, unknown>
): PinnedCodehashes => {
  const pinned = new Map<string, IPinnedCodehash>()
  for (const [contractName, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.deployments))
      throw new Error(`${contractName} must be an object with deployments`)
    if (typeof entry.source !== 'string' || entry.source.trim() === '')
      throw new Error(`${contractName} must name the source it was built from`)

    for (const [network, deployment] of Object.entries(entry.deployments)) {
      const where = `${contractName}.deployments.${network}`
      if (!isPlainObject(deployment))
        throw new Error(`${where} must be an object`)
      const { address, codehash } = deployment
      if (typeof address !== 'string' || !isAddress(address, { strict: true }))
        throw new Error(`${where}.address is not a valid address`)
      if (typeof codehash !== 'string' || !CODEHASH_PATTERN.test(codehash))
        throw new Error(`${where}.codehash is not a lowercase 32-byte hash`)

      const key = pinnedKey(network, address)
      if (pinned.has(key))
        throw new Error(`${network} ${getAddress(address)} is pinned twice`)
      pinned.set(key, { codehash, label: `${contractName} on ${network}` })
    }
  }
  return pinned
}
