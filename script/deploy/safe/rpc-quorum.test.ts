// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type {
  IProviderObservation,
  IRpcQuorumVerdict,
  TQuorumStatus,
} from './rpc-quorum'
import {
  assertRpcQuorum,
  DEFAULT_QUORUM_RETRY_POLICY,
  evaluateQuorumCoverage,
  evaluateRpcQuorum,
  groupProviders,
  MIN_INDEPENDENT_PROVIDERS,
  planQuorumRetry,
  IP_LITERAL_IDENTITY,
  providerIdentityForUrl,
  renderQuorumCoverage,
  renderRpcQuorum,
  resolveRpcQuorum,
} from './rpc-quorum'

const CODE = '0x6080604052348015'
const OTHER_CODE = '0xdeadbeefdeadbeef'
const BLOCK = 21_000_000n
const HASH =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001'
const OTHER_HASH =
  '0xbbbb000000000000000000000000000000000000000000000000000000000002'

/** A keyed endpoint URL: printing one leaks the provider credential in it. */
const KEYED_URL = 'https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY_VALUE'

const ok = (
  endpointUrl: string,
  overrides: Partial<IProviderObservation> = {}
): IProviderObservation => ({
  endpointUrl,
  outcome: 'ok',
  value: CODE,
  blockNumber: BLOCK,
  blockHash: HASH,
  ...overrides,
})

const failed = (
  endpointUrl: string,
  error = 'fetch failed'
): IProviderObservation => ({ endpointUrl, outcome: 'error', error })

const ALCHEMY = 'https://eth-mainnet.g.alchemy.com/v2/key-one'
const INFURA = 'https://mainnet.infura.io/v3/key-two'
const ANKR = 'https://rpc.ankr.com/eth/key-three'

describe('providerIdentityForUrl', () => {
  it('collapses subdomains of one provider onto one identity', () => {
    expect(providerIdentityForUrl(ALCHEMY)).toBe('alchemy.com')
    expect(providerIdentityForUrl('https://polygon.g.alchemy.com/v2/x')).toBe(
      'alchemy.com'
    )
  })

  it('ignores the port, so one provider on two ports stays one provider', () => {
    expect(providerIdentityForUrl('https://rpc.example.com:8545/x')).toBe(
      providerIdentityForUrl('https://rpc.example.com/x')
    )
  })

  it('collapses every bare-IP host onto one identity, whatever the family', () => {
    // Two concerns at once. Slicing the last two labels off an address would
    // give `0.1`, which is not an identity — that is why an address is not
    // treated as a hostname. And an address cannot be shown independent of a
    // name that may resolve to it, so it must not be an identity of its own
    // either: all of them share one, and several IP endpoints cannot inflate
    // the provider count between themselves.
    for (const url of [
      'http://10.0.0.1:8545',
      'http://203.0.113.7:8545',
      'http://[2001:db8::1]:8545',
      'https://198.51.100.4/',
    ])
      expect(providerIdentityForUrl(url), url).toBe(IP_LITERAL_IDENTITY)
  })

  it('does not confuse a hostname that merely contains digits with an address', () => {
    // Paired presence: collapsing addresses must not collapse real hosts.
    expect(providerIdentityForUrl('https://rpc.10gen.example/')).toBe(
      '10gen.example'
    )
  })

  it('reads a single-label host as the same provider whatever the root dot', () => {
    // An intranet node named without a domain: the last-two-labels rule cannot
    // apply, and returning the host verbatim let `rpc-node.` split from
    // `rpc-node` — one node counted as two providers.
    for (const host of ['rpc-node', 'localhost', 'com'])
      expect(providerIdentityForUrl(`http://${host}./`), host).toBe(
        providerIdentityForUrl(`http://${host}/`)
      )

    // Paired presence: two different single-label hosts stay two providers.
    // Collapsing them could only ever refuse, so it is the safe direction — but
    // unasserted it would quietly stop two intranet nodes reaching a quorum.
    expect(providerIdentityForUrl('http://rpc-node-a/')).not.toBe(
      providerIdentityForUrl('http://rpc-node-b/')
    )
  })

  it('reads a trailing-dot host as the same provider as the rooted form', () => {
    // A fully-qualified name may carry a root dot, and WHATWG URL preserves it.
    // Without dropping the empty label the last two become ['com', ''], which
    // matches no hostname identity — so the two forms of one provider would
    // split, and a split is what invents a quorum.
    expect(providerIdentityForUrl('https://rpc.example.com./')).toBe(
      providerIdentityForUrl('https://rpc.example.com/')
    )
    expect(providerIdentityForUrl('https://rpc.example.com./')).toBe(
      'example.com'
    )
  })

  it('merges every unparsable endpoint onto one identity', () => {
    expect(providerIdentityForUrl('not a url')).toBe(
      providerIdentityForUrl('also not a url')
    )
  })
})

