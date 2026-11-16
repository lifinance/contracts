import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { isTronNetworkKey } from '@lifi/tron-devkit'

import globalConfig from '../../../config/global.json'
import networksConfig from '../../../config/networks.json'

import {
  evaluateAttestableSelectors,
  type IAttestableSelectorState,
  parseAttestableSelectors,
} from './attestableSelectors'

const TRANSFER = '0xa9059cbb'
const TRANSFER_ENTRY = 'MockFacet.transfer(address,uint256)'
const APPROVE = '0x095ea7b3'
const FACET = '0x1111111111111111111111111111111111111111'
const OTHER_FACET = '0x2222222222222222222222222222222222222222'

const state = (
  overrides: Partial<IAttestableSelectorState>
): IAttestableSelectorState => ({
  expected: new Map([
    [TRANSFER, { facet: 'MockFacet', signature: 'transfer(address,uint256)' }],
  ]),
  enabled: new Map([[TRANSFER, true]]),
  routedTo: new Map([[TRANSFER, FACET]]),
  deployedContracts: { MockFacet: FACET.toUpperCase().replace('0X', '0x') },
  ...overrides,
})

describe('evaluateAttestableSelectors', () => {
  it('reports nothing when the diamond matches config', () => {
    expect(evaluateAttestableSelectors(state({}))).toEqual({
      errors: [],
      warnings: [],
    })
  })

  it('ignores a routed selector that is neither listed nor enabled', () => {
    const findings = evaluateAttestableSelectors(
      state({
        enabled: new Map([
          [TRANSFER, true],
          [APPROVE, false],
        ]),
        routedTo: new Map([
          [TRANSFER, FACET],
          [APPROVE, FACET],
        ]),
      })
    )

    expect(findings.errors).toEqual([])
  })

  it('warns on a listed selector that is not enabled yet', () => {
    const findings = evaluateAttestableSelectors(
      state({ enabled: new Map([[TRANSFER, false]]) })
    )

    expect(findings.errors).toEqual([])
    expect(findings.warnings).toEqual([
      `${TRANSFER} (${TRANSFER_ENTRY}) is listed but not attestable yet`,
    ])
  })

  it('fails an enabled selector config does not list', () => {
    const findings = evaluateAttestableSelectors(state({ expected: new Map() }))

    expect(findings.errors).toEqual([
      `${TRANSFER} is attestable but not listed in attestableSelectors for this network`,
    ])
  })

  it('fails an enabled flag left on a selector nothing routes', () => {
    const findings = evaluateAttestableSelectors(
      state({ expected: new Map(), routedTo: new Map() })
    )

    expect(findings.errors).toEqual([
      `${TRANSFER} is attestable but no facet routes it: a stale flag`,
    ])
  })

  it('fails a listed, enabled selector nothing routes', () => {
    const findings = evaluateAttestableSelectors(state({ routedTo: new Map() }))

    expect(findings.errors).toEqual([
      `${TRANSFER} (${TRANSFER_ENTRY}) is attestable but no facet routes it: the facet no longer has this signature`,
    ])
  })

  it('fails when the deploy log has no address for the facet', () => {
    const findings = evaluateAttestableSelectors(
      state({ deployedContracts: {} })
    )

    expect(findings.errors).toEqual([
      `${TRANSFER} (${TRANSFER_ENTRY}) is attestable but the deploy log has no MockFacet to compare its route with`,
    ])
  })

  it('fails a selector routed to another facet than the deploy log records', () => {
    const findings = evaluateAttestableSelectors(
      state({ routedTo: new Map([[TRANSFER, OTHER_FACET]]) })
    )

    expect(findings.errors).toEqual([
      `${TRANSFER} (${TRANSFER_ENTRY}) routes to ${OTHER_FACET}, not to MockFacet at ${FACET.toUpperCase().replace(
        '0X',
        '0x'
      )}`,
    ])
  })
})

describe('parseAttestableSelectors', () => {
  it('reads the committed config', () => {
    const { networks, selectors } = parseAttestableSelectors(
      globalConfig.attestableSelectors
    )

    expect(selectors.size).toBe(
      Object.keys(globalConfig.attestableSelectors.selectors).length
    )
    for (const network of networks) {
      expect(Object.keys(networksConfig)).toContain(network)
      // AttestedBridgeFacet and the health check that follows it are EVM-only.
      expect(isTronNetworkKey(network)).toBe(false)
    }
  })

  it('splits facet and signature and lowercases networks', () => {
    const { networks, selectors } = parseAttestableSelectors({
      networks: ['Base'],
      selectors: { [TRANSFER]: TRANSFER_ENTRY },
    })

    expect([...networks]).toEqual(['base'])
    expect(selectors.get(TRANSFER)).toEqual({
      facet: 'MockFacet',
      signature: 'transfer(address,uint256)',
    })
  })

  it.each([
    ['a non-object block', [], 'attestableSelectors must be an object'],
    [
      'missing networks',
      { selectors: {} },
      'attestableSelectors.networks must be an array of strings',
    ],
    [
      'a non-string network',
      { networks: [1], selectors: {} },
      'attestableSelectors.networks must be an array of strings',
    ],
    [
      'selectors as an array',
      { networks: [], selectors: [] },
      'attestableSelectors.selectors must be an object keyed by selector',
    ],
    [
      'an uppercase selector',
      { networks: [], selectors: { '0xA9059CBB': TRANSFER_ENTRY } },
      'is not a lowercase 4-byte selector',
    ],
    [
      'a short selector',
      { networks: [], selectors: { '0xa9059c': TRANSFER_ENTRY } },
      'is not a lowercase 4-byte selector',
    ],
    [
      'a value without a facet',
      { networks: [], selectors: { [TRANSFER]: 'transfer(address,uint256)' } },
      'must read "<Facet>.<signature>"',
    ],
    [
      'a non-string value',
      { networks: [], selectors: { [TRANSFER]: 7 } },
      'must read "<Facet>.<signature>"',
    ],
    [
      'a signature with an invalid type',
      {
        networks: [],
        selectors: { [TRANSFER]: 'MockFacet.transfer(notatype)' },
      },
      'transfer(notatype) hashes to 0x617a85b6',
    ],
    [
      'a signature that hashes elsewhere',
      {
        networks: [],
        selectors: { [TRANSFER]: 'MockFacet.approve(address,uint256)' },
      },
      'approve(address,uint256) hashes to 0x095ea7b3',
    ],
  ])('rejects %s', (_, raw, message) => {
    expect(() => parseAttestableSelectors(raw)).toThrow(message)
  })
})
