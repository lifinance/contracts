/**
 * Config guard: the attester `AttestedBridgeFacet` reports to must never be allowlisted.
 *
 * The attester trusts any call from the diamond, and the allowlist is how a swap step makes the
 * diamond call an arbitrary contract. These tests fail CI when config would allowlist it, before
 * any sync script can push it on chain; the `bridge-attester-not-allowlisted` health-check
 * invariant covers what reaches the chain anyway.
 *
 * The attester (`BridgeCommitmentLedger`) is deployed outside this repo, so its reviewed address
 * per network comes from the pinned-codehash file, which `bridge-attester-pinned` holds the
 * on-chain registry to.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import path from 'path'

import globalConfig from '../../config/global.json'
import whitelistConfig from '../../config/whitelist.json'

import {
  PINNED_CODEHASHES_REPO_PATH,
  pinnedAddressesByNetwork,
} from './codehash/pinned-codehashes'

const BRIDGE_ATTESTER = 'BridgeAttester'
const BRIDGE_COMMITMENT_LEDGER = 'BridgeCommitmentLedger'
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

/** The allowlist entries whose address is the attester pinned for the entry's network. */
function allowlistedAttesters(
  whitelist: unknown,
  attesterByNetwork: ReadonlyMap<string, string>
): IAllowlistedAddress[] {
  return allowlistedAddresses(whitelist).filter(
    ({ network, address }) =>
      attesterByNetwork.get(network.toLowerCase())?.toLowerCase() ===
      address.toLowerCase()
  )
}

/** The pinned `BridgeCommitmentLedger` address per network. */
function pinnedAttesters(): ReadonlyMap<string, string> {
  const raw = JSON.parse(
    readFileSync(path.join(REPO_ROOT, PINNED_CODEHASHES_REPO_PATH), 'utf8')
  ) as Record<string, unknown>
  return pinnedAddressesByNetwork(raw, BRIDGE_COMMITMENT_LEDGER)
}

describe('BridgeAttester is never allowlisted', () => {
  it('is not a diamond-called periphery contract', () => {
    expect(Object.keys(globalConfig.whitelistPeripheryFunctions)).not.toContain(
      BRIDGE_ATTESTER
    )
  })

  it('has pinned attesters to compare against', () => {
    expect(pinnedAttesters().size).toBeGreaterThan(0)
  })

  it('has no pinned attester address in config/whitelist.json', () => {
    expect(allowlistedAttesters(whitelistConfig, pinnedAttesters())).toEqual([])
  })

  it('finds a pinned attester in either whitelist section, on its own network only', () => {
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
    expect(
      allowlistedAttesters(whitelist, new Map([['arbitrum', attester]]))
    ).toEqual([
      { network: 'arbitrum', address: attester.toLowerCase() },
      { network: 'arbitrum', address: attester },
    ])
  })
})
