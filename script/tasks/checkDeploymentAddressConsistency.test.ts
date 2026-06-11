import { execSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  affectedNetworks,
  changedWhitelistNetworks,
  findCoverageGaps,
  findMismatches,
  getChangedWhitelistNetworks,
  type INetworkSources,
} from './checkDeploymentAddressConsistency'

const base: INetworkSources = {
  network: 'testnet',
  whitelistPeriphery: {},
  deploymentFlat: {},
  diamondPeriphery: {},
  diamondFacets: {},
}

describe('findMismatches', () => {
  it('returns no mismatches when all sources agree (case-insensitive)', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { OutputValidator: '0xAAA' },
        deploymentFlat: { OutputValidator: '0xaaa', DiamondCutFacet: '0xF00' },
        diamondPeriphery: { OutputValidator: '0xAaA' },
        diamondFacets: { DiamondCutFacet: '0xf00' },
      },
    ]
    expect(findMismatches(sources)).toEqual([])
  })

  it('flags a periphery address that disagrees with the deployment log', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { OutputValidator: '0x293bef' },
        deploymentFlat: { OutputValidator: '0x1581ca9' },
        diamondPeriphery: { OutputValidator: '0x1581ca9' },
      },
    ]
    const result = findMismatches(sources)
    expect(result).toHaveLength(1)
    const mismatch = result[0]
    expect(mismatch).toMatchObject({
      network: 'testnet',
      kind: 'periphery',
      contract: 'OutputValidator',
    })
    expect(mismatch?.addresses).toHaveLength(3)
  })

  it('flags a facet address that disagrees between the two deployment files', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        deploymentFlat: { DexManagerFacet: '0xnew' },
        diamondFacets: { DexManagerFacet: '0xold' },
      },
    ]
    const result = findMismatches(sources)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'facet',
      contract: 'DexManagerFacet',
    })
  })

  it('ignores empty placeholders and contracts present in only one source', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { Patcher: '0xabc' },
        deploymentFlat: { Patcher: '0xabc' },
        diamondPeriphery: { Patcher: '' }, // not deployed -> ignored
        diamondFacets: { LonelyFacet: '0x999' }, // only one source -> ignored
      },
    ]
    expect(findMismatches(sources)).toEqual([])
  })
})

describe('affectedNetworks', () => {
  it('maps deployment and diamond paths to network names', () => {
    const result = affectedNetworks(
      ['deployments/arbitrum.json', 'deployments/base.diamond.json'],
      []
    )
    expect([...result].sort()).toEqual(['arbitrum', 'base'])
  })

  it('includes changed whitelist networks', () => {
    const result = affectedNetworks(['config/whitelist.json'], ['optimism'])
    expect([...result]).toEqual(['optimism'])
  })

  it('ignores non-deployment paths, the deployments log, and staging files', () => {
    const result = affectedNetworks(
      [
        'src/Foo.sol',
        'deployments/_deployments_log_file.json',
        'deployments/arbitrum.staging.json',
        'README.md',
      ],
      []
    )
    expect([...result]).toEqual([])
  })
})

describe('changedWhitelistNetworks', () => {
  it('detects an address change for a network', () => {
    const staged = { arbitrum: [{ name: 'Foo', address: '0xAAA' }] }
    const head = { arbitrum: [{ name: 'Foo', address: '0xBBB' }] }
    expect(changedWhitelistNetworks(staged, head)).toEqual(['arbitrum'])
  })

  it('ignores entry reordering, selector changes, and address case', () => {
    const staged = {
      arbitrum: [
        { name: 'Foo', address: '0xAAA', selectors: [{ selector: '0x1' }] },
        { name: 'Bar', address: '0xCCC' },
      ],
    }
    const head = {
      arbitrum: [
        { name: 'Bar', address: '0xccc' },
        { name: 'Foo', address: '0xaaa', selectors: [{ selector: '0x2' }] },
      ],
    }
    expect(changedWhitelistNetworks(staged, head)).toEqual([])
  })

  it('flags a network present in only one version', () => {
    expect(changedWhitelistNetworks({ base: [] }, {})).toEqual(['base'])
  })
})

