import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  type IAuditDependencies,
  type IAuditableRecord,
  auditRecords,
  parseNetworks,
} from './audit-recorded-constructor-args'

const ERC20_PROXY_ABI = [
  {
    type: 'constructor',
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_executorAddress', type: 'address' },
    ],
  },
]

const NO_ARG_ABI = [{ type: 'constructor', inputs: [] }]

const record = (
  overrides: Partial<IAuditableRecord> = {}
): IAuditableRecord => ({
  contractName: 'ERC20Proxy',
  network: 'tron',
  version: '1.0.0',
  address: 'TXYZ',
  timestamp: new Date('2025-01-01T00:00:00Z'),
  constructorArgs: '0x',
  ...overrides,
})

const deps = (
  abis: Record<string, unknown>,
  versions: Record<string, string> = {}
): IAuditDependencies => ({
  loadAbi: async (contractName) => {
    if (!(contractName in abis))
      throw new Error(`no artifact for ${contractName}`)
    return abis[contractName]
  },
  loadSourceVersion: async (contractName) => {
    const version = versions[contractName]
    if (version === undefined) throw new Error(`no version for ${contractName}`)
    return version
  },
})

describe('auditRecords', () => {
  it('flags a record claiming no arguments for a contract that takes two', async () => {
    const report = await auditRecords(
      [record()],
      deps({ ERC20Proxy: ERC20_PROXY_ABI }, { ERC20Proxy: '1.0.0' })
    )

    expect(report.consistent).toBe(0)
    expect(report.unauditable).toHaveLength(0)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.declaredTypes).toEqual(['address', 'address'])
    expect(report.findings[0]?.message).toContain('the record says it has none')
  })

  it('treats an absent constructorArgs field as claiming no arguments', async () => {
    const report = await auditRecords(
      [record({ constructorArgs: undefined })],
      deps({ ERC20Proxy: ERC20_PROXY_ABI }, { ERC20Proxy: '1.0.0' })
    )

    expect(report.findings).toHaveLength(1)
  })

  it('accepts a record whose arguments match the declared arity', async () => {
    const report = await auditRecords(
      [record({ constructorArgs: `0x${'11'.repeat(32)}${'22'.repeat(32)}` })],
      deps({ ERC20Proxy: ERC20_PROXY_ABI }, { ERC20Proxy: '1.0.0' })
    )

    expect(report.findings).toHaveLength(0)
    expect(report.consistent).toBe(1)
  })

  it('flags arguments recorded for a contract that takes none', async () => {
    const report = await auditRecords(
      [
        record({
          contractName: 'DiamondLoupeFacet',
          constructorArgs: `0x${'33'.repeat(32)}`,
        }),
      ],
      deps({ DiamondLoupeFacet: NO_ARG_ABI }, { DiamondLoupeFacet: '1.0.0' })
    )

    expect(report.findings[0]?.message).toContain(
      'takes no constructor arguments'
    )
  })

  it('marks a verdict as version-drift when the working tree moved on', async () => {
    const report = await auditRecords(
      [record({ version: '1.0.0' })],
      deps({ ERC20Proxy: ERC20_PROXY_ABI }, { ERC20Proxy: '1.1.0' })
    )

    expect(report.findings[0]?.provenance).toBe('version-drift')
    expect(report.findings[0]?.sourceVersion).toBe('1.1.0')
  })

  it('marks a verdict as unknown-source-version when the source cannot be read', async () => {
    const report = await auditRecords(
      [record()],
      deps({ ERC20Proxy: ERC20_PROXY_ABI })
    )

    expect(report.findings[0]?.provenance).toBe('unknown-source-version')
    expect(report.findings[0]?.sourceVersion).toBeNull()
  })

  it('reports a record with no artifact as unauditable rather than consistent', async () => {
    const report = await auditRecords([record()], deps({}))

    expect(report.consistent).toBe(0)
    expect(report.findings).toHaveLength(0)
    expect(report.unauditable).toHaveLength(1)
    expect(report.unauditable[0]?.reason).toContain('no compiled ABI')
  })

  it('reads each contract once however many records name it', async () => {
    let abiReads = 0
    const counting: IAuditDependencies = {
      loadAbi: async () => {
        abiReads++
        return ERC20_PROXY_ABI
      },
      loadSourceVersion: async () => '1.0.0',
    }

    await auditRecords(
      [
        record(),
        record({ network: 'tronshasta' }),
        record({ address: 'TABC' }),
      ],
      counting
    )

    expect(abiReads).toBe(1)
  })
})

describe('parseNetworks', () => {
  it('splits and trims a comma-separated list', () => {
    expect(parseNetworks(' tron , tronshasta ')).toEqual(['tron', 'tronshasta'])
  })

  it('rejects an empty list', () => {
    expect(() => parseNetworks(' , ')).toThrow('at least one network')
  })

  it('rejects a value that is not a network key', () => {
    expect(() => parseNetworks('tron,{"$ne":null}')).toThrow(
      'invalid network keys'
    )
  })
})
