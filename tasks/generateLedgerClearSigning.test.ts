/**
 * Tests for the parts of the ERC-7730 sync generator that decide what gets
 * published: which networks become deployments, which of those Sourcify
 * verification keeps, and how the registry's `display.formats` are merged.
 * Sourcify is stubbed at `fetch`; network and proposal fixtures live in a
 * temporary directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  buildDeploymentsFromRepo,
  keepSourcifyVerified,
  mergeDisplayFormats,
  type IRepoDeployment,
} from './generateLedgerClearSigning'

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const FACET = '0x00000000000000000000000000000000000000a1'

const originalFetch = globalThis.fetch
const originalCwd = process.cwd()
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-clear-signing-'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
})

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data))
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const plain = (): Response =>
  json(200, { proxyResolution: { isProxy: false, implementations: [] } })

/** Serves Sourcify lookups by `${chainId}/${address}`. */
function stubSourcify(routes: Record<string, () => Response>): void {
  globalThis.fetch = ((url: string) => {
    const [chainId, address] = new URL(url).pathname.split('/').slice(-2)
    const route = routes[`${chainId}/${address}`]
    if (!route) throw new Error(`unexpected request: ${url}`)
    return Promise.resolve(route())
  }) as unknown as typeof globalThis.fetch
}

function deployment(network: string, chainId: number): IRepoDeployment {
  return { network, chainId, address: DIAMOND }
}

describe('buildDeploymentsFromRepo', () => {
  function build(
    networks: Record<string, unknown>,
    logs: Record<string, unknown>
  ): IRepoDeployment[] {
    const deploymentsDir = join(dir, 'deployments')
    mkdirSync(deploymentsDir)
    for (const [network, log] of Object.entries(logs))
      writeJson(join(deploymentsDir, `${network}.json`), log)
    const networksPath = join(dir, 'networks.json')
    writeJson(networksPath, networks)
    return buildDeploymentsFromRepo(deploymentsDir, networksPath)
  }

  it('keeps only active non-zkEVM mainnets with a diamond address', () => {
    const result = build(
      {
        mainnet: { chainId: 1, status: 'active', type: 'mainnet' },
        arbitrum: { chainId: 42161, type: 'mainnet' },
        sepolia: { chainId: 11155111, status: 'active', type: 'testnet' },
        zksync: { chainId: 324, status: 'active', isZkEVM: true },
        fantom: { chainId: 250, status: 'inactive' },
        nodiamond: { chainId: 5, status: 'active' },
        badaddress: { chainId: 6, status: 'active' },
      },
      {
        mainnet: { LiFiDiamond: DIAMOND },
        arbitrum: { LiFiDiamond: DIAMOND },
        sepolia: { LiFiDiamond: DIAMOND },
        zksync: { LiFiDiamond: DIAMOND },
        fantom: { LiFiDiamond: DIAMOND },
        nodiamond: { SomeFacet: FACET },
        badaddress: { LiFiDiamond: '0x1234' },
        unknownnetwork: { LiFiDiamond: DIAMOND },
      }
    )

    expect(result).toEqual([
      deployment('mainnet', 1),
      deployment('arbitrum', 42161),
    ])
  })

  it('ignores files that are not JSON deployment logs', () => {
    const deploymentsDir = join(dir, 'deployments')
    mkdirSync(deploymentsDir)
    writeFileSync(join(deploymentsDir, 'README.md'), '# not a log')
    const networksPath = join(dir, 'networks.json')
    writeJson(networksPath, { README: { chainId: 1 } })

    expect(buildDeploymentsFromRepo(deploymentsDir, networksPath)).toEqual([])
  })
})

