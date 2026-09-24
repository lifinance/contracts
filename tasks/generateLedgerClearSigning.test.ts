/**
 * Tests for the parts of the ERC-7730 sync generator that decide what gets
 * published: which networks become deployments, which of those a lint of the
 * descriptor leaves out, and how the registry's `display.formats` are merged.
 * Network and proposal fixtures live in a temporary directory; lint output is
 * inlined in the `erc7730 lint --gha` format.
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
  excludeLintUnverified,
  mergeDisplayFormats,
  type IRepoDeployment,
} from './generateLedgerClearSigning'

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const FACET = '0x00000000000000000000000000000000000000a1'
const FILE = 'registry/lifi/calldata-LIFIDiamond.json'
const SKIPPED = 'display fields will not be validated against ABI'

const originalCwd = process.cwd()
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-clear-signing-'))
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
})

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data))
}

function deployment(network: string, chainId: number): IRepoDeployment {
  return { network, chainId, address: DIAMOND }
}

function lintError(title: string, message: string): string {
  return `::error file=${FILE},title=${title}::${message}`
}

function expectThrows(fn: () => unknown, match: string): void {
  let error: Error | undefined
  try {
    fn()
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toContain(match)
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

describe('excludeLintUnverified', () => {
  const DEPLOYMENTS = [
    deployment('mainnet', 1),
    deployment('optimism', 10),
    deployment('somnia', 50312),
    deployment('base', 8453),
  ]

  it('drops the deployments the lint reports as unverified or unsupported', () => {
    const lintOutput = [
      '➡️ checking registry/lifi/calldata-LIFIDiamond.json…',
      lintError(
        'Contract not verified',
        `contract ${DIAMOND} on chain 10 is not verified on Sourcify, ${SKIPPED}`
      ),
      lintError(
        'Chain not supported',
        `chain 50312 is not supported by Sourcify, ${SKIPPED}`
      ),
      lintError(
        'Proxy implementation not verified',
        `contract ${DIAMOND} on chain 8453 is a proxy, and its implementation ${FACET} is not verified on Sourcify, ${SKIPPED}`
      ),
      `::warning file=${FILE},title=Deployment ABIs differ::1:${DIAMOND}`,
      'checked 1 descriptor files, some errors found ❌',
    ].join('\n')

    expect(excludeLintUnverified(DEPLOYMENTS, lintOutput)).toEqual([
      { chainId: 1, address: DIAMOND },
    ])
  })

  it('fails on a lint error that Sourcify verification does not explain', () => {
    const lintOutput = [
      lintError(
        'Contract not verified',
        `contract ${DIAMOND} on chain 10 is not verified on Sourcify, ${SKIPPED}`
      ),
      lintError(
        'Could not fetch ABI',
        `Fetching reference ABI for chain id 8453 failed, ${SKIPPED}: Sourcify rate limit exceeded, please retry`
      ),
    ].join('\n')

    expectThrows(
      () => excludeLintUnverified(DEPLOYMENTS, lintOutput),
      'Could not fetch ABI: Fetching reference ABI for chain id 8453 failed'
    )
  })

  it('fails on an error with no title', () => {
    expectThrows(
      () => excludeLintUnverified(DEPLOYMENTS, `::error file=${FILE}::boom`),
      '(no title): boom'
    )
  })

  it('fails when the lint output has no errors', () => {
    expectThrows(
      () =>
        excludeLintUnverified(
          DEPLOYMENTS,
          'checked 1 descriptor files, no errors found ✅'
        ),
      'without any `::error` annotations'
    )
  })

  it('fails when the lint names a chain the descriptor does not have', () => {
    const lintOutput = lintError(
      'Contract not verified',
      `contract ${DIAMOND} on chain 137 is not verified on Sourcify, ${SKIPPED}`
    )

    expectThrows(
      () => excludeLintUnverified(DEPLOYMENTS, lintOutput),
      'for no deployment in this descriptor'
    )
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
