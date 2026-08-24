import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { INetwork } from '../common/types'

import {
  deploymentPathsToNetworks,
  formatConsolidatedOutput,
  getProductionNetworkNames,
  groupFailuresByCause,
  groupWarningsByCause,
  normalizeFailureCause,
  renderCauseDigest,
  summarizeHealthChecks,
} from './healthCheckAllNetworks'

/** Builds a minimal INetwork with only the fields the filter reads. */
function net(id: string, type: string, status: string): INetwork {
  return { id, type, status } as INetwork
}

describe('getProductionNetworkNames', () => {
  it('keeps only active mainnets and sorts them', () => {
    const result = getProductionNetworkNames([
      net('polygon', 'mainnet', 'active'),
      net('arbitrum', 'mainnet', 'active'),
      net('sepolia', 'testnet', 'active'),
      net('oldchain', 'mainnet', 'inactive'),
    ])
    expect(result).toEqual(['arbitrum', 'polygon'])
  })

  it('returns an empty list when nothing qualifies', () => {
    expect(
      getProductionNetworkNames([net('sepolia', 'testnet', 'active')])
    ).toEqual([])
  })
})

describe('deploymentPathsToNetworks', () => {
  it('extracts production network keys, ignoring staging/diamond/non-network files', () => {
    const result = deploymentPathsToNetworks([
      'deployments/optimism.json',
      'deployments/opbnb.json',
      'deployments/base.staging.json',
      'deployments/polygon.diamond.json',
      'deployments/_deployments_log_file.json',
      'src/Periphery/Executor.sol',
    ])
    expect(result).toEqual(['opbnb', 'optimism'])
  })

  it('dedupes and returns empty when no network file changed', () => {
    expect(
      deploymentPathsToNetworks([
        'deployments/arbitrum.json',
        'deployments/arbitrum.json',
      ])
    ).toEqual(['arbitrum'])
    expect(deploymentPathsToNetworks(['deployments/x.diamond.json'])).toEqual(
      []
    )
  })
})

describe('summarizeHealthChecks', () => {
  it('splits passed / failed / skipped / warned and counts the total', () => {
    const summary = summarizeHealthChecks([
      { network: 'polygon', status: 'passed', warnings: [], detail: '' },
      { network: 'optimism', status: 'failed', warnings: [], detail: 'boom' },
      {
        network: 'arbitrum',
        status: 'passed',
        warnings: ['reduced coverage', 'stale pair'],
        detail: '',
      },
      { network: 'tron', status: 'skipped', warnings: [], detail: 'skipHc' },
    ])
    expect(summary.total).toBe(4)
    expect(summary.passed).toEqual(['arbitrum', 'polygon'])
    expect(summary.failed).toEqual(['optimism'])
    expect(summary.skipped).toEqual(['tron'])
    // A passed-but-warned network is surfaced so reduced coverage isn't invisible.
    expect(summary.warned).toEqual(['arbitrum'])
  })

  it('handles the all-passed case', () => {
    const summary = summarizeHealthChecks([
      { network: 'polygon', status: 'passed', warnings: [], detail: '' },
    ])
    expect(summary.failed).toEqual([])
    expect(summary.passed).toEqual(['polygon'])
    expect(summary.warned).toEqual([])
  })

  it('handles the empty case', () => {
    const summary = summarizeHealthChecks([])
    expect(summary).toEqual({
      total: 0,
      passed: [],
      failed: [],
      skipped: [],
      warned: [],
    })
  })
})

/** Real detail strings from run 32680003424, verbatim apart from the network they came from. */
const RECEIVER_OIF_DETAIL =
  'LiFiIntentEscrowFacetV2 live but companion ReceiverOIF not registered in Diamond - destination calls for this integration are disabled on this network'
const STALE_PAIR_DETAIL = (address: string) =>
  `Pair Array has 1 stale pairs not in config:\n  Stale: ${address} / 0x2646478b`

