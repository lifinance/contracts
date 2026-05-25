/**
 * Unit tests for `viemScriptHelpers` exports that are pure-function and
 * do not require RPC or filesystem mocks.
 *
 * `isTestnetNetwork` reads the imported `config/networks.json` directly,
 * so the assertions below pin behavior against real entries in that file.
 * If the network list changes, update the fixtures used here accordingly.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import networksConfig from '../../config/networks.json'

import { isTestnetNetwork } from './viemScriptHelpers'

describe('isTestnetNetwork', () => {
  it('returns true for a network with type "testnet"', () => {
    const testnetEntry = Object.entries(networksConfig).find(
      ([, network]) => (network as { type?: string }).type === 'testnet'
    )
    if (!testnetEntry)
      throw new Error(
        'No testnet network found in networks.json — update fixture'
      )
    const [networkName] = testnetEntry
    expect(isTestnetNetwork(networkName)).toBe(true)
  })

  it('returns false for a network with type "mainnet"', () => {
    const mainnetEntry = Object.entries(networksConfig).find(
      ([, network]) => (network as { type?: string }).type === 'mainnet'
    )
    if (!mainnetEntry)
      throw new Error(
        'No mainnet network found in networks.json — update fixture'
      )
    const [networkName] = mainnetEntry
    expect(isTestnetNetwork(networkName)).toBe(false)
  })

  it('returns false for an unknown network name', () => {
    expect(isTestnetNetwork('this-network-does-not-exist')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isTestnetNetwork('')).toBe(false)
  })
})
