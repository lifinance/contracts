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

import { redactRpcUrl, resolveEndpoint } from './rpcFailover'
import { getRPCEnvVarName } from './utils'

config()

// Diagnostics must not pollute stdout: the caller reads stdout as the resolved URL.
const logger = consola.create({ stdout: process.stderr })

const MONGO_TIMEOUT_MS = 8_000 // 8 seconds; a deploy must not stall on config lookup

/**
 * Endpoints to skip arrive through the environment rather than a CLI flag: an RPC URL
 * passed as an argument is visible in the process table to every user on the machine.
 */
const EXCLUDE_ENV_VAR = 'LIFI_RPC_EXCLUDE'

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
      .findOne({ chainName: network })

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
  },
  async run({ args }) {
    const network = String(args.network)
    const envUrl = process.env[getRPCEnvVarName(network)]
    const networksJsonUrl = (
      networksConfig as Record<string, { rpcUrl?: string } | undefined>
    )[network]?.rpcUrl

    const selection = await resolveEndpoint({
      envUrl,
      mongoRpcs: await fetchMongoRpcs(network),
      networksJsonUrl,
      exclude: process.env[EXCLUDE_ENV_VAR]?.split(',').filter(Boolean),
    })

    if (!selection) {
      logger.error(`no usable RPC endpoint found for network '${network}'`)
      process.exit(1)
    }

    logger.info(
      `resolved RPC for '${network}': ${redactRpcUrl(selection.url)} (source: ${
        selection.source
      })`
    )
    process.stdout.write(selection.url)
  },
})

void runMain(main)
