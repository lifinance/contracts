import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  diagnoseBehindMain,
  formatBehindMainLine,
  renderBehindMainSummary,
  type IBehindMainDeps,
  type IBehindMainInput,
} from './healthCheckBehindMain'

const CVF_OLD = '0x7A5c119ec5dDbF9631cf40f6e5DB28f31d4332a0'
const NEAR_OLD = '0x1111111111111111111111111111111111111111'
const NEAR_NEW = '0x8f00E690a45e75D7A1A765163829Ad33244a1C33'
const TW_OLD = '0x5215E9fd223BC909083fbdB2860213873046e45d'
const TW_NEW = '0x31F6b192Ec4a7eEF00E09ee17c36ca518c65bbfe'
const EXECUTOR = '0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D'

const REPO: Record<string, string> = {
  CalldataVerificationFacet: '2.0.0',
  NEARIntentsFacet: '3.0.0',
  TokenWrapper: '1.2.1',
  Executor: '1.0.0',
  PinnedFacet: '9.0.0',
}

function makeInput(
  overrides: Partial<IBehindMainInput> = {}
): IBehindMainInput {
  return {
    networkLower: 'gnosis',
    targetContracts: {
      CalldataVerificationFacet: 'latest',
      NEARIntentsFacet: 'latest',
      TokenWrapper: 'latest',
      Executor: 'latest',
      PinnedFacet: '1.0.0',
    },
    onChainFacets: [
      { address: CVF_OLD, selectors: ['0x01'] },
      { address: NEAR_OLD, selectors: ['0x02'] },
    ],
    deployedContracts: {
      CalldataVerificationFacet: CVF_OLD,
      NEARIntentsFacet: NEAR_NEW,
      TokenWrapper: TW_OLD,
      Executor: EXECUTOR,
    },
    // The diamond log was rewritten ahead of the cut: it names the new NEAR address only.
    diamondFacetLog: {
      [CVF_OLD]: { Name: 'CalldataVerificationFacet', Version: '1.1.1' },
      [NEAR_NEW]: { Name: 'NEARIntentsFacet', Version: '3.0.0' },
    },
    deployLog: {
      NEARIntentsFacet: {
        gnosis: {
          production: {
            '1.0.0': [{ ADDRESS: NEAR_OLD }],
            '3.0.0': [{ ADDRESS: NEAR_NEW }],
          },
        },
      },
      TokenWrapper: {
        gnosis: {
          production: {
            '1.0.0': [{ ADDRESS: TW_OLD }],
            '1.2.1': [{ ADDRESS: TW_NEW }],
          },
        },
      },
      Executor: {
        gnosis: { production: { '1.0.0': [{ ADDRESS: EXECUTOR }] } },
      },
    },
    ...overrides,
  }
}

function makeDeps(registry: Record<string, string | null>): IBehindMainDeps {
  return {
    isFacet: (name) => name.endsWith('Facet'),
    readRegistry: async (name) =>
      new Map(Object.entries(registry)).get(name) ?? null,
    repoVersion: async (name) => {
      const version = REPO[name]
      if (!version) throw new Error(`Could not find version for ${name}`)
      return version
    },
  }
}