describe('groupProviders', () => {
  it('reports one identity per observation, in input order', () => {
    expect(groupProviders([ok(ALCHEMY), ok(INFURA)])).toEqual([
      'alchemy.com',
      'infura.io',
    ])
  })

  it('merges two hosts an operator declares to share an upstream', () => {
    const grouped = groupProviders([
      ok('https://rpc.frontend-a.com/x', { providerId: 'shared-upstream' }),
      ok('https://rpc.frontend-b.com/x', { providerId: 'shared-upstream' }),
    ])

    expect(new Set(grouped).size).toBe(1)
  })

  it('cannot split two endpoints the URLs already call one provider', () => {
    const grouped = groupProviders([
      ok('https://a.alchemy.com/x', { providerId: 'pretend-independent-a' }),
      ok('https://b.alchemy.com/x', { providerId: 'pretend-independent-b' }),
    ])

    expect(new Set(grouped).size).toBe(1)
  })

  it('names a declared merge after the hostname, whichever order the IP arrives in', () => {
    const ip = ok('https://198.51.100.4/', { providerId: 'alchemy' })
    const named = ok(ALCHEMY, { providerId: 'alchemy' })

    expect(groupProviders([ip, named])).toEqual(['alchemy.com', 'alchemy.com'])
    expect(groupProviders([named, ip])).toEqual(['alchemy.com', 'alchemy.com'])
  })
})

describe('evaluateRpcQuorum — the green case', () => {
  it('believes a read two independent providers agree on', () => {
    const verdict = evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)])

    expect(verdict.status).toBe('agreed')
    expect(verdict.reachesQuorum).toBe(true)
    expect(verdict.agreeingProviders).toBe(2)
    expect(verdict.agreedValue).toBe(CODE)
    expect(verdict.blockNumber).toBe(BLOCK)
  })

  it('treats case and whitespace differences as the same answer', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY, { value: CODE.toUpperCase().replace('0X', '0x') }),
      ok(INFURA, { value: `  ${CODE}  ` }),
    ])

    expect(verdict.status).toBe('agreed')
    expect(verdict.agreeingProviders).toBe(2)
  })

  it('counts two endpoints of two providers, not the endpoint total', () => {
    const verdict = evaluateRpcQuorum([
      ok('https://a.alchemy.com/x'),
      ok('https://b.alchemy.com/x'),
      ok(INFURA),
    ])

    expect(verdict.endpointsConsulted).toBe(3)
    expect(verdict.independentProviders).toBe(2)
    expect(verdict.agreeingProviders).toBe(2)
    expect(verdict.reachesQuorum).toBe(true)
  })
})

describe('evaluateRpcQuorum — a lying provider', () => {
  it('refuses when two providers disagree, trusting neither', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { value: OTHER_CODE }),
    ])

    expect(verdict.status).toBe('disagreement')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.agreedValue).toBeUndefined()
    expect(verdict.detail).toContain('2 different values')
  })

  it('refuses a majority of three, because a majority is not a quorum', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA),
      ok(ANKR, { value: OTHER_CODE }),
    ])

    expect(verdict.status).toBe('disagreement')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.largestAgreeingGroup).toBe(2)
    expect(verdict.agreeingProviders).toBe(0)
  })

  it('never retries a disagreement', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { value: OTHER_CODE }),
    ])

    expect(verdict.transient).toBe(false)
    expect(planQuorumRetry(verdict, 1).retry).toBe(false)
  })
})