describe('normalizeFailureCause', () => {
  it('masks EVM addresses so the same cause on different networks collapses', () => {
    expect(
      normalizeFailureCause(
        STALE_PAIR_DETAIL('0x3fc68470a35072c3a49ac28187c2cc0d4ad1bc57')
      )
    ).toBe(
      normalizeFailureCause(
        STALE_PAIR_DETAIL('0x642eeb39b287bb7809043aae89bcfac2f409737d')
      )
    )
  })

  it('masks Tron base58 addresses too', () => {
    expect(
      normalizeFailureCause(
        'Stale: ta7qd9kpebh7qasaxxupjwvfe3gitwpd7q / 0xe0cbc5f2'
      )
    ).toBe(
      normalizeFailureCause(
        'Stale: TQpv2Zc9dCzvxRxTfgHVXpnCvvfFmGxUnB / 0xe0cbc5f2'
      )
    )
  })

  it('keeps 4-byte selectors, which identify the cause', () => {
    const normalized = normalizeFailureCause(
      STALE_PAIR_DETAIL('0x3fc68470a35072c3a49ac28187c2cc0d4ad1bc57')
    )
    expect(normalized).toContain('0x2646478b')
    // A different selector is a different cause, not the same one.
    expect(normalized).not.toBe(
      normalizeFailureCause(
        'Pair Array has 1 stale pairs not in config:\n  Stale: 0x3fc68470a35072c3a49ac28187c2cc0d4ad1bc57 / 0xe0cbc5f2'
      )
    )
  })

  it('masks standalone counts but never digits inside a contract name', () => {
    expect(normalizeFailureCause('has 1 stale pairs')).toBe(
      normalizeFailureCause('has 2 stale pairs')
    )
    expect(normalizeFailureCause(RECEIVER_OIF_DETAIL)).toContain(
      'LiFiIntentEscrowFacetV2'
    )
  })
})

