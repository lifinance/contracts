/**
 * Tests for the endpoint fan-out behind the sign-time quorum check.
 *
 * The grading is `rpc-quorum.ts`'s and is covered there; these pin the part
 * that decides what the grader is given — every endpoint consulted, and a
 * failing one recorded rather than dropped.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { evaluateRpcQuorum } from './rpc-quorum'
import {
  codeReadLabel,
  collectProviderObservations,
} from './rpc-quorum-collector'

/** A real 32-byte block hash: the shape a provider actually returns. */
const BLOCK_HASH = `0x${'ab'.repeat(32)}`

const answer = (value: string) => ({
  value,
  blockNumber: 100n,
  blockHash: BLOCK_HASH,
})

describe('collectProviderObservations', () => {
  it('consults every endpoint it is given', async () => {
    const seen: string[] = []
    const observations = await collectProviderObservations(
      ['https://a.example/rpc', 'https://b.example/rpc'],
      async (endpointUrl) => {
        seen.push(endpointUrl)
        return answer('0xcode')
      }
    )

    expect(seen).toHaveLength(2)
    expect(observations).toHaveLength(2)
    expect(observations.every((entry) => entry.outcome === 'ok')).toBe(true)
    expect(evaluateRpcQuorum(observations).reachesQuorum).toBe(true)
  })

  // A dropped endpoint would shrink the denominator, turning "one of two
  // providers failed" into "the only provider agreed".
  it('records a failing endpoint rather than dropping it', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc', 'https://b.example/rpc'],
      async (endpointUrl) => {
        if (endpointUrl.includes('b.example')) throw new Error('timed out')
        return answer('0xcode')
      }
    )

    expect(observations).toHaveLength(2)
    expect(observations[1]?.outcome).toBe('error')
    expect(evaluateRpcQuorum(observations).reachesQuorum).toBe(false)
  })

  it('a single-endpoint network cannot reach quorum', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc'],
      async () => answer('0xcode')
    )

    const verdict = evaluateRpcQuorum(observations)
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.status).toBe('insufficient-providers')
  })

  it('providers disagreeing on the value do not reach quorum', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc', 'https://b.example/rpc'],
      async (endpointUrl) =>
        answer(endpointUrl.includes('a.example') ? '0xcode' : '0xother')
    )

    expect(evaluateRpcQuorum(observations).reachesQuorum).toBe(false)
  })

  it('carries the block each answer describes, so answers stay comparable', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc'],
      async () => answer('0xcode')
    )

    expect(observations[0]?.blockNumber).toBe(100n)
    expect(observations[0]?.blockHash).toBe(BLOCK_HASH)
  })
})

describe('codeReadLabel', () => {
  it('names what was read and where, for the operator line', () => {
    const label = codeReadLabel(
      '0x1111111111111111111111111111111111111111',
      'arbitrum'
    )

    expect(label).toContain('0x1111111111111111111111111111111111111111')
    expect(label).toContain('arbitrum')
  })
})