describe('evaluateRpcQuorum — lag and reorg', () => {
  it('does not call a lagging provider a disagreement', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { blockNumber: BLOCK - 1n, value: OTHER_CODE }),
    ])

    expect(verdict.status).toBe('heights-not-aligned')
    expect(verdict.transient).toBe(true)
    expect(verdict.reachesQuorum).toBe(false)
  })

  it('refuses two providers on different chains at the same height', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { blockHash: OTHER_HASH }),
    ])

    expect(verdict.status).toBe('fork-divergence')
    expect(verdict.transient).toBe(false)
    expect(verdict.reachesQuorum).toBe(false)
  })

  it('agrees when the same block is read by both, whatever the hash case', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { blockHash: HASH.toUpperCase().replace('0X', '0x') }),
    ])

    expect(verdict.status).toBe('agreed')
  })
})

describe('evaluateRpcQuorum — absence is never agreement', () => {
  it('refuses one provider answering alone', () => {
    const verdict = evaluateRpcQuorum([ok(ALCHEMY)])

    expect(verdict.status).toBe('insufficient-providers')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.agreeingProviders).toBe(0)
    expect(verdict.transient).toBe(false)
  })

  it('refuses two endpoints that are one provider', () => {
    const verdict = evaluateRpcQuorum([
      ok('https://a.alchemy.com/x'),
      ok('https://b.alchemy.com/x'),
    ])

    expect(verdict.status).toBe('insufficient-providers')
    expect(verdict.independentProviders).toBe(1)
    expect(verdict.endpointsConsulted).toBe(2)
  })

  it('does not count a provider that errored toward agreement', () => {
    const verdict = evaluateRpcQuorum([ok(ALCHEMY), failed(INFURA)])

    expect(verdict.status).toBe('insufficient-responses')
    expect(verdict.respondingProviders).toBe(1)
    expect(verdict.independentProviders).toBe(2)
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.transient).toBe(true)
  })

  it('does not count a provider that answered without a block reference', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { blockHash: undefined }),
    ])

    expect(verdict.status).toBe('insufficient-responses')
    expect(
      verdict.perProvider.find((entry) => entry.provider === 'infura.io')
        ?.rejection
    ).toContain('block reference')
  })

  it('does not count a provider that reported success without a value', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA, { value: undefined }),
    ])

    expect(verdict.status).toBe('insufficient-responses')
    expect(verdict.reachesQuorum).toBe(false)
  })

  it('refuses a total outage as unverified, not as unchanged', () => {
    const verdict = evaluateRpcQuorum([failed(ALCHEMY), failed(INFURA)])

    expect(verdict.status).toBe('no-responses')
    expect(verdict.transient).toBe(true)
    expect(verdict.reachesQuorum).toBe(false)
  })

  it('refuses when nothing was consulted at all', () => {
    const verdict = evaluateRpcQuorum([])

    expect(verdict.status).toBe('insufficient-providers')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.independentProviders).toBe(0)
  })

  it('surfaces a real disagreement even on a thinly configured chain', () => {
    const verdict = evaluateRpcQuorum([
      ok('https://a.alchemy.com/x'),
      ok('https://b.alchemy.com/x', { value: OTHER_CODE }),
    ])

    expect(verdict.status).toBe('disagreement')
  })
})

describe('evaluateRpcQuorum — a well-formed empty answer', () => {
  it('does not grade agreed-nothing-there as a verified read', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY, { value: '0x' }),
      ok(INFURA, { value: '0x' }),
    ])

    expect(verdict.status).toBe('agreed-absent')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.agreedValue).toBe('0x')
  })

  it('treats an all-zero word the same way', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY, { value: `0x${'0'.repeat(64)}` }),
      ok(INFURA, { value: `0x${'0'.repeat(64)}` }),
    ])

    expect(verdict.status).toBe('agreed-absent')
    expect(verdict.reachesQuorum).toBe(false)
  })

  it('is not retried, since the providers already agree', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY, { value: '0x' }),
      ok(INFURA, { value: '0x' }),
    ])

    expect(planQuorumRetry(verdict, 1).retry).toBe(false)
  })
})

