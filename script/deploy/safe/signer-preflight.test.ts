// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  PREFLIGHT_EXIT_CODE,
  networkPreflight,
  renderNetworkPreflight,
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
    const verdict = await networkPreflight(['arbitrum'], deps())

    expect(verdict.startable).toEqual(['arbitrum'])
    expect(verdict.refused).toEqual([])
    expect(verdict.findings).toEqual([])
  })

  it('refuses a network whose endpoint variable is unset, naming the variable', async () => {
    const verdict = await networkPreflight(
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
    const verdict = await networkPreflight(
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
    const verdict = await networkPreflight(
      ['arbitrum'],
      deps({ chainIdOf: async () => 1 })
    )

    expect(verdict.refused).toEqual(['arbitrum'])
    // The whole clause, not each id alone: '42161' contains '1', so asserting
    // the answered id on its own observes nothing.
    expect(verdict.findings[0]?.detail).toContain(
      'answered chain id 1, and arbitrum is 42161'
    )
  })

  it('refuses only the network that failed, and starts the rest', async () => {
    const verdict = await networkPreflight(
      ['arbitrum', 'polygon'],
      deps({ endpointConfigured: (network) => network !== 'polygon' })
    )

    expect(verdict.startable).toEqual(['arbitrum'])
    expect(verdict.refused).toEqual(['polygon'])
    expect(verdict.findings).toHaveLength(1)
  })

  it('reports every failing network in one pass, not the first one', async () => {
    const verdict = await networkPreflight(
      ['arbitrum', 'polygon'],
      deps({ endpointConfigured: () => false })
    )

    expect(verdict.refused).toEqual(['arbitrum', 'polygon'])
    expect(verdict.findings).toHaveLength(2)
  })

  // A URL carries an API key. Nothing the preflight reports may contain one,
  // including the node's own error text, which embeds the URL it called.
  it('keeps the endpoint out of every finding, error text included', async () => {
    const verdict = await networkPreflight(
      ['arbitrum'],
      deps({
        chainIdOf: () => {
          throw new Error(`HTTP request failed. URL: ${KEYED_URL}`)
        },
      })
    )
    const printed =
      JSON.stringify(verdict) + renderNetworkPreflight(verdict).join('\n')

    expect(printed).not.toContain('dkey')
    expect(printed).not.toContain('NOTAREALKEY')
    expect(printed).toContain('HTTP request failed')
  })

  it('gives every finding a remedy and a concrete value to act on', async () => {
    const verdict = await networkPreflight(
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
    networkPreflight(
      ['arbitrum', 'polygon'],
      deps({ endpointConfigured: () => false })
    )

  it('gives each refused network one row, with its cause and its remedy', async () => {
    const lines = renderNetworkPreflight(await refusedBoth()).map(stripAnsi)
    const plain = lines.join('\n')

    expect(plain).toContain('CANNOT START')
    expect(lines.filter((line) => /⛔ arbitrum\b/u.test(line))).toHaveLength(1)
    expect(lines.filter((line) => /⛔ polygon\b/u.test(line))).toHaveLength(1)
    expect(plain).toContain('ETH_NODE_URI_POLYGON')
    expect(plain.toLowerCase()).toContain('start over')
  })

  // A refused network's checks are not the news: each would print the same
  // unactionable remedy, burying the one line that names the cause.
  it('never enumerates the checks a refused network did not run', async () => {
    const plain = renderNetworkPreflight(await refusedBoth())
      .map(stripAnsi)
      .join('\n')

    expect(plain).not.toContain('unverified')
    expect(plain).not.toContain('re-run this check')
  })

  // A short error text tests the fixture, not the property. A real viem message
  // carries the URL it called and the provider's whole response body behind it,
  // and that body is the least trusted text on the screen: it is chosen by
  // whoever answers the endpoint.
  it('cannot let a provider error repaint the terminal or fill it', async () => {
    const body = `${ESC}[31mALL CHECKS PASSED${ESC}[0m‮plausible‬${'padding '.repeat(
      40
    )}`
    const verdict = await networkPreflight(
      ['arbitrum'],
      deps({
        chainIdOf: () => {
          throw new Error(
            `HTTP request failed. Status: 429 URL: ${KEYED_URL} Details: "${body}" Version: viem@2.55.19`
          )
        },
      })
    )
    const rendered = renderNetworkPreflight(verdict)
    const detail = verdict.findings[0]?.detail ?? ''

    // The escapes are gone, so the only colour on these lines is the one this
    // module put there: stripping ANSI must not shorten the detail at all.
    expect(stripAnsi(detail)).toBe(detail)
    expect(detail).not.toContain('‮')
    expect(detail).not.toContain('dkey')
    // Two rows per refused network, plus a blank line and the heading. One
    // network's error cannot become a screenful.
    expect(rendered.map(stripAnsi).length).toBeLessThanOrEqual(10)
  })

  it('stays inside the view width', async () => {
    for (const line of renderNetworkPreflight(await refusedBoth()))
      expect(stripAnsi(line).length).toBeLessThanOrEqual(VIEW_WIDTH)
  })

  it('renders nothing when every network can start', async () => {
    const verdict = await networkPreflight(['arbitrum'], deps())

    expect(renderNetworkPreflight(verdict)).toEqual([])
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