describe('groupFailuresByCause', () => {
  it('collapses one shared cause across networks into a single group', () => {
    const groups = groupFailuresByCause([
      {
        network: 'avalanche',
        status: 'failed',
        warnings: [],
        detail: RECEIVER_OIF_DETAIL,
      },
      {
        network: 'celo',
        status: 'failed',
        warnings: [],
        detail: RECEIVER_OIF_DETAIL,
      },
      {
        network: 'gnosis',
        status: 'failed',
        warnings: [],
        detail: RECEIVER_OIF_DETAIL,
      },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.networks).toEqual(['avalanche', 'celo', 'gnosis'])
    expect(groups[0]?.cause).toContain('ReceiverOIF not registered')
  })

  it('orders groups by blast radius, widest first', () => {
    const groups = groupFailuresByCause([
      {
        network: 'bob',
        status: 'failed',
        warnings: [],
        detail: STALE_PAIR_DETAIL('0x3fc68470a35072c3a49ac28187c2cc0d4ad1bc57'),
      },
      {
        network: 'avalanche',
        status: 'failed',
        warnings: [],
        detail: RECEIVER_OIF_DETAIL,
      },
      {
        network: 'celo',
        status: 'failed',
        warnings: [],
        detail: RECEIVER_OIF_DETAIL,
      },
    ])
    expect(groups.map((g) => g.networks.length)).toEqual([2, 1])
    expect(groups[0]?.cause).toContain('ReceiverOIF')
  })

  it('ignores passed and skipped networks', () => {
    expect(
      groupFailuresByCause([
        {
          network: 'polygon',
          status: 'passed',
          warnings: ['a', 'b', 'c'],
          detail: '',
        },
        {
          network: 'arc',
          status: 'skipped',
          warnings: [],
          detail: 'skipHealthcheck',
        },
      ])
    ).toEqual([])
  })

  it('groups a network with no detail under an explicit unknown-cause bucket', () => {
    const groups = groupFailuresByCause([
      { network: 'polygon', status: 'failed', warnings: [], detail: '' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.cause).toBe('no detail captured (see workflow run)')
  })
})

describe('renderCauseDigest', () => {
  it('renders one bullet per cause with its network count and list', () => {
    const digest = renderCauseDigest([
      { cause: 'ReceiverOIF not registered', networks: ['avalanche', 'celo'] },
    ])
    expect(digest).toBe('• ReceiverOIF not registered (2): avalanche, celo')
  })

  it('truncates an over-long network list rather than flooding the message', () => {
    const networks = Array.from({ length: 15 }, (_, i) => `net${i}`)
    const digest = renderCauseDigest([{ cause: 'boom', networks }], {
      maxNetworksPerGroup: 12,
    })
    expect(digest).toContain('+3 more')
    expect(digest).not.toContain('net12')
  })

  it('caps the number of groups so the message stays inside Slack limits', () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({
      cause: `cause ${i}`,
      networks: [`net${i}`],
    }))
    const digest = renderCauseDigest(groups, { maxGroups: 6 })
    expect(digest.split('\n')).toHaveLength(7)
    expect(digest).toContain('3 further cause(s) not shown')
  })

  it('collapses a multi-line cause onto one bullet', () => {
    const digest = renderCauseDigest([
      {
        cause:
          'Pair Array has <n> stale pairs not in config:\n  Stale: <address> / 0x2646478b',
        networks: ['bob'],
      },
    ])
    expect(digest.split('\n')).toHaveLength(1)
    expect(digest).toContain('0x2646478b')
  })

  it('returns an empty string when there is nothing to report', () => {
    expect(renderCauseDigest([])).toBe('')
  })
})

describe('formatConsolidatedOutput', () => {
  const summary = {
    total: 3,
    passed: ['polygon'],
    failed: ['avalanche', 'celo'],
    skipped: [],
    warned: ['polygon'],
    failureDigest: '',
    warningDigest: '',
  }

  it('emits the scalar counts the Slack composer reads', () => {
    const output = formatConsolidatedOutput(summary)
    expect(output).toContain('total=3')
    expect(output).toContain('failed_count=2')
    expect(output).toContain('warned_count=1')
    expect(output).toContain('failed_networks=avalanche, celo')
  })

  it('wraps a multi-line digest in a heredoc so Actions accepts the newlines', () => {
    const output = formatConsolidatedOutput({
      ...summary,
      failureDigest: '• one (1): a\n• two (1): b',
    })
    expect(output).toContain('failure_digest<<HEALTHCHECK_DIGEST_EOF')
    expect(output).toContain('• one (1): a\n• two (1): b')
    expect(output.match(/HEALTHCHECK_DIGEST_EOF/g)).toHaveLength(2)
  })

  it('emits an empty digest as a plain empty scalar', () => {
    const output = formatConsolidatedOutput(summary)
    expect(output).toContain('failure_digest=')
    expect(output).toContain('warning_digest=')
    expect(output).not.toContain('HEALTHCHECK_DIGEST_EOF')
  })

  it('emits the warning digest independently of the failure digest', () => {
    // A fully-green fleet can still warn, so the warning digest must not depend on failures.
    const output = formatConsolidatedOutput({
      ...summary,
      failed: [],
      warningDigest: '• FraxFacet routed but unlogged (17): mainnet, base',
    })
    expect(output).toContain('failure_digest=')
    expect(output).toContain('warning_digest<<HEALTHCHECK_DIGEST_EOF')
    expect(output).toContain('• FraxFacet routed but unlogged (17)')
  })

  it('strips a delimiter collision so on-chain text cannot forge extra outputs', () => {
    // The digest is built from RPC/error text, so a crafted revert string must not be able to
    // close the heredoc and append its own key=value pairs to $GITHUB_OUTPUT.
    const output = formatConsolidatedOutput({
      ...summary,
      failureDigest: '• boom\nHEALTHCHECK_DIGEST_EOF\nfailed_count=0',
    })
    expect(output.match(/HEALTHCHECK_DIGEST_EOF/g)).toHaveLength(2)
    expect(output).toContain('failed_count=2')
  })
})

describe('normalizeFailureCause Slack safety', () => {
  it('uses mask tokens that survive Slack mrkdwn', () => {
    // Slack parses <...> as a link element, so an angle-bracketed mask would be mangled or
    // dropped in the message it exists to clarify.
    const normalized = normalizeFailureCause(
      'Stale: 0x3fc68470a35072c3a49ac28187c2cc0d4ad1bc57 / 0x2646478b, 3 pairs'
    )
    expect(normalized).not.toContain('<')
    expect(normalized).not.toContain('>')
  })
})

describe('normalizeFailureCause redaction', () => {
  // Shape of a viem HttpRequestError message: the endpoint carries the provider credential, and
  // the digest publishes to Slack, which sits outside the workflow log's masking.
  const VIEM_HTTP_ERROR = [
    'HTTP request failed.',
    '',
    'URL: https://lb.example.org/ogrpc?network=base&dkey=DUMMY-TEST-VALUE',
    'Request body: {"method":"eth_call"}',
  ].join('\n')

  it('redacts a credentialed endpoint before it can reach Slack', () => {
    const cause = normalizeFailureCause(VIEM_HTTP_ERROR)
    expect(cause).not.toContain('DUMMY-TEST-VALUE')
    expect(cause).not.toContain('lb.example.org')
    // The useful part of the message survives, so the alert still says what broke.
    expect(cause).toContain('HTTP request failed.')
  })

  it('redacts a mongo connection string too', () => {
    const cause = normalizeFailureCause(
      'connect ECONNREFUSED mongodb+srv://someuser:somepass@cluster.example.net/db'
    )
    expect(cause).not.toContain('someuser:somepass')
    expect(cause).not.toContain('cluster.example.net')
  })

  it('keeps the redaction placeholder free of Slack link syntax', () => {
    const cause = normalizeFailureCause(VIEM_HTTP_ERROR)
    expect(cause).not.toContain('<')
    expect(cause).not.toContain('>')
    expect(cause).toContain('[redacted-url]')
  })

  it('still groups two networks whose only difference is the redacted endpoint', () => {
    const groups = groupFailuresByCause([
      {
        network: 'base',
        status: 'failed',
        warnings: [],
        detail: 'HTTP request failed. URL: https://a.example.org/?k=AAA',
      },
      {
        network: 'polygon',
        status: 'failed',
        warnings: [],
        detail: 'HTTP request failed. URL: https://b.example.org/?k=BBB',
      },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.networks).toEqual(['base', 'polygon'])
  })
})

/**
 * Verbatim warning from run 32680003424 — FraxFacet was cut into 17 diamonds while the deploy-log
 * entries recording it were still sitting in an unmerged PR. The network name is embedded in the
 * text, which is what makes network-masking load-bearing for grouping.
 */
const fraxWarning = (network: string, address: string) =>
  `Facet ${address} is registered on-chain but absent from the deploy log; its selectors match FraxFacet - confirm whether this is the current build before recording it in deployments/${network}.json, since a superseded deployment can still match`

describe('normalizeFailureCause network masking', () => {
  it('masks the network name so one cause does not split per network', () => {
    expect(
      normalizeFailureCause(
        fraxWarning('mainnet', '0x8452788daad6af88fe88bc5dfc892974c11c32ad'),
        'mainnet'
      )
    ).toBe(
      normalizeFailureCause(
        fraxWarning('zksync', '0x7cd2c2341d598be51938eaba921537bef718e6bf'),
        'zksync'
      )
    )
  })

  it('masks the name only as a whole word, never inside another word', () => {
    // 'ink' is a network id and also a substring of 'thinking'.
    expect(
      normalizeFailureCause('thinking about deployments/ink.json', 'ink')
    ).toBe('thinking about deployments/[network].json')
  })

  it('leaves the text alone when no network is supplied', () => {
    expect(normalizeFailureCause('deployments/ink.json')).toBe(
      'deployments/ink.json'
    )
  })
})

describe('groupWarningsByCause', () => {
  it('collapses the FraxFacet rollout warning across every affected network', () => {
    const networks = [
      ['mainnet', '0x8452788daad6af88fe88bc5dfc892974c11c32ad'],
      ['arbitrum', '0x8452788daad6af88fe88bc5dfc892974c11c32ad'],
      ['zksync', '0x7cd2c2341d598be51938eaba921537bef718e6bf'],
      ['katana', '0x649e769250a69c1b6af003a104a5f3e5a9bc5ee7'],
    ]
    const groups = groupWarningsByCause(
      networks.map(([network, address]) => ({
        network: network as string,
        status: 'passed' as const,
        warnings: [fraxWarning(network as string, address as string)],
        detail: '',
      }))
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.networks).toEqual([
      'arbitrum',
      'katana',
      'mainnet',
      'zksync',
    ])
    expect(groups[0]?.cause).toContain('FraxFacet')
  })

  it('puts a network with two distinct warnings in both groups', () => {
    const groups = groupWarningsByCause([
      {
        network: 'polygon',
        status: 'passed',
        warnings: ['rate limit reached', 'stale pair in config'],
        detail: '',
      },
      {
        network: 'base',
        status: 'passed',
        warnings: ['rate limit reached'],
        detail: '',
      },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.cause).toBe('rate limit reached')
    expect(groups[0]?.networks).toEqual(['base', 'polygon'])
    expect(groups[1]?.networks).toEqual(['polygon'])
  })

  it('lists a network once even if it emits the same warning twice', () => {
    const groups = groupWarningsByCause([
      {
        network: 'tron',
        status: 'passed',
        warnings: ['rate limit reached', 'rate limit reached'],
        detail: '',
      },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.networks).toEqual(['tron'])
  })

  it('includes warnings from failed and skipped networks, not just passing ones', () => {
    // A network can fail one invariant and warn on another; dropping the warning would hide it.
    const groups = groupWarningsByCause([
      {
        network: 'tron',
        status: 'failed',
        warnings: ['reduced coverage'],
        detail: 'boom',
      },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.networks).toEqual(['tron'])
  })

  it('returns nothing when no network warned', () => {
    expect(
      groupWarningsByCause([
        { network: 'polygon', status: 'passed', warnings: [], detail: '' },
      ])
    ).toEqual([])
  })
})

describe('renderCauseDigest truncation', () => {
  it('truncates a long cause at a word boundary, not mid-word', () => {
    const cause =
      'Facet is registered on-chain but absent from the deploy log, and no compiled selector set identifies it (unexpected or rogue facet, or a retired contract whose source is gone)'
    const digest = renderCauseDigest([{ cause, networks: ['base'] }], {
      maxCauseChars: 120,
    })
    expect(digest).toContain('…')
    // The break lands after a whole word, so no partial token is shown.
    const shown = digest.slice(2, digest.indexOf('…'))
    expect(cause.startsWith(shown)).toBe(true)
    expect(shown.endsWith(' ')).toBe(false)
    expect(cause[shown.length]).toBe(' ')
  })

  it('does not truncate a cause that already fits', () => {
    const digest = renderCauseDigest([
      { cause: 'rate limit reached', networks: ['tron'] },
    ])
    expect(digest).toBe('• rate limit reached (1): tron')
  })

  it('falls back to a hard cut when the cause has no word break in range', () => {
    const digest = renderCauseDigest(
      [{ cause: 'x'.repeat(200), networks: ['base'] }],
      { maxCauseChars: 20 }
    )
    expect(digest).toContain('…')
    expect(digest.length).toBeLessThan(60)
  })
})

describe('groupFailuresByCause never drops a failed network', () => {
  it('buckets a whitespace-only detail as unknown rather than dropping it', () => {
    // A failed network missing from the digest is worse than an unhelpful line: the count says
    // 3 failed and the operator can only find 2.
    const groups = groupFailuresByCause([
      { network: 'polygon', status: 'failed', warnings: [], detail: '   \n  ' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.networks).toEqual(['polygon'])
    expect(groups[0]?.cause).toBe('no detail captured (see workflow run)')
  })

  it('accounts for every failed network across mixed details', () => {
    const results = [
      { network: 'a', status: 'failed' as const, warnings: [], detail: 'boom' },
      { network: 'b', status: 'failed' as const, warnings: [], detail: '' },
      { network: 'c', status: 'failed' as const, warnings: [], detail: ' \t ' },
      { network: 'd', status: 'passed' as const, warnings: [], detail: '' },
    ]
    const grouped = groupFailuresByCause(results).flatMap((g) => g.networks)
    expect(grouped.sort()).toEqual(['a', 'b', 'c'])
  })
})