describe('evaluateRpcQuorum — the quorum itself', () => {
  it('refuses a quorum that would switch the control off', () => {
    const verdict = evaluateRpcQuorum([ok(ALCHEMY)], 1)

    expect(verdict.status).toBe('quorum-misconfigured')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.detail).toContain(String(MIN_INDEPENDENT_PROVIDERS))
  })

  it('honours a quorum above the minimum', () => {
    const three = [ok(ALCHEMY), ok(INFURA), ok(ANKR)]

    expect(evaluateRpcQuorum(three, 3).status).toBe('agreed')
    expect(evaluateRpcQuorum(three.slice(0, 2), 3).status).toBe(
      'insufficient-providers'
    )
  })

  it('reports zero agreeing providers wherever no agreement was reached', () => {
    const cases: [TQuorumStatus, IRpcQuorumVerdict][] = [
      [
        'disagreement',
        evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { value: OTHER_CODE })]),
      ],
      [
        'fork-divergence',
        evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { blockHash: OTHER_HASH })]),
      ],
      [
        'heights-not-aligned',
        evaluateRpcQuorum([
          ok(ALCHEMY),
          ok(INFURA, { blockNumber: BLOCK - 1n }),
        ]),
      ],
      ['insufficient-providers', evaluateRpcQuorum([ok(ALCHEMY)])],
      [
        'insufficient-responses',
        evaluateRpcQuorum([ok(ALCHEMY), failed(INFURA)]),
      ],
      ['no-responses', evaluateRpcQuorum([failed(ALCHEMY), failed(INFURA)])],
      ['quorum-misconfigured', evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)], 0)],
    ]

    for (const [status, verdict] of cases) {
      expect(verdict.status).toBe(status)
      expect(verdict.reachesQuorum).toBe(false)
      expect(verdict.agreeingProviders).toBe(0)
    }
  })

  it('still reports the agreement when providers agree nothing is there', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY, { value: '0x' }),
      ok(INFURA, { value: '0x' }),
    ])

    expect(verdict.status).toBe('agreed-absent')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.agreeingProviders).toBe(2)
  })
})

describe('planQuorumRetry', () => {
  it('backs off exponentially and caps the wait', () => {
    const verdict = evaluateRpcQuorum([failed(ALCHEMY), failed(INFURA)])
    const policy = { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 300 }

    expect(planQuorumRetry(verdict, 1, policy).delayMs).toBe(100)
    expect(planQuorumRetry(verdict, 2, policy).delayMs).toBe(200)
    expect(planQuorumRetry(verdict, 3, policy).delayMs).toBe(300)
    expect(planQuorumRetry(verdict, 4, policy).delayMs).toBe(300)
  })

  it('stops at the bounded maximum', () => {
    const verdict = evaluateRpcQuorum([failed(ALCHEMY), failed(INFURA)])
    const plan = planQuorumRetry(
      verdict,
      DEFAULT_QUORUM_RETRY_POLICY.maxAttempts
    )

    expect(plan.retry).toBe(false)
    expect(plan.reason).toContain('bounded maximum')
  })

  it('does not retry a shortfall of configured providers', () => {
    expect(planQuorumRetry(evaluateRpcQuorum([ok(ALCHEMY)]), 1).retry).toBe(
      false
    )
  })

  it('retries a green verdict never', () => {
    expect(
      planQuorumRetry(evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)]), 1).retry
    ).toBe(false)
  })
})

