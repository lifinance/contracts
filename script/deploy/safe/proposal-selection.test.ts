/**
 * Tests for the card's proposal selection (EXSC-696).
 *
 * The properties that matter are the ones the shortfall warning rests on: the
 * newest row per network wins, a network the run did not touch never reaches the
 * card, every provenance field the card reads survives the mapping, and only a
 * network with no row in any status counts as missing.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { selectProposals, type IStoredProposal } from './proposal-selection'

const row = (
  network: string,
  overrides: Partial<IStoredProposal['provenance']> = {}
): IStoredProposal => ({
  network,
  safeTxHash: `0x${'ab'.repeat(32)}`,
  provenance: { reason: 'why', ...overrides },
})

describe('selectProposals', () => {
  it('keeps the caller order, not the query order', () => {
    // The card should read in the same order as the run's own output.
    const result = selectProposals(
      ['mainnet', 'arbitrum', 'base'],
      [row('base'), row('mainnet'), row('arbitrum')],
      []
    )

    expect(result.proposals.map((p) => p.network)).toEqual([
      'mainnet',
      'arbitrum',
      'base',
    ])
  })

  it('takes the first row per network, because the caller sorted newest first', () => {
    const result = selectProposals(
      ['mainnet'],
      [
        row('mainnet', { reason: 'newest' }),
        row('mainnet', { reason: 'older' }),
      ],
      []
    )

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.reason).toBe('newest')
  })

  it('classifies a network whose row exists but is not pending as settled', () => {
    // Its proposal was signed and executed, so its absence is correct. Counting
    // it as missing would fire the alarm on every resumed run — the runner's
    // network list is cumulative across resumes.
    const result = selectProposals(
      ['mainnet', 'arbitrum'],
      [row('mainnet')],
      ['arbitrum']
    )

    expect(result.settled).toEqual(['arbitrum'])
    expect(result.unaccounted).toEqual([])
  })

  it('classifies a network with no row at all as unaccounted', () => {
    const result = selectProposals(
      ['mainnet', 'arbitrum'],
      [row('mainnet')],
      []
    )

    expect(result.unaccounted).toEqual(['arbitrum'])
    expect(result.settled).toEqual([])
  })

  it('never puts a network in both buckets', () => {
    const result = selectProposals(
      ['a', 'b', 'c', 'd'],
      [row('a')],
      ['b', 'c', 'd']
    )

    const both = result.settled.filter((n) => result.unaccounted.includes(n))
    expect(both).toEqual([])
    expect([...result.settled, ...result.unaccounted].sort()).toEqual([
      'b',
      'c',
      'd',
    ])
  })

  it('ignores a pending row for a network the run did not touch', () => {
    // The query bounds by network, but a widened query must not silently add a
    // network to the card that the run never proposed on.
    const result = selectProposals(
      ['mainnet'],
      [row('mainnet'), row('base')],
      []
    )

    expect(result.proposals.map((p) => p.network)).toEqual(['mainnet'])
  })

  it('carries every provenance field the card reads', () => {
    const result = selectProposals(
      ['mainnet'],
      [
        row('mainnet', {
          dirtyTreeScoped: ['src/A.sol'],
          dirtyTreeTruncated: true,
          captureErrors: ['boom'],
          actor: 'bot',
          gitCommit: 'abc',
          prUrl: 'https://example.test/pull/1',
          proposerHandle: 'alice',
        }),
      ],
      []
    )

    // Each of these was a field the card silently lost at some point by not
    // being mapped here.
    const p = result.proposals[0]
    expect(p?.dirtyTreeScoped).toEqual(['src/A.sol'])
    expect(p?.dirtyTreeTruncated).toBe(true)
    expect(p?.captureErrors).toEqual(['boom'])
    expect(p?.actor).toBe('bot')
    expect(p?.gitCommit).toBe('abc')
    expect(p?.prUrl).toBe('https://example.test/pull/1')
    expect(p?.proposerHandle).toBe('alice')
  })

  it('survives a row with no provenance block', () => {
    const result = selectProposals(
      ['mainnet'],
      [{ network: 'mainnet', safeTxHash: '0xab' }],
      []
    )

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.reason).toBeUndefined()
  })
})
