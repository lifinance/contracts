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
  normalizeFailureCause,
  renderFailureDigest,
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
      { network: 'polygon', status: 'passed', warnings: 0, detail: '' },
      { network: 'optimism', status: 'failed', warnings: 0, detail: 'boom' },
      { network: 'arbitrum', status: 'passed', warnings: 2, detail: '' },
      { network: 'tron', status: 'skipped', warnings: 0, detail: 'skipHc' },
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
      { network: 'polygon', status: 'passed', warnings: 0, detail: '' },
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
        warnings: 0,
        detail: RECEIVER_OIF_DETAIL,
      },
      {
        network: 'celo',
        status: 'failed',
        warnings: 0,
        detail: RECEIVER_OIF_DETAIL,
      },
      {
        network: 'gnosis',
        status: 'failed',
        warnings: 0,
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
        warnings: 0,
        detail: STALE_PAIR_DETAIL('0x3fc68470a35072c3a49ac28187c2cc0d4ad1bc57'),
      },
      {
        network: 'avalanche',
        status: 'failed',
        warnings: 0,
        detail: RECEIVER_OIF_DETAIL,
      },
      {
        network: 'celo',
        status: 'failed',
        warnings: 0,
        detail: RECEIVER_OIF_DETAIL,
      },
    ])
    expect(groups.map((g) => g.networks.length)).toEqual([2, 1])
    expect(groups[0]?.cause).toContain('ReceiverOIF')
  })

  it('ignores passed and skipped networks', () => {
    expect(
      groupFailuresByCause([
        { network: 'polygon', status: 'passed', warnings: 3, detail: '' },
        {
          network: 'arc',
          status: 'skipped',
          warnings: 0,
          detail: 'skipHealthcheck',
        },
      ])
    ).toEqual([])
  })

  it('groups a network with no detail under an explicit unknown-cause bucket', () => {
    const groups = groupFailuresByCause([
      { network: 'polygon', status: 'failed', warnings: 0, detail: '' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.cause).toBe('no detail captured (see workflow run)')
  })
})

describe('renderFailureDigest', () => {
  it('renders one bullet per cause with its network count and list', () => {
    const digest = renderFailureDigest([
      { cause: 'ReceiverOIF not registered', networks: ['avalanche', 'celo'] },
    ])
    expect(digest).toBe('• ReceiverOIF not registered (2): avalanche, celo')
  })

  it('truncates an over-long network list rather than flooding the message', () => {
    const networks = Array.from({ length: 15 }, (_, i) => `net${i}`)
    const digest = renderFailureDigest([{ cause: 'boom', networks }], {
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
    const digest = renderFailureDigest(groups, { maxGroups: 6 })
    expect(digest.split('\n')).toHaveLength(7)
    expect(digest).toContain('3 further cause(s) not shown')
  })

  it('collapses a multi-line cause onto one bullet', () => {
    const digest = renderFailureDigest([
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
    expect(renderFailureDigest([])).toBe('')
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
    expect(output).not.toContain('HEALTHCHECK_DIGEST_EOF')
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