describe('resolveRpcQuorum', () => {
  const policy = { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 40 }

  it('retries a transient failure and settles on the agreed read', async () => {
    const waited: number[] = []
    const resolution = await resolveRpcQuorum(
      async (attempt) =>
        attempt === 1
          ? [failed(ALCHEMY), failed(INFURA)]
          : [ok(ALCHEMY), ok(INFURA)],
      {
        policy,
        sleep: async (ms) => {
          waited.push(ms)
        },
      }
    )

    expect(resolution.attempts).toBe(2)
    expect(resolution.verdict.status).toBe('agreed')
    expect(resolution.delaysMs).toEqual([10])
    expect(waited).toEqual([10])
  })

  it('gives up after the bounded number of attempts and still blocks', async () => {
    const resolution = await resolveRpcQuorum(
      async () => [failed(ALCHEMY), failed(INFURA)],
      { policy, sleep: async () => undefined }
    )

    expect(resolution.attempts).toBe(3)
    expect(resolution.delaysMs).toEqual([10, 20])
    expect(resolution.verdict.reachesQuorum).toBe(false)
  })

  it('actually waits when no sleep is injected', async () => {
    const started = Date.now()
    await resolveRpcQuorum(async () => [failed(ALCHEMY), failed(INFURA)], {
      policy: { maxAttempts: 2, initialDelayMs: 30, maxDelayMs: 30 },
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  it('does not re-read after a disagreement', async () => {
    let calls = 0
    const resolution = await resolveRpcQuorum(
      async () => {
        calls += 1
        return [ok(ALCHEMY), ok(INFURA, { value: OTHER_CODE })]
      },
      { policy, sleep: async () => undefined }
    )

    expect(calls).toBe(1)
    expect(resolution.verdict.status).toBe('disagreement')
  })
})

describe('renderRpcQuorum', () => {
  it('prints the refusal, the status and every provider consulted', () => {
    const lines = renderRpcQuorum(
      evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { value: OTHER_CODE })]),
      'codehash of 0xabc on mainnet'
    )
    const text = lines.join('\n')

    expect(text).toContain('NO QUORUM')
    expect(text).toContain('disagreement')
    expect(text).toContain('alchemy.com')
    expect(text).toContain('infura.io')
  })

  it('prints a line on success too, so silence never means verified', () => {
    const lines = renderRpcQuorum(
      evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)]),
      'codehash of 0xabc on mainnet'
    )

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('QUORUM')
  })

  it('names the reason a provider was not counted', () => {
    const lines = renderRpcQuorum(
      evaluateRpcQuorum([ok(ALCHEMY), failed(INFURA, 'HTTP 429')]),
      'codehash of 0xabc on mainnet'
    )

    expect(lines.join('\n')).toContain('not counted')
    expect(lines.join('\n')).toContain('HTTP 429')
  })

  it('never prints an endpoint URL, whatever the verdict', () => {
    const secret = 'SUPER_SECRET_KEY_VALUE'
    const verdicts = [
      evaluateRpcQuorum([ok(KEYED_URL), ok(INFURA)]),
      evaluateRpcQuorum([ok(KEYED_URL), ok(INFURA, { value: OTHER_CODE })]),
      evaluateRpcQuorum([failed(KEYED_URL, `request to ${KEYED_URL} failed`)]),
      evaluateRpcQuorum([ok(KEYED_URL)]),
    ]

    for (const verdict of verdicts) {
      const text = renderRpcQuorum(verdict, 'a read').join('\n')
      expect(text).not.toContain(secret)
      expect(text).not.toContain('https://')
    }
  })
})

describe('assertRpcQuorum', () => {
  it('lets an agreed read through', () => {
    expect(() =>
      assertRpcQuorum(evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)]), 'a read')
    ).not.toThrow()
  })

  it('throws on every non-green status, transient ones included', () => {
    const verdicts = [
      evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { value: OTHER_CODE })]),
      evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { blockHash: OTHER_HASH })]),
      evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { blockNumber: BLOCK - 1n })]),
      evaluateRpcQuorum([ok(ALCHEMY)]),
      evaluateRpcQuorum([ok(ALCHEMY), failed(INFURA)]),
      evaluateRpcQuorum([failed(ALCHEMY), failed(INFURA)]),
      evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)], 1),
      evaluateRpcQuorum([
        ok(ALCHEMY, { value: '0x' }),
        ok(INFURA, { value: '0x' }),
      ]),
    ]

    for (const verdict of verdicts)
      expect(() => assertRpcQuorum(verdict, 'a read')).toThrow(
        /refusing to believe/
      )
  })

  it('names the status in the refusal', () => {
    expect(() =>
      assertRpcQuorum(
        evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA, { value: OTHER_CODE })]),
        'codehash of 0xabc on mainnet'
      )
    ).toThrow(/disagreement/)
  })
})

