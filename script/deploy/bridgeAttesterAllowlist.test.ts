/**
 * Config guard: the attester `AttestedBridgeFacet` reports to must never be allowlisted.
 *
 * The attester trusts any call from the diamond, and the allowlist is how a swap step makes the
 * diamond call an arbitrary contract. These tests fail CI when config would allowlist it, before
 * any sync script can push it on chain; the `bridge-attester-not-allowlisted` health-check
 * invariant covers what reaches the chain anyway.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'

import globalConfig from '../../config/global.json'
import whitelistConfig from '../../config/whitelist.json'

const BRIDGE_ATTESTER = 'BridgeAttester'
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

interface IAllowlistedAddress {
  network: string
  address: string
}

/** Every address a whitelist config allowlists, per network, from both sections. */
function allowlistedAddresses(whitelist: unknown): IAllowlistedAddress[] {
  const found: IAllowlistedAddress[] = []
  const config = whitelist as {
    DEXS?: Array<{ contracts?: Record<string, Array<{ address?: string }>> }>
    PERIPHERY?: Record<string, Array<{ address?: string }>>
  }
  for (const dex of config.DEXS ?? [])
    for (const [network, entries] of Object.entries(dex.contracts ?? {}))
      for (const entry of entries)
        if (entry.address) found.push({ network, address: entry.address })
  for (const [network, entries] of Object.entries(config.PERIPHERY ?? {}))
    for (const entry of entries)
      if (entry.address) found.push({ network, address: entry.address })
  return found
}

/** The allowlist entries whose address is the attester the network's deploy log records. */
function allowlistedAttesters(
  whitelist: unknown,
  attesterByNetwork: Record<string, string>
): IAllowlistedAddress[] {
  return allowlistedAddresses(whitelist).filter(
    ({ network, address }) =>
      attesterByNetwork[network]?.toLowerCase() === address.toLowerCase()
  )
}

/**
 * `BridgeAttester` from every production flat deploy log, keyed by network. Staging logs are
 * skipped: their allowlist, `config/whitelist.staging.json`, is gitignored and not in CI.
 */
function loggedAttesters(): Record<string, string> {
  const dir = path.join(REPO_ROOT, 'deployments')
  const attesters: Record<string, string> = {}
  for (const file of readdirSync(dir)) {
    const match = /^([a-z0-9_-]+)\.json$/.exec(file)
    if (!match?.[1]) continue
    const log = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as
      | Record<string, unknown>
      | undefined
    const attester = log?.[BRIDGE_ATTESTER]
    if (typeof attester === 'string') attesters[match[1]] = attester
  }
  return attesters
}

describe('BridgeAttester is never allowlisted', () => {
  it('is not a diamond-called periphery contract', () => {
    expect(Object.keys(globalConfig.whitelistPeripheryFunctions)).not.toContain(
      BRIDGE_ATTESTER
    )
  })

  it('has no production address in config/whitelist.json', () => {
    expect(allowlistedAttesters(whitelistConfig, loggedAttesters())).toEqual([])
  })

  it('finds a logged attester in either whitelist section, on its own network only', () => {
    const attester = '0xA77E57E200000000000000000000000000000001'
    const whitelist = {
      DEXS: [
        {
          contracts: {
            arbitrum: [{ address: attester.toLowerCase() }],
            base: [{ address: attester }],
          },
        },
      ],
      PERIPHERY: { arbitrum: [{ address: attester }] },
    }
    expect(allowlistedAttesters(whitelist, { arbitrum: attester })).toEqual([
      { network: 'arbitrum', address: attester.toLowerCase() },
      { network: 'arbitrum', address: attester },
    ])
  })
})
