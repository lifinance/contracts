// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  PREFLIGHT_EXIT_CODE,
  preflight,
  renderPreflight,
  type IPreflightDeps,
} from './signer-preflight'
import { VIEW_WIDTH } from './signer-view'

const ESC = String.fromCharCode(27)
const stripAnsi = (s: string): string =>
  s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const KEYED_URL = 'https://lb.drpc.org/ogrpc?network=arbitrum&dkey=NOTAREALKEY'

const deps = (overrides: Partial<IPreflightDeps> = {}): IPreflightDeps => ({
  endpointConfigured: () => true,
  expectedChainId: (network) => (network === 'arbitrum' ? 42161 : 137),
  chainIdOf: async (network) => (network === 'arbitrum' ? 42161 : 137),
  envVarName: (network) => `ETH_NODE_URI_${network.toUpperCase()}`,
  ...overrides,
})

describe('preflight', () => {
  it('lets a network with a working endpoint start, and says nothing about it', async () => {
    const verdict = await preflight(['arbitrum'], deps())

    expect(verdict.startable).toEqual(['arbitrum'])
    expect(verdict.refused).toEqual([])
    expect(verdict.findings).toEqual([])
  })

  it('refuses a network whose endpoint variable is unset, naming the variable', async () => {
    const verdict = await preflight(
      ['arbitrum'],
      deps({ endpointConfigured: () => false })
    )

    expect(verdict.startable).toEqual([])
    expect(verdict.refused).toEqual(['arbitrum'])
    expect(verdict.findings[0]?.detail).toContain('ETH_NODE_URI_ARBITRUM')
  })

  // Set is not reachable: the variable can hold a dead endpoint, and every
  // read after it would fail one at a time.
  it('refuses a network whose endpoint does not answer', async () => {
    const verdict = await preflight(
      ['arbitrum'],
      deps({
        chainIdOf: () => {
          throw new Error('fetch failed')
        },
      })
    )

    expect(verdict.refused).toEqual(['arbitrum'])
    expect(verdict.findings[0]?.detail).toContain('fetch failed')
  })

  // The dangerous one: every later read would answer truthfully about a
  // different chain.
  it('refuses an endpoint pointed at the wrong chain, naming both ids', async () => {
    const verdict = await preflight(
      ['arbitrum'],
      deps({ chainIdOf: async () => 1 })
    )

    expect(verdict.refused).toEqual(['arbitrum'])
    expect(verdict.findings[0]?.detail).toContain('1')
    expect(verdict.findings[0]?.detail).toContain('42161')
  })

  it('refuses only the network that failed, and starts the rest', async () => {
    const verdict = await preflight(
      ['arbitrum', 'polygon'],
      deps({ endpointConfigured: (network) => network !== 'polygon' })
    )

    expect(verdict.startable).toEqual(['arbitrum'])
    expect(verdict.refused).toEqual(['polygon'])
    expect(verdict.findings).toHaveLength(1)
  })

  it('reports every failing network in one pass, not the first one', async () => {
    const verdict = await preflight(
      ['arbitrum', 'polygon'],
      deps({ endpointConfigured: () => false })
    )

    expect(verdict.refused).toEqual(['arbitrum', 'polygon'])
    expect(verdict.findings).toHaveLength(2)
  })

  // A URL carries an API key. Nothing the preflight reports may contain one,
  // including the node's own error text, which embeds the URL it called.
  it('keeps the endpoint out of every finding, error text included', async () => {
    const verdict = await preflight(
      ['arbitrum'],
      deps({
        chainIdOf: () => {
          throw new Error(`HTTP request failed. URL: ${KEYED_URL}`)
        },
      })
    )
    const printed =
      JSON.stringify(verdict) + renderPreflight(verdict).join('\n')

    expect(printed).not.toContain('dkey')
    expect(printed).not.toContain('NOTAREALKEY')
    expect(printed).toContain('HTTP request failed')
  })

  // §2b of 28-executability-case-table.md, as a test rather than as prose.
  it('gives every finding a remedy and a concrete value to act on', async () => {
    const verdict = await preflight(
      ['arbitrum', 'polygon'],
      deps({
        endpointConfigured: (network) => network !== 'polygon',
        chainIdOf: async () => 1,
      })
    )

    expect(verdict.findings).toHaveLength(2)
    for (const finding of verdict.findings) {
      expect(finding.remedy.length).toBeGreaterThan(0)
      expect(finding.detail).toMatch(/ETH_NODE_URI_|\d/u)
    }
  })
})

describe('renderPreflight', () => {
  const refusedBoth = async () =>
    preflight(
      ['arbitrum', 'polygon'],
      deps({ endpointConfigured: () => false })
    )

  it('gives each refused network one row, with its cause and its remedy', async () => {
    const lines = renderPreflight(await refusedBoth()).map(stripAnsi)
    const plain = lines.join('\n')

    expect(plain).toContain('CANNOT START')
    expect(lines.filter((line) => /⛔ arbitrum\b/u.test(line))).toHaveLength(1)
    expect(lines.filter((line) => /⛔ polygon\b/u.test(line))).toHaveLength(1)
    expect(plain).toContain('ETH_NODE_URI_POLYGON')
    expect(plain.toLowerCase()).toContain('start over')
  })

  // The defect this exists to remove: one unset variable became ten identical
  // "re-run this check" rows above the single line that named the cause.
  it('never enumerates the checks a refused network did not run', async () => {
    const plain = renderPreflight(await refusedBoth())
      .map(stripAnsi)
      .join('\n')

    expect(plain).not.toContain('unverified')
    expect(plain).not.toContain('re-run this check')
    expect(plain.split('\n').length).toBeLessThan(12)
  })

  it('stays inside the view width', async () => {
    for (const line of renderPreflight(await refusedBoth()))
      expect(stripAnsi(line).length).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('renders nothing when every network can start', async () => {
    const verdict = await preflight(['arbitrum'], deps())

    expect(renderPreflight(verdict)).toEqual([])
  })
})

describe('PREFLIGHT_EXIT_CODE', () => {
  // Distinct from a refusal to sign, so a caller can tell "fix your
  // environment" from "this proposal was rejected".
  it('is the configuration-error code, not a generic failure', () => {
    expect(PREFLIGHT_EXIT_CODE).toBe(78)
    expect(PREFLIGHT_EXIT_CODE).not.toBe(1)
  })
})
