import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  type IAuditDependencies,
  type IAuditReport,
  type IAuditableRecord,
  auditRecords,
  formatRecord,
  parseEnvironments,
  parseNetworks,
  provenanceOf,
  renderReport,
  shouldFail,
} from './audit-recorded-constructor-args'

/**
 * Shaped like a real Forge artifact ABI: a mixed entry list, and every input
 * carrying `internalType` alongside `type`.
 */
const ERC20_PROXY_ABI = [
  { type: 'error', name: 'InvalidConfig', inputs: [] },
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owner', internalType: 'address', type: 'address' },
      { name: '_executorAddress', internalType: 'address', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
]

const NO_ARG_ABI = [
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [] },
]

const MALFORMED_ABI = [{ type: 'constructor', inputs: [{ name: 'x' }] }]

const word = (byte: string): string => byte.repeat(32)

const record = (
  overrides: Partial<IAuditableRecord> = {}
): IAuditableRecord => ({
  contractName: 'ERC20Proxy',
  network: 'tron',
  version: '1.0.0',
  address: 'TUYvdo8bEjPidfSXhRMn9uRvSifesApPTC',
  timestamp: new Date('2025-01-01T00:00:00Z'),
  constructorArgs: '0x',
  gitCommitHash: undefined,
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

const erc20ProxyAt = (sourceVersion: string): IAuditDependencies =>
  deps({ ERC20Proxy: ERC20_PROXY_ABI }, { ERC20Proxy: sourceVersion })

const emptyReport = (overrides: Partial<IAuditReport> = {}): IAuditReport => ({
  examined: 0,
  consistent: 0,
  findings: [],
  unverified: [],
  unauditable: [],
  ...overrides,
})

describe('auditRecords - conclusive verdicts', () => {
  it('flags a record claiming no arguments for a contract that takes two', async () => {
    const report = await auditRecords([record()], erc20ProxyAt('1.0.0'))

    expect(report.unverified).toHaveLength(0)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.declaredTypes).toEqual(['address', 'address'])
    expect(report.findings[0]?.message).toContain('the record says it has none')
  })

  it('flags a record holding fewer words than the constructor takes', async () => {
    const report = await auditRecords(
      [record({ constructorArgs: `0x${word('11')}` })],
      erc20ProxyAt('1.0.0')
    )

    expect(report.findings[0]?.message).toContain('only 1 words')
  })

  it('flags arguments that are not hex', async () => {
    const report = await auditRecords(
      [record({ constructorArgs: 'null' })],
      erc20ProxyAt('1.0.0')
    )

    expect(report.findings[0]?.message).toContain('are not hex')
  })

  it('flags arguments recorded for a contract that takes none', async () => {
    const report = await auditRecords(
      [
        record({
          contractName: 'DiamondLoupeFacet',
          constructorArgs: `0x${word('33')}`,
        }),
      ],
      deps({ DiamondLoupeFacet: NO_ARG_ABI }, { DiamondLoupeFacet: '1.0.0' })
    )

    expect(report.findings[0]?.message).toContain(
      'takes no constructor arguments'
    )
  })

  it('treats an absent constructorArgs field as claiming no arguments', async () => {
    const report = await auditRecords(
      [record({ constructorArgs: undefined })],
      erc20ProxyAt('1.0.0')
    )

    expect(report.findings).toHaveLength(1)
  })

  it('accepts a record whose arguments match the declared arity', async () => {
    const report = await auditRecords(
      [record({ constructorArgs: `0x${word('11')}${word('22')}` })],
      erc20ProxyAt('1.0.0')
    )

    expect(report.findings).toHaveLength(0)
    expect(report.consistent).toBe(1)
  })
})

describe('auditRecords - records it refuses to judge', () => {
  it('never states an arity for a version the working tree does not hold', async () => {
    const report = await auditRecords(
      [record({ version: '1.1.0', constructorArgs: `0x${word('11')}` })],
      erc20ProxyAt('2.0.0')
    )

    expect(report.findings).toHaveLength(0)
    expect(report.consistent).toBe(0)
    expect(report.unverified).toHaveLength(1)
    expect(report.unverified[0]?.provenance).toBe('version-drift')
    expect(report.unverified[0]?.sourceVersion).toBe('2.0.0')
    expect(report.unverified[0]?.workingTreeWouldSay).toContain('only 1 words')
  })

  it('keeps a drifted record that passes out of the consistent count', async () => {
    const report = await auditRecords(
      [
        record({
          version: '1.1.0',
          constructorArgs: `0x${word('11')}${word('22')}`,
        }),
      ],
      erc20ProxyAt('2.0.0')
    )

    expect(report.consistent).toBe(0)
    expect(report.unverified[0]?.workingTreeWouldSay).toBeNull()
  })

  it('treats a -tron overlay version as built from source this repo lacks', async () => {
    const report = await auditRecords(
      [record({ version: '1.0.0-tron' })],
      erc20ProxyAt('1.0.0')
    )

    expect(report.findings).toHaveLength(0)
    expect(report.unverified[0]?.provenance).toBe('fork-overlay')
  })

  it('does not judge a record when the working tree version cannot be read', async () => {
    const report = await auditRecords(
      [record()],
      deps({ ERC20Proxy: ERC20_PROXY_ABI })
    )

    expect(report.findings).toHaveLength(0)
    expect(report.unverified[0]?.provenance).toBe('unknown-source-version')
    expect(report.unverified[0]?.sourceVersion).toBeNull()
  })
})

describe('auditRecords - records it cannot resolve an ABI for', () => {
  it('reports a record with no artifact as unauditable rather than consistent', async () => {
    const report = await auditRecords([record()], deps({}))

    expect(report.consistent).toBe(0)
    expect(report.findings).toHaveLength(0)
    expect(report.unauditable).toHaveLength(1)
    expect(report.unauditable[0]?.reason).toContain('no compiled ABI')
  })

  it('reports an unreadable constructor as unauditable', async () => {
    const report = await auditRecords(
      [record({ contractName: 'Malformed' })],
      deps({ Malformed: MALFORMED_ABI }, { Malformed: '1.0.0' })
    )

    expect(report.unauditable[0]?.reason).toContain(
      'constructor types unreadable'
    )
  })

  it('refuses a contract name that is not a Solidity identifier', async () => {
    const report = await auditRecords(
      [record({ contractName: '../../../etc/passwd' })],
      deps({ '../../../etc/passwd': ERC20_PROXY_ABI })
    )

    expect(report.unauditable[0]?.reason).toContain(
      'is not a Solidity identifier'
    )
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

describe('provenanceOf', () => {
  it('matches an exact version', () => {
    expect(provenanceOf('1.0.0', '1.0.0')).toBe('same-version')
  })

  it('treats every -tron revision as a fork overlay', () => {
    expect(provenanceOf('2.1.3-tron', '2.1.3')).toBe('fork-overlay')
    expect(provenanceOf('2.1.3-tron-r2', '2.1.3')).toBe('fork-overlay')
  })

  it('reports drift and an unreadable source version separately', () => {
    expect(provenanceOf('1.0.0', '1.1.0')).toBe('version-drift')
    expect(provenanceOf('1.0.0', null)).toBe('unknown-source-version')
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

describe('parseEnvironments', () => {
  it('expands all to both collections', () => {
    expect(parseEnvironments('all')).toEqual(['production', 'staging'])
  })

  it('accepts a single collection', () => {
    expect(parseEnvironments('staging')).toEqual(['staging'])
  })

  it('rejects an unknown environment', () => {
    expect(() => parseEnvironments('prod')).toThrow("got 'prod'")
  })
})

describe('formatRecord', () => {
  it('shows an absent field as absent rather than as a value', () => {
    expect(formatRecord(record({ constructorArgs: undefined }))).toContain(
      '(field absent)'
    )
  })

  it('shows an unusable timestamp instead of a broken date', () => {
    expect(formatRecord(record({ timestamp: new Date('nope') }))).toContain(
      'unknown-date'
    )
  })
})

describe('renderReport', () => {
  it('labels unverified records as leads, not verdicts', () => {
    const blocks = renderReport('production', ['tron'], {
      ...emptyReport({ examined: 1 }),
      unverified: [
        {
          record: record({ version: '1.1.0' }),
          workingTreeTypes: ['address', 'address'],
          workingTreeWouldSay: 'ERC20Proxy takes 2 constructor arguments',
          provenance: 'version-drift',
          sourceVersion: '2.0.0',
        },
      ],
    })
    const text = blocks.map((block) => block.text).join('\n')

    expect(text).toContain('NOT verdicts')
    expect(text).toContain("against the working tree's ABI this would read")
    expect(blocks.some((block) => block.level === 'error')).toBe(false)
  })

  it('points at the recorded commit when there is one', () => {
    const blocks = renderReport('production', ['tron'], {
      ...emptyReport({ examined: 1 }),
      unverified: [
        {
          record: record({ version: '1.1.0', gitCommitHash: 'abc123' }),
          workingTreeTypes: [],
          workingTreeWouldSay: null,
          provenance: 'version-drift',
          sourceVersion: '2.0.0',
        },
      ],
    })

    expect(blocks.map((block) => block.text).join('\n')).toContain(
      'git show abc123:'
    )
  })

  it('raises conclusive findings at error level', () => {
    const blocks = renderReport('production', ['tron'], {
      ...emptyReport({ examined: 1 }),
      findings: [
        {
          record: record(),
          declaredTypes: ['address', 'address'],
          message: 'ERC20Proxy takes 2 constructor arguments',
        },
      ],
    })

    expect(blocks.some((block) => block.level === 'error')).toBe(true)
  })

  it('says an all-unauditable run is not a clean result', () => {
    const blocks = renderReport('production', ['tron'], {
      ...emptyReport({ examined: 1 }),
      unauditable: [{ record: record(), reason: 'no compiled ABI' }],
    })

    expect(blocks.map((block) => block.text).join('\n')).toContain(
      'not a clean result'
    )
  })
})

describe('shouldFail', () => {
  it('fails on a conclusive finding', () => {
    const reports = {
      production: emptyReport({
        examined: 1,
        findings: [
          { record: record(), declaredTypes: [], message: 'mismatch' },
        ],
      }),
    }

    expect(shouldFail(reports, false)).toBe(true)
  })

  it('fails when every examined record was unauditable, even without --strict', () => {
    const reports = {
      production: emptyReport({
        examined: 1,
        unauditable: [{ record: record(), reason: 'no compiled ABI' }],
      }),
    }

    expect(shouldFail(reports, false)).toBe(true)
  })

  it('passes on unverified records unless --strict', () => {
    const reports = {
      production: emptyReport({
        examined: 2,
        consistent: 1,
        unverified: [
          {
            record: record(),
            workingTreeTypes: [],
            workingTreeWouldSay: null,
            provenance: 'version-drift',
            sourceVersion: '2.0.0',
          },
        ],
      }),
    }

    expect(shouldFail(reports, false)).toBe(false)
    expect(shouldFail(reports, true)).toBe(true)
  })

  it('passes on an empty collection', () => {
    expect(shouldFail({ staging: emptyReport() }, true)).toBe(false)
  })
})
