/**
 * Unit tests for `viemScriptHelpers` exports that do not require RPC mocks.
 *
 * `isTestnetNetwork` reads the imported `config/networks.json` directly and
 * `getDeployLogFile` reads real `deployments/*.json` files, so the assertions
 * below pin behavior against real entries in those files.
 * If the network list changes, update the fixtures used here accordingly.
 */
import { tmpdir } from 'os'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import networksConfig from '../../config/networks.json'
import { EnvironmentEnum } from '../common/types'

import { OUT_ROOT } from './utils'
import {
  buildExplorerContractPageUrl,
  getDeployLogFile,
  getFunctionSelectors,
  isTestnetNetwork,
} from './viemScriptHelpers'

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

describe('buildExplorerContractPageUrl', () => {
  const ADDR = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'

  it('uses ?tab=contract on Blockscout v2 explorers', () => {
    expect(buildExplorerContractPageUrl('scroll', ADDR)).toBe(
      `https://scrollscan.com/address/${ADDR}?tab=contract`
    )
    expect(buildExplorerContractPageUrl('ronin', ADDR)).toBe(
      `https://explorer.roninchain.com/address/${ADDR}?tab=contract`
    )
    expect(buildExplorerContractPageUrl('vana', ADDR)).toBe(
      `https://vanascan.io/address/${ADDR}?tab=contract`
    )
  })

  it('keeps #code on older Blockscout explorers', () => {
    expect(buildExplorerContractPageUrl('lisk', ADDR)).toBe(
      `https://blockscout.lisk.com/address/${ADDR}#code`
    )
  })
})

describe('getDeployLogFile path guard', () => {
  it('throws on a network name with parent-directory traversal', () => {
    expect(() =>
      getDeployLogFile('../../evil', EnvironmentEnum.production)
    ).toThrow(/Invalid network name/)
  })

  it('throws on a network name escaping deployments/ into the repo root', () => {
    expect(() =>
      getDeployLogFile('../foundry', EnvironmentEnum.production)
    ).toThrow(/Invalid network name/)
  })

  it('throws the not-found error, not the guard error, for an unknown network', () => {
    expect(() =>
      getDeployLogFile(
        'this-network-does-not-exist',
        EnvironmentEnum.production
      )
    ).toThrow(/Deploy log not found/)
  })

  it('reads a real production deploy log', () => {
    const log = getDeployLogFile('mainnet', EnvironmentEnum.production)
    expect(log.LiFiDiamond).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('getFunctionSelectors', () => {
  it('looks the artifact up in the repo, not under the caller cwd', () => {
    const originalCwd = process.cwd()
    let message = ''
    try {
      process.chdir(tmpdir())
      getFunctionSelectors('ThisContractDoesNotExist')
    } catch (error) {
      message = (error as Error).message
    } finally {
      process.chdir(originalCwd)
    }
    expect(message).toContain(OUT_ROOT)
    expect(message).not.toContain(tmpdir())
  })
})
