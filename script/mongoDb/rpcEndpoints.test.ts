/**
 * Unit tests for the RPC endpoint selection and ordering rules.
 *
 * The fixtures mirror the shapes present in the `RpcEndpoints` collection: documents predating
 * `isActive`/`environment` carry neither field, and keyless provider endpoints (a bare
 * `<chainId>.rpc.<provider>` host) sit alongside credentialed ones on the same chain.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildEnvLines,
  findUncredentialedPrimaries,
  hasApiCredentials,
  hostOf,
  lowestPriorityFor,
  prioritiesFor,
  repairOrder,
  selectEndpoints,
  type IRpcEndpoint,
} from './rpcEndpoints'

// Synthetic hosts: a fixture must not pin a real endpoint, and a real URL here would collide
// with the pre-commit secret checker once the same URL lands in a developer's env file.
const KEYED_DRPC =
  'https://lb.example.invalid/somechain?dkey=AbCdEf0123456789xyz'
const KEYLESS_PROVIDER = 'https://12345.rpc.example.invalid/'
const KEYLESS_PUBLIC = 'https://node.mainnet.example.invalid'

describe('hasApiCredentials', () => {
  it('detects a key carried in a query parameter', () => {
    expect(hasApiCredentials(KEYED_DRPC)).toBe(true)
  })

  it('detects a key carried as a path segment', () => {
    expect(
      hasApiCredentials(
        'https://12345.rpc.example.invalid/abcdef0123456789abcdef'
      )
    ).toBe(true)
  })

  it('detects basic auth credentials', () => {
    expect(hasApiCredentials('https://user:pass@rpc.example.invalid')).toBe(
      true
    )
  })

  it('reports a bare public endpoint as uncredentialed', () => {
    expect(hasApiCredentials(KEYLESS_PUBLIC)).toBe(false)
  })

  it('reports a provider host with no key as uncredentialed', () => {
    expect(hasApiCredentials(KEYLESS_PROVIDER)).toBe(false)
  })

  it('does not mistake a short route segment for a key', () => {
    expect(hasApiCredentials('https://rpc.somechain.example.invalid/rpc')).toBe(
      false
    )
  })

  it('returns false for an unparsable url rather than throwing', () => {
    expect(hasApiCredentials('not a url')).toBe(false)
  })
})

describe('selectEndpoints', () => {
  it('orders by descending priority', () => {
    const rpcs: IRpcEndpoint[] = [
      { url: 'https://c.example.invalid', priority: 1 },
      { url: 'https://a.example.invalid', priority: 3 },
      { url: 'https://b.example.invalid', priority: 2 },
    ]
    expect(selectEndpoints(rpcs, 'production').map((r) => r.url)).toEqual([
      'https://a.example.invalid',
      'https://b.example.invalid',
      'https://c.example.invalid',
    ])
  })

  it('drops endpoints explicitly deactivated', () => {
    const rpcs: IRpcEndpoint[] = [
      { url: 'https://off.example.invalid', priority: 9, isActive: false },
      { url: 'https://on.example.invalid', priority: 1 },
    ]
    expect(selectEndpoints(rpcs, 'production').map((r) => r.url)).toEqual([
      'https://on.example.invalid',
    ])
  })

  it('keeps endpoints with no isActive field', () => {
    const rpcs: IRpcEndpoint[] = [
      { url: 'https://legacy.example.invalid', priority: 1 },
    ]
    expect(selectEndpoints(rpcs, 'production')).toHaveLength(1)
  })

  it('drops endpoints belonging to another environment', () => {
    const rpcs: IRpcEndpoint[] = [
      {
        url: 'https://staging.example.invalid',
        priority: 9,
        environment: 'staging',
      },
      {
        url: 'https://prod.example.invalid',
        priority: 1,
        environment: 'production',
      },
    ]
    expect(selectEndpoints(rpcs, 'production').map((r) => r.url)).toEqual([
      'https://prod.example.invalid',
    ])
  })

  it('keeps endpoints with no environment field', () => {
    const rpcs: IRpcEndpoint[] = [
      { url: 'https://legacy.example.invalid', priority: 1 },
    ]
    expect(selectEndpoints(rpcs, 'staging')).toHaveLength(1)
  })

  it('drops entries with no url', () => {
    const rpcs = [{ url: '', priority: 5 }] as IRpcEndpoint[]
    expect(selectEndpoints(rpcs, 'production')).toHaveLength(0)
  })
})

describe('lowestPriorityFor', () => {
  it('places a new endpoint below every existing one', () => {
    const rpcs: IRpcEndpoint[] = [
      { url: 'https://a.example.invalid', priority: 3 },
      { url: 'https://b.example.invalid', priority: 1 },
    ]
    const priority = lowestPriorityFor(rpcs)
    expect(priority).toBeLessThan(1)
  })

  it('does not disturb which endpoint is primary', () => {
    const existing: IRpcEndpoint[] = [
      { url: KEYED_DRPC, priority: 2 },
      { url: KEYLESS_PUBLIC, priority: 1 },
    ]
    const withNewEndpoint = [
      ...existing,
      { url: KEYLESS_PROVIDER, priority: lowestPriorityFor(existing) },
    ]
    expect(selectEndpoints(withNewEndpoint, 'production')[0]?.url).toBe(
      KEYED_DRPC
    )
  })

  it('starts at 1 for a chain with no endpoints yet', () => {
    expect(lowestPriorityFor([])).toBe(1)
  })
})

describe('findUncredentialedPrimaries', () => {
  it('flags a chain whose primary carries no credentials', () => {
    const flagged = findUncredentialedPrimaries({
      ETH_NODE_URI_ETHERLINK: [
        { url: KEYLESS_PROVIDER, priority: 4 },
        { url: KEYED_DRPC, priority: 1 },
      ],
    })
    expect(flagged).toEqual([
      { network: 'ETH_NODE_URI_ETHERLINK', host: '12345.rpc.example.invalid' },
    ])
  })

  it('does not flag a chain whose primary is credentialed', () => {
    const flagged = findUncredentialedPrimaries({
      ETH_NODE_URI_ETHERLINK: [
        { url: KEYED_DRPC, priority: 4 },
        { url: KEYLESS_PROVIDER, priority: 1 },
      ],
    })
    expect(flagged).toEqual([])
  })

  it('never exposes the credential-bearing part of a url', () => {
    const flagged = findUncredentialedPrimaries({
      ETH_NODE_URI_TEST: [{ url: 'https://rpc.example.invalid/', priority: 1 }],
    })
    expect(flagged[0]?.host).toBe('rpc.example.invalid')
  })
})

describe('buildEnvLines', () => {
  it('writes the primary under the plain env var name', () => {
    const lines = buildEnvLines({
      ETH_NODE_URI_ETHERLINK: [
        { url: KEYED_DRPC, priority: 4 },
        { url: KEYLESS_PUBLIC, priority: 1 },
      ],
    })
    expect(lines).toContain(`ETH_NODE_URI_ETHERLINK="${KEYED_DRPC}"`)
  })

  it('writes the remaining endpoints to the fallbacks var, in order', () => {
    const lines = buildEnvLines({
      ETH_NODE_URI_ETHERLINK: [
        { url: KEYED_DRPC, priority: 4 },
        { url: KEYLESS_PROVIDER, priority: 3 },
        { url: KEYLESS_PUBLIC, priority: 1 },
      ],
    })
    expect(lines).toContain(
      `ETH_NODE_URI_ETHERLINK_FALLBACKS="${KEYLESS_PROVIDER} ${KEYLESS_PUBLIC}"`
    )
  })

  it('omits the fallbacks var for a single-endpoint chain', () => {
    const lines = buildEnvLines({
      ETH_NODE_URI_FLOW: [{ url: KEYLESS_PUBLIC, priority: 1 }],
    })
    expect(lines.some((line) => line.includes('_FALLBACKS'))).toBe(false)
  })

  it('groups networks under their initial, alphabetically', () => {
    const lines = buildEnvLines({
      ETH_NODE_URI_BASE: [{ url: 'https://base.example.invalid', priority: 1 }],
      ETH_NODE_URI_ARBITRUM: [
        { url: 'https://arb.example.invalid', priority: 1 },
      ],
    })
    const arbitrum = lines.findIndex((l) =>
      l.startsWith('ETH_NODE_URI_ARBITRUM')
    )
    const base = lines.findIndex((l) => l.startsWith('ETH_NODE_URI_BASE'))
    expect(arbitrum).toBeGreaterThan(-1)
    expect(arbitrum).toBeLessThan(base)
  })

  it('emits every line matched by the rewriter that strips the previous block', () => {
    const lines = buildEnvLines({
      ETH_NODE_URI_ETHERLINK: [
        { url: KEYED_DRPC, priority: 4 },
        { url: KEYLESS_PUBLIC, priority: 1 },
      ],
    })
    // fetch-rpcs removes the old RPC section with this pattern before writing the new one; a
    // line it does not match would accumulate a stale duplicate on every run.
    const stripPattern = /^\s*#?\s*ETH_NODE_URI_[A-Z0-9_]+\s*=/
    const headerPattern = /^\s*#\s*=+\s*[A-Z]\s*=+\s*$/
    for (const line of lines.filter((l) => l.trim() !== ''))
      expect(stripPattern.test(line) || headerPattern.test(line)).toBe(true)
  })
})

describe('hostOf', () => {
  it('returns only the host, never the credential-bearing path or query', () => {
    expect(hostOf(KEYED_DRPC)).toBe('lb.example.invalid')
    expect(
      hostOf('https://12345.rpc.example.invalid/secretkey0123456789')
    ).toBe('12345.rpc.example.invalid')
  })

  it('degrades to a placeholder for an unparsable url', () => {
    expect(hostOf('nonsense')).toBe('<unparsable url>')
  })
})

describe('repairOrder', () => {
  it('lifts every credentialed endpoint above every uncredentialed one', () => {
    const ordered: IRpcEndpoint[] = [
      { url: KEYLESS_PROVIDER, priority: 4 },
      { url: KEYLESS_PUBLIC, priority: 3 },
      { url: KEYED_DRPC, priority: 1 },
    ]
    expect(repairOrder(ordered).map((r) => r.url)).toEqual([
      KEYED_DRPC,
      KEYLESS_PROVIDER,
      KEYLESS_PUBLIC,
    ])
  })

  it('preserves the existing relative order inside each group', () => {
    const first = 'https://a.example.invalid/aaaaaaaaaaaaaaaaaaaaaaaa'
    const second = 'https://b.example.invalid/bbbbbbbbbbbbbbbbbbbbbbbb'
    const ordered: IRpcEndpoint[] = [
      { url: first, priority: 3 },
      { url: second, priority: 2 },
    ]
    expect(repairOrder(ordered).map((r) => r.url)).toEqual([first, second])
  })

  it('leaves a chain with no credentialed endpoint untouched', () => {
    const ordered: IRpcEndpoint[] = [
      { url: KEYLESS_PROVIDER, priority: 2 },
      { url: KEYLESS_PUBLIC, priority: 1 },
    ]
    expect(repairOrder(ordered).map((r) => r.url)).toEqual([
      KEYLESS_PROVIDER,
      KEYLESS_PUBLIC,
    ])
  })
})

describe('prioritiesFor', () => {
  it('assigns strictly descending priorities with no ties', () => {
    expect(prioritiesFor(3)).toEqual([3, 2, 1])
  })

  it('reproduces the repaired order when fed back through selectEndpoints', () => {
    const repaired = repairOrder([
      { url: KEYLESS_PROVIDER, priority: 4 },
      { url: KEYED_DRPC, priority: 1 },
    ])
    const priorities = prioritiesFor(repaired.length)
    const written = repaired.map((endpoint, index) => ({
      ...endpoint,
      priority: priorities[index] as number,
    }))
    expect(selectEndpoints(written, 'production').map((r) => r.url)).toEqual([
      KEYED_DRPC,
      KEYLESS_PROVIDER,
    ])
  })
})