describe('keepSourcifyVerified', () => {
  it('keeps verified deployments and drops unverified or unsupported ones', async () => {
    stubSourcify({
      [`1/${DIAMOND}`]: () =>
        json(200, {
          proxyResolution: {
            isProxy: true,
            implementations: [{ address: FACET, name: 'DiamondCutFacet' }],
            proxyResolutionError: null,
          },
        }),
      [`1/${FACET}`]: plain,
      [`10/${DIAMOND}`]: () => json(404, { customCode: 'not_found' }),
      [`50312/${DIAMOND}`]: () =>
        json(400, { customCode: 'unsupported_chain', message: 'nope' }),
      [`8453/${DIAMOND}`]: () =>
        json(200, {
          proxyResolution: {
            isProxy: true,
            implementations: [{ address: FACET, name: 'DiamondCutFacet' }],
            proxyResolutionError: null,
          },
        }),
      [`8453/${FACET}`]: () => json(404, { customCode: 'not_found' }),
    })

    const result = await keepSourcifyVerified([
      deployment('mainnet', 1),
      deployment('optimism', 10),
      deployment('somnia', 50312),
      deployment('base', 8453),
    ])

    expect(result).toEqual([{ chainId: 1, address: DIAMOND }])
  })

  it('fails the run instead of returning a partial list', async () => {
    stubSourcify({
      [`1/${DIAMOND}`]: plain,
      [`10/${DIAMOND}`]: () =>
        json(200, {
          proxyResolution: {
            isProxy: false,
            implementations: [],
            proxyResolutionError: { message: 'rpc unavailable' },
          },
        }),
    })

    let error: Error | undefined
    try {
      await keepSourcifyVerified([
        deployment('mainnet', 1),
        deployment('optimism', 10),
      ])
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).toContain('could not resolve whether')
  })
})

describe('mergeDisplayFormats', () => {
  const RETIRED =
    'swapTokensGeneric(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])'
  const OWNED =
    'startBridgeTokensViaAcross((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))'
  const UNOWNED = 'transfer(address,uint256)'
  const PACKED = 'startBridgeTokensViaAcrossPacked()'

  function withProposal(formats: Record<string, unknown>): string {
    process.chdir(dir)
    writeJson(join(dir, 'proposal.json'), { formats })
    return 'proposal.json'
  }

  it('replaces owned entries, preserves unowned ones and other display keys', () => {
    const proposal = withProposal({ [OWNED]: { intent: 'new' } })

    const result = mergeDisplayFormats(
      {
        definitions: { amount: {} },
        formats: { [OWNED]: { intent: 'old' }, [UNOWNED]: { intent: 'ef' } },
      },
      proposal
    )

    expect(result).toEqual({
      definitions: { amount: {} },
      formats: { [OWNED]: { intent: 'new' }, [UNOWNED]: { intent: 'ef' } },
    })
  })

  it('drops retired LI.FI entries even when no proposal is merged', () => {
    const result = mergeDisplayFormats(
      {
        formats: { [RETIRED]: { intent: 'swap' }, [UNOWNED]: { intent: 'ef' } },
      },
      null
    )

    expect(result.formats).toEqual({ [UNOWNED]: { intent: 'ef' } })
  })

  it('keeps a retired entry the proposal still carries', () => {
    const proposal = withProposal({ [RETIRED]: { intent: 'proposed' } })

    const result = mergeDisplayFormats(
      { formats: { [RETIRED]: { intent: 'old' } } },
      proposal
    )

    expect(result.formats).toEqual({ [RETIRED]: { intent: 'proposed' } })
  })

  it('drops only title-only Packed/Min entries with an explicitly empty fields', () => {
    const result = mergeDisplayFormats(
      {
        formats: {
          [PACKED]: { intent: 'bridge', fields: [] },
          'startBridgeTokensViaAcrossMin(bytes32)': { intent: 'bridge' },
          [UNOWNED]: { intent: 'ef', fields: [] },
        },
      },
      null
    )

    expect(Object.keys(result.formats ?? {})).toEqual([
      'startBridgeTokensViaAcrossMin(bytes32)',
      UNOWNED,
    ])
  })

  it('refuses a proposal path outside the working directory', () => {
    process.chdir(dir)

    expect(() =>
      mergeDisplayFormats({ formats: {} }, '../outside.json')
    ).toThrow('Path escapes the working directory')
  })
})