describe('diagnoseBehindMain', () => {
  it('names CVF, NEAR and TokenWrapper as behind on the gnosis shape', async () => {
    const report = await diagnoseBehindMain(
      makeInput(),
      makeDeps({ TokenWrapper: TW_OLD, Executor: EXECUTOR })
    )
    expect(report.behind).toEqual([
      { contract: 'CalldataVerificationFacet', live: '1.1.1', repo: '2.0.0' },
      { contract: 'NEARIntentsFacet', live: '1.0.0', repo: '3.0.0' },
      { contract: 'TokenWrapper', live: '1.0.0', repo: '1.2.1' },
    ])
    expect(report.current).toEqual(['Executor'])
    expect(report.undiagnosed).toEqual([])
  })

  it('reads a periphery version from the registered address, not the deploy log name', async () => {
    const report = await diagnoseBehindMain(
      makeInput(),
      makeDeps({ TokenWrapper: TW_NEW, Executor: EXECUTOR })
    )
    expect(report.behind.map((row) => row.contract)).not.toContain(
      'TokenWrapper'
    )
    expect(report.current).toContain('TokenWrapper')
  })

  it('skips pinned keys: only latest follows the repo', async () => {
    const report = await diagnoseBehindMain(
      makeInput(),
      makeDeps({ TokenWrapper: TW_OLD, Executor: EXECUTOR })
    )
    const named = [
      ...report.behind.map((row) => row.contract),
      ...report.current,
      ...report.undiagnosed.map((row) => row.contract),
    ]
    expect(named).not.toContain('PinnedFacet')
    expect(named).toContain('Executor')
  })

  it('reports a contract it cannot place as undiagnosed, never as current', async () => {
    const report = await diagnoseBehindMain(
      makeInput({
        targetContracts: { TokenWrapper: 'latest', GhostFacet: 'latest' },
      }),
      makeDeps({ TokenWrapper: '0x9999999999999999999999999999999999999999' })
    )
    expect(report.current).toEqual([])
    expect(report.behind).toEqual([])
    expect(report.undiagnosed.map((row) => row.contract).sort()).toEqual([
      'GhostFacet',
      'TokenWrapper',
    ])
  })

  it('keeps going when one repo version cannot be read', async () => {
    const report = await diagnoseBehindMain(
      makeInput({
        targetContracts: { Executor: 'latest', Unversioned: 'latest' },
        deployedContracts: { Executor: EXECUTOR, Unversioned: EXECUTOR },
      }),
      makeDeps({ Executor: EXECUTOR })
    )
    expect(report.current).toEqual(['Executor'])
    expect(report.undiagnosed).toEqual([
      {
        contract: 'Unversioned',
        reason: 'Could not find version for Unversioned',
      },
    ])
  })

  it('falls back to the deploy-log address when the registry read fails', async () => {
    const report = await diagnoseBehindMain(
      makeInput({ targetContracts: { TokenWrapper: 'latest' } }),
      {
        ...makeDeps({}),
        readRegistry: async () => {
          throw new Error('rpc down')
        },
      }
    )
    expect(report.behind).toEqual([
      { contract: 'TokenWrapper', live: '1.0.0', repo: '1.2.1' },
    ])
  })

  it('compares a suffixed repo version by its base', async () => {
    const report = await diagnoseBehindMain(
      makeInput({ targetContracts: { Executor: 'latest' } }),
      {
        ...makeDeps({ Executor: EXECUTOR }),
        repoVersion: async () => '1.0.0-tron',
      }
    )
    expect(report.current).toEqual(['Executor'])
  })

  it.each(['toString', 'constructor', '__proto__'])(
    'does not answer a prototype name from the deploy log (%s)',
    async (name) => {
      const report = await diagnoseBehindMain(
        makeInput({
          targetContracts: { [name]: 'latest' },
          deployedContracts: { [name]: EXECUTOR },
        }),
        { ...makeDeps({}), repoVersion: async () => '1.0.0' }
      )
      expect(report.undiagnosed.map((row) => row.contract)).toEqual([name])
    }
  )

  it('says so when the network has no production target state', async () => {
    const report = await diagnoseBehindMain(
      makeInput({ targetContracts: undefined }),
      makeDeps({})
    )
    expect(formatBehindMainLine(report)).toContain('no production target state')
  })
})

describe('a registered periphery address the deploy log does not record', () => {
  const TW_UNLOGGED = '0x2222222222222222222222222222222222222222'
  const input = makeInput({
    targetContracts: { TokenWrapper: 'latest', Executor: 'latest' },
  })

  it('counts the contract as undiagnosed in the headline and names it', async () => {
    const report = await diagnoseBehindMain(
      input,
      makeDeps({ TokenWrapper: TW_UNLOGGED, Executor: EXECUTOR })
    )
    expect(report.undiagnosed).toEqual([
      {
        contract: 'TokenWrapper',
        reason: `no deploy-log version recorded for ${TW_UNLOGGED}`,
      },
    ])
    const line = formatBehindMainLine(report)
    expect(line).toContain('0 behind, 1 undiagnosed, of 2')
    expect(line).toContain('undiagnosed: TokenWrapper')
  })

  it('diagnoses the same contract once its registered address is in the log', async () => {
    const report = await diagnoseBehindMain(
      input,
      makeDeps({ TokenWrapper: TW_OLD, Executor: EXECUTOR })
    )
    expect(report.undiagnosed).toEqual([])
    const line = formatBehindMainLine(report)
    expect(line).toContain('1 behind, 0 undiagnosed, of 2')
    expect(line).toContain('TokenWrapper 1.0.0 < 1.2.1')
    expect(line).not.toContain('undiagnosed:')
  })
})

describe('formatBehindMainLine', () => {
  it('lists each behind contract with both versions', async () => {
    const report = await diagnoseBehindMain(
      makeInput(),
      makeDeps({ TokenWrapper: TW_OLD, Executor: EXECUTOR })
    )
    const line = formatBehindMainLine(report)
    expect(line).toContain('gnosis')
    expect(line).toContain('CalldataVerificationFacet 1.1.1 < 2.0.0')
    expect(line).toContain('NEARIntentsFacet 1.0.0 < 3.0.0')
    expect(line).toContain('TokenWrapper 1.0.0 < 1.2.1')
    expect(line).not.toContain('Executor')
  })

  it('says nothing is behind when every contract is current', async () => {
    const report = await diagnoseBehindMain(
      makeInput({ targetContracts: { Executor: 'latest' } }),
      makeDeps({ Executor: EXECUTOR })
    )
    expect(formatBehindMainLine(report)).toContain(
      '0 behind, 0 undiagnosed, of 1'
    )
  })
})

describe('renderBehindMainSummary', () => {
  it('prints one line per network that produced one, sorted', () => {
    const rendered = renderBehindMainSummary([
      { network: 'zksync', behindMain: '[zksync] z' },
      { network: 'arbitrum', behindMain: '[arbitrum] a' },
      { network: 'tron' },
    ])
    expect(rendered).toEqual(['[arbitrum] a', '[zksync] z'])
  })
})
