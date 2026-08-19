/**
 * CLI that prints the best usable RPC URL for a network on stdout.
 *
 * Called by `getRPCUrl` in `script/helperFunctions.sh` and by the deploy retry loop.
 * Candidates are gathered from the `ETH_NODE_URI_<NETWORK>` env var, the MongoDB
 * `RpcEndpoints` collection and `config/networks.json`, then probed and ranked by
 * `rpcFailover.ts`.
 *
 * stdout carries the resolved URL and nothing else, so callers can capture it with a
 * command substitution. Every diagnostic goes to stderr and is redacted to scheme+host.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import { MongoClient } from 'mongodb'

import networksConfig from '../../config/networks.json'
import { withSrvDnsFallback } from '../deploy/shared/mongo-srv-dns'

import {
  classifyForgeFailure,
  redactRpcUrl,
  resolveEndpoint,
} from './rpcFailover'
import { getRPCEnvVarName } from './utils'

config()

// Diagnostics must not pollute stdout: the caller reads stdout as the resolved URL.
const logger = consola.create({ stdout: process.stderr })

const MONGO_TIMEOUT_MS = 8_000 // 8 seconds; a deploy must not stall on config lookup

/**
 * Endpoints to skip arrive through the environment rather than a CLI flag: an RPC URL
 * passed as an argument is visible in the process table to every user on the machine.
 * Entries are newline-separated because a URL query string may legally contain commas.
 */
const EXCLUDE_ENV_VAR = 'LIFI_RPC_EXCLUDE'

/** Exit code telling the caller to retry on the same endpoint rather than switch. */
const EXIT_NO_FAILOVER = 3

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

interface IMongoRpc {
  url: string
  priority: number
}

/**
 * Reads the alternative endpoints recorded for a network.
 *
 * `isActive` is deliberately not used as a filter: it is unset on every document in the
 * collection, so filtering on it would discard all endpoints.
 *
 * @param network - Network key as used in `config/networks.json`
 * @returns Endpoints for the network, or an empty array when MongoDB is unreachable or
 *   has no document for it. Never throws — a config lookup must not break a deploy.
 */
async function fetchMongoRpcs(network: string): Promise<IMongoRpc[]> {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    logger.debug('MONGODB_URI is not set; skipping MongoDB endpoints')
    return []
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: MONGO_TIMEOUT_MS,
    connectTimeoutMS: MONGO_TIMEOUT_MS,
  })
  try {
    await withSrvDnsFallback(() => client.connect())
    const doc = await client
      .db('blockchain-configs')
      .collection('RpcEndpoints')
      // Connect and server-selection timeouts do not bound the query itself; without
      // this an established but unresponsive server would stall the deploy indefinitely.
      .findOne({ chainName: network }, { timeoutMS: MONGO_TIMEOUT_MS })

    if (!doc || !Array.isArray(doc.rpcs)) return []

    return doc.rpcs
      .filter(
        (entry: unknown): entry is IMongoRpc =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as IMongoRpc).url === 'string'
      )
      .map((entry) => ({
        url: entry.url,
        priority: Number.isFinite(entry.priority) ? entry.priority : 0,
      }))
  } catch {
    // The error text can quote the connection string, so it is never logged.
    logger.warn(
      'could not read RPC endpoints from MongoDB; using local sources'
    )
    return []
  } finally {
    await client.close().catch(() => undefined)
  }
}

const main = defineCommand({
  meta: {
    name: 'resolveRpcUrl',
    description: 'Print the best usable RPC URL for a network',
  },
  args: {
    network: {
      type: 'positional',
      description: 'Network key as used in config/networks.json',
      required: true,
    },
    'after-failure': {
      type: 'boolean',
      description:
        'Read a failed forge run from stdin and only resolve when the failure provably preceded any broadcast',
      required: false,
    },
  },
  async run({ args }) {
    const network = String(args.network)
    const envUrl = process.env[getRPCEnvVarName(network)]

    // Forge output arrives on stdin, not as an argument: it routinely quotes the full
    // RPC URL in transport errors, which would then be visible in the process table.
    if (args['after-failure']) {
      const failureClass = classifyForgeFailure(await readStdin())
      if (failureClass !== 'preBroadcast') {
        logger.info(
          `not switching RPC endpoint for '${network}': failure classified as ${failureClass}, a transaction may already be in flight`
        )
        process.exit(EXIT_NO_FAILOVER)
      }
    }
    const networksJsonUrl = (
      networksConfig as Record<string, { rpcUrl?: string } | undefined>
    )[network]?.rpcUrl

    const selection = await resolveEndpoint({
      envUrl,
      mongoRpcs: await fetchMongoRpcs(network),
      networksJsonUrl,
      exclude: [
        ...(process.env[EXCLUDE_ENV_VAR]?.split('\n') ?? []),
        // The endpoint that just failed must not be selected again.
        ...(args['after-failure'] && envUrl ? [envUrl] : []),
      ]
        .map((entry) => entry.trim())
        .filter(Boolean),
    })

    if (!selection) {
      logger.error(`no usable RPC endpoint found for network '${network}'`)
      process.exit(1)
    }

    // Capabilities are reported because a chain-wide gap explains a deploy failure that
    // no further failover can fix: no candidate serving eth_feeHistory, or none with a
    // 1559-deserializable block, means the chain needs legacy transactions.
    const missing = (
      ['feeHistory', 'eip1559Block', 'gasPrice'] as const
    ).filter((capability) => !selection.capabilities[capability])
    const chainWide = missing.filter(
      (capability) => !selection.chainCapabilities[capability]
    )

    logger.info(
      `resolved RPC for '${network}': ${redactRpcUrl(selection.url)} (source: ${
        selection.source
      })${missing.length ? `; endpoint lacks ${missing.join(', ')}` : ''}${
        chainWide.length
          ? `; no endpoint on this chain provides ${chainWide.join(', ')}`
          : ''
      }`
    )
    process.stdout.write(selection.url)
  },
})

void runMain(main)