describe('evaluateQuorumCoverage', () => {
  const endpoints = {
    mainnet: [ALCHEMY, INFURA],
    arbitrum: ['https://a.alchemy.com/x', 'https://b.alchemy.com/x'],
    obscurechain: ['https://rpc.obscurechain.io'],
    deadchain: [],
  }

  it('names every network that cannot reach quorum', () => {
    const report = evaluateQuorumCoverage(endpoints, 'fixture')

    expect(report.below.map((entry) => entry.network)).toEqual([
      'arbitrum',
      'deadchain',
      'obscurechain',
    ])
    expect(
      report.networks.find((entry) => entry.network === 'mainnet')
        ?.reachesQuorum
    ).toBe(true)
  })

  it('counts providers, not endpoints', () => {
    const report = evaluateQuorumCoverage(endpoints, 'fixture')
    const arbitrum = report.networks.find(
      (entry) => entry.network === 'arbitrum'
    )

    expect(arbitrum?.endpoints).toBe(2)
    expect(arbitrum?.independentProviders).toBe(1)
  })

  it('does not count a bare-IP identity as a provider that can reach quorum', () => {
    const report = evaluateQuorumCoverage(
      { mainnet: [ALCHEMY, 'https://198.51.100.4/'] },
      'fixture'
    )
    const mainnet = report.networks.find((entry) => entry.network === 'mainnet')

    expect(mainnet?.providers).toContain(IP_LITERAL_IDENTITY)
    expect(mainnet?.independentProviders).toBe(1)
    expect(mainnet?.reachesQuorum).toBe(false)
  })

  it('prints the count and the list, never the count alone', () => {
    const lines = renderQuorumCoverage(
      evaluateQuorumCoverage(endpoints, 'fixture')
    )
    const text = lines.join('\n')

    expect(text).toContain('1/4')
    expect(text).toContain('arbitrum')
    expect(text).toContain('deadchain')
    expect(text).toContain('obscurechain')
  })

  it('says so plainly when every network is covered', () => {
    const lines = renderQuorumCoverage(
      evaluateQuorumCoverage({ mainnet: [ALCHEMY, INFURA] }, 'fixture')
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1/1')
  })
})

describe('an IP alias cannot manufacture a quorum', () => {
  it('refuses when an endpoint names its host as a bare IP address', () => {
    // The attack a writable endpoint list makes cheap: an IP alias of a node
    // the proposer already controls, which no URL can distinguish from a second
    // provider.
    const verdict = evaluateRpcQuorum([
      ok('https://rpc.attacker-controlled.com/'),
      ok('http://203.0.113.7:8545/'),
    ])

    expect(verdict.status).toBe('provider-identity-unverifiable')
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.agreeingProviders).toBe(0)
    expect(verdict.transient).toBe(false)
    expect(() => assertRpcQuorum(verdict, 'codehash on mainnet')).toThrow()
  })

  it('agrees after a declared IP-and-hostname merge, whichever order they arrive in', () => {
    const ip = ok('http://203.0.113.7:8545/', { providerId: 'alchemy' })
    const named = ok(ALCHEMY, { providerId: 'alchemy' })
    const other = ok(INFURA)

    expect(evaluateRpcQuorum([ip, named, other]).status).toBe('agreed')
    expect(evaluateRpcQuorum([named, ip, other]).status).toBe('agreed')
  })

  it('still reaches a quorum on two hostname endpoints of different providers', () => {
    // Paired presence: refusing an address must not refuse the ordinary case,
    // or the control is a blanket refusal.
    const verdict = evaluateRpcQuorum([ok(ALCHEMY), ok(INFURA)])

    expect(verdict.status).toBe('agreed')
    expect(verdict.reachesQuorum).toBe(true)
    expect(verdict.agreeingProviders).toBe(2)
  })

  it('refuses an all-IP endpoint list rather than counting the addresses apart', () => {
    const verdict = evaluateRpcQuorum([
      ok('http://203.0.113.7:8545/'),
      ok('http://198.51.100.4:8545/'),
    ])

    expect(verdict.status).toBe('provider-identity-unverifiable')
    expect(verdict.reachesQuorum).toBe(false)
  })
})

