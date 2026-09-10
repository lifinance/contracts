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
import type { Chain } from 'viem'

import networksConfig from '../../config/networks.json'
import { EnvironmentEnum } from '../common/types'

import { OUT_ROOT } from './utils'
import {
  buildExplorerContractPageUrl,
  getFallbackTransportForChain,
  getTransportConfigFromRpcUrl,
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

describe('getTransportConfigFromRpcUrl', () => {
  it('turns embedded https credentials into a basic auth header', () => {
    const config = getTransportConfigFromRpcUrl(
      'https://user:pass@rpc.example.invalid/'
    )
    expect(config.url).toBe('https://rpc.example.invalid/')
    expect(config.fetchOptions?.headers?.Authorization).toBe(
      `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`
    )
  })

  it('refuses to send credentials over cleartext http', () => {
    expect(() =>
      getTransportConfigFromRpcUrl('http://user:pass@rpc.example.invalid/')
    ).toThrow(/credentials over http/)
  })

  it('turns a password-only https url into a basic auth header', () => {
    const config = getTransportConfigFromRpcUrl(
      'https://:secret@rpc.example.invalid/'
    )
    expect(config.url).toBe('https://rpc.example.invalid/')
    expect(config.fetchOptions?.headers?.Authorization).toBe(
      `Basic ${Buffer.from(':secret', 'utf8').toString('base64')}`
    )
  })

  it('refuses a password-only url over cleartext http', () => {
    expect(() =>
      getTransportConfigFromRpcUrl('http://:secret@rpc.example.invalid/')
    ).toThrow(/credentials over http/)
  })

  it('leaves a credential-free http url alone', () => {
    expect(
      getTransportConfigFromRpcUrl('http://node.example.invalid:8545').url
    ).toBe('http://node.example.invalid:8545')
  })
})

describe('getFallbackTransportForChain', () => {
  const GOOD = 'https://good.example.invalid/rpc'
  const ALSO_GOOD = 'https://spare.example.invalid/rpc'
  const UNUSABLE = 'http://user:pass@bad.example.invalid/rpc'

  const chainWith = (http: string[]) =>
    ({
      name: 'TestChain',
      rpcUrls: { default: { http } },
    } as unknown as Chain)

  /**
   * The endpoint URLs a transport would actually call, in order.
   *
   * `fallback` hands back its children already built, while a lone `http` transport is still a
   * factory — so each node is only invoked when it is one.
   */
  const urlsOf = (node: unknown): string[] => {
    const built = (typeof node === 'function' ? node({}) : node) as {
      value?: { url?: string; transports?: unknown[] }
    }
    const nested = built?.value?.transports
    if (nested) return nested.flatMap((inner) => urlsOf(inner))
    return built?.value?.url ? [built.value.url] : []
  }

  it('drops an unusable fallback and keeps the healthy primary', () => {
    const urls = urlsOf(
      getFallbackTransportForChain(chainWith([GOOD, UNUSABLE]))
    )

    expect(urls).toEqual([GOOD])
  })

  it('drops an unusable primary and keeps the healthy fallbacks in order', () => {
    const urls = urlsOf(
      getFallbackTransportForChain(chainWith([UNUSABLE, GOOD, ALSO_GOOD]))
    )

    expect(urls).toEqual([GOOD, ALSO_GOOD])
  })

  it('throws only when every endpoint is unusable, naming the reason', () => {
    expect(() => getFallbackTransportForChain(chainWith([UNUSABLE]))).toThrow(
      /No usable RPC URL for chain TestChain.*credentials over http/
    )
  })

  it('still reports a chain with no endpoints as unconfigured', () => {
    expect(() => getFallbackTransportForChain(chainWith([]))).toThrow(
      /No RPC URL configured for chain TestChain/
    )
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