describe('getChangedWhitelistNetworks (integration)', () => {
  const writeWhitelist = (dir: string, periphery: unknown) => {
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(
      join(dir, 'config', 'whitelist.json'),
      JSON.stringify({ PERIPHERY: periphery }, null, 2) + '\n'
    )
  }
  const git = (dir: string, cmd: string) =>
    execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8' })

  const setupRepo = (initial: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'addr-gate-'))
    try {
      git(dir, 'init -q')
      git(dir, 'config user.email test@example.com')
      git(dir, 'config user.name test')
      git(dir, 'config commit.gpgsign false')
      writeWhitelist(dir, initial)
      git(dir, 'add -A')
      git(dir, 'commit -q -m initial')
      return dir
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw err
    }
  }

  it('returns only the network whose address changed (not all networks)', () => {
    const dir = setupRepo({
      base: [{ name: 'FeeCollector', address: '0xAAA' }],
      arbitrum: [{ name: 'FeeCollector', address: '0xBBB' }],
    })
    try {
      writeWhitelist(dir, {
        base: [{ name: 'FeeCollector', address: '0xCCC' }], // changed
        arbitrum: [{ name: 'FeeCollector', address: '0xBBB' }], // unchanged
      })
      git(dir, 'add config/whitelist.json')
      expect(
        getChangedWhitelistNetworks(['config/whitelist.json'], dir)
      ).toEqual(['base'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns [] when a reformat changes no name/address', () => {
    const dir = setupRepo({
      base: [
        { name: 'FeeCollector', address: '0xAAA', selectors: [{ s: '0x1' }] },
      ],
    })
    try {
      // reorder keys + change selectors only + lowercase address
      writeWhitelist(dir, {
        base: [
          { address: '0xaaa', selectors: [{ s: '0x2' }], name: 'FeeCollector' },
        ],
      })
      git(dir, 'add config/whitelist.json')
      expect(
        getChangedWhitelistNetworks(['config/whitelist.json'], dir)
      ).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns [] when whitelist.json is not staged', () => {
    expect(getChangedWhitelistNetworks(['deployments/base.json'])).toEqual([])
  })
})

describe('findCoverageGaps', () => {
  const eligible = new Set(['OutputValidator', 'FeeCollector'])

  it('flags an eligible periphery in the diamond but missing from whitelist', () => {
    const gaps = findCoverageGaps(
      [
        {
          ...base,
          whitelistPeriphery: {},
          diamondPeriphery: { OutputValidator: '0xABC' },
        },
      ],
      eligible
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      network: 'testnet',
      contract: 'OutputValidator',
      address: '0xABC',
    })
  })

  it('does not flag when the eligible periphery is whitelisted', () => {
    const gaps = findCoverageGaps(
      [
        {
          ...base,
          whitelistPeriphery: { OutputValidator: '0xABC' },
          diamondPeriphery: { OutputValidator: '0xABC' },
        },
      ],
      eligible
    )
    expect(gaps).toEqual([])
  })

  it('does not flag peripheries that are not whitelist-eligible', () => {
    const gaps = findCoverageGaps(
      [
        {
          ...base,
          whitelistPeriphery: {},
          diamondPeriphery: { ERC20Proxy: '0xABC', ReceiverAcrossV3: '0xDEF' },
        },
      ],
      eligible
    )
    expect(gaps).toEqual([])
  })

  it('ignores eligible peripheries with an empty diamond address (not deployed)', () => {
    const gaps = findCoverageGaps(
      [
        {
          ...base,
          whitelistPeriphery: {},
          diamondPeriphery: { OutputValidator: '' },
        },
      ],
      eligible
    )
    expect(gaps).toEqual([])
  })
})