describe('a coverage figure never travels without its source', () => {
  it('renders the source it measured, so a bare number cannot be quoted as a fleet fact', () => {
    // The field existed, was required, and was assigned — and nothing rendered
    // it, which is the whole reason it exists.
    const lines = renderQuorumCoverage(
      evaluateQuorumCoverage({ mainnet: [ALCHEMY, INFURA] }, 'MY-SOURCE')
    )

    expect(lines.join('\n')).toContain('MY-SOURCE')
  })

  it('renders it on the refusing line too, not only the green one', () => {
    const lines = renderQuorumCoverage(
      evaluateQuorumCoverage({ mainnet: [ALCHEMY] }, 'MY-SOURCE')
    )

    expect(lines.join('\n')).toContain('MY-SOURCE')
  })
})

describe('where the identity refusal sits among the other verdicts', () => {
  const forked = (url: string) =>
    ok(url, { blockHash: '0xaaaa', value: '0xcode' })

  it('is settled before a fork, because a fork verdict rests on the provider count', () => {
    // Not an arbitrary order: every verdict below this one reads a provider
    // count, and an identity nobody can establish makes that count unsound
    // rather than merely thin.
    const verdict = evaluateRpcQuorum([
      forked(ALCHEMY),
      ok(INFURA, { blockHash: '0xbbbb', value: '0xcode' }),
      ok('http://203.0.113.7:8545/'),
    ])

    expect(verdict.status).toBe('provider-identity-unverifiable')
  })

  it('is settled before a disagreement, for the same reason', () => {
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY, { value: '0xcode' }),
      ok(INFURA, { value: '0xOTHER' }),
      ok('http://203.0.113.7:8545/'),
    ])

    expect(verdict.status).toBe('provider-identity-unverifiable')
  })

  it('is settled after a misconfigured quorum, which is the caller-bug case', () => {
    // Paired presence: a below-minimum quorum is a caller defect that must
    // surface whatever the endpoint list looks like, so it stays first.
    const verdict = evaluateRpcQuorum(
      [ok(ALCHEMY), ok('http://203.0.113.7:8545/')],
      1
    )

    expect(verdict.status).toBe('quorum-misconfigured')
  })

  it('is settled before an outage, because a retry cannot make an identity knowable', () => {
    // Everything errored and one endpoint is an address. Reported as an outage
    // this is transient and retried; reported as an unknowable identity it is
    // not, which is the truth — another attempt returns the same endpoint list.
    const verdict = evaluateRpcQuorum([
      failed(ALCHEMY),
      failed('http://203.0.113.7:8545/'),
    ])

    expect(verdict.status).toBe('provider-identity-unverifiable')
    expect(verdict.transient).toBe(false)
    expect(planQuorumRetry(verdict, 1).retry).toBe(false)
  })

  it('refuses on a consulted IP endpoint even when it did not answer', () => {
    // Deliberately keyed on every endpoint consulted, not only the answering
    // ones: a check that fires only when the bad endpoint happens to respond
    // would refuse one read and green the next on an identical configuration.
    const verdict = evaluateRpcQuorum([
      ok(ALCHEMY),
      ok(INFURA),
      failed('http://203.0.113.7:8545/', 'connection reset'),
    ])

    expect(verdict.status).toBe('provider-identity-unverifiable')
    expect(verdict.reachesQuorum).toBe(false)
  })
})
