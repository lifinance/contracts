/**
 * Exercises `rpc-quorum.ts` against live chain state and against real repo
 * config, so the module's refusals can be shown firing rather than asserted.
 * Run it to reproduce the WP-4.2 acceptance evidence; nothing here writes
 * anything or is imported by production code.
 *
 * Read-only: it issues `eth_getBlockByNumber` and `eth_getCode` against public
 * endpoints passed on the command line, and reads `config/networks.json`.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { createPublicClient, http, type Address, type Hex } from 'viem'

import networks from '../../../config/networks.json'

import type { IProviderObservation } from './rpc-quorum'
import {
  evaluateQuorumCoverage,
  evaluateRpcQuorum,
  renderQuorumCoverage,
  renderRpcQuorum,
  resolveRpcQuorum,
} from './rpc-quorum'

/** Two independent public providers, enough for a quorum of two. */
const DEFAULT_ENDPOINTS = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
]

const DEFAULT_ADDRESS = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'

/** Depth behind head at which the endpoints have all seen the same block. */
const SETTLED_BLOCK_DEPTH = 24n

const clientFor = (url: string) =>
  createPublicClient({ transport: http(url, { retryCount: 0 }) })

/**
 * Read one address's code at a pinned block from every endpoint.
 *
 * The block is pinned by the caller rather than left at `latest`, which is what
 * makes the answers comparable at all: two providers at different heights would
 * disagree for reasons that are not evidence of anything.
 *
 * @param endpoints - endpoint URLs to consult
 * @param address - address whose code is read
 * @param blockNumber - block every read is pinned to
 * @returns One observation per endpoint, failures included
 */
const observeCode = async (
  endpoints: readonly string[],
  address: Address,
  blockNumber: bigint
): Promise<IProviderObservation[]> =>
  Promise.all(
    endpoints.map(async (endpointUrl): Promise<IProviderObservation> => {
      try {
        const client = clientFor(endpointUrl)
        const [block, code] = await Promise.all([
          client.getBlock({ blockNumber }),
          client.getCode({ address, blockNumber }),
        ])

        return {
          endpointUrl,
          outcome: 'ok',
          value: code ?? '0x',
          blockNumber: block.number ?? blockNumber,
          blockHash: block.hash ?? '0x',
        }
      } catch (error) {
        return {
          endpointUrl,
          outcome: 'error',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )

const show = (title: string, lines: string[]): void => {
  consola.log(`\n── ${title}`)
  for (const line of lines) consola.log(line)
}

const main = defineCommand({
  meta: {
    name: 'rpc-quorum-demo',
    description: 'Demonstrates the RPC quorum verdicts on live chain state',
  },
  args: {
    address: { type: 'string', description: 'address whose code is read' },
    endpoints: {
      type: 'string',
      description: 'comma-separated endpoint URLs (at least two providers)',
    },
  },
  async run({ args }) {
    const endpoints = args.endpoints
      ? args.endpoints
          .split(',')
          .map((url) => url.trim())
          .filter(Boolean)
      : DEFAULT_ENDPOINTS
    const address = (args.address ?? DEFAULT_ADDRESS) as Address

    const head = await clientFor(endpoints[0] as string).getBlockNumber()
    const blockNumber = head - SETTLED_BLOCK_DEPTH
    consola.info(
      `reading code at ${address} at block ${blockNumber} from ${endpoints.length} endpoint(s)`
    )

    const observed = await observeCode(endpoints, address, blockNumber)
    const label = `codehash of ${address} on mainnet`

    show(
      '1 · live read, two independent providers',
      renderRpcQuorum(evaluateRpcQuorum(observed), label)
    )

    const lying = observed.map((observation, index) =>
      index === 0 && observation.outcome === 'ok'
        ? { ...observation, value: '0xdeadbeef' as Hex }
        : observation
    )
    show(
      '2 · one provider lies about the same block',
      renderRpcQuorum(evaluateRpcQuorum(lying), label)
    )

    show(
      '3 · only one provider consulted',
      renderRpcQuorum(evaluateRpcQuorum(observed.slice(0, 1)), label)
    )

    const lagging = observed.map((observation, index) =>
      index === 0 && observation.outcome === 'ok'
        ? { ...observation, blockNumber: blockNumber - 1n }
        : observation
    )
    show(
      '4 · providers answering at different heights',
      renderRpcQuorum(evaluateRpcQuorum(lagging), label)
    )

    const outage = await resolveRpcQuorum(
      async (attempt) => {
        consola.log(`  attempt ${attempt}: every provider unreachable`)
        return endpoints.map((endpointUrl) => ({
          endpointUrl,
          outcome: 'error' as const,
          error: 'connect ETIMEDOUT',
        }))
      },
      { policy: { maxAttempts: 3, initialDelayMs: 50, maxDelayMs: 200 } }
    )
    show(
      `5 · total outage, ${
        outage.attempts
      } bounded attempts (waits: ${outage.delaysMs.join(', ')} ms)`,
      renderRpcQuorum(outage.verdict, label)
    )

    show(
      '6 · fleet coverage from config/networks.json',
      renderQuorumCoverage(
        evaluateQuorumCoverage(
          Object.fromEntries(
            Object.entries(networks).map(([network, config]) => [
              network,
              [config.rpcUrl],
            ])
          )
        )
      )
    )
  },
})

runMain(main)
