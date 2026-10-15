/**
 * Remove one RPC endpoint from a chain in the `RpcEndpoints` collection, named by its host so the
 * operator never pastes a URL that carries an API key. Use it to drop dead or misconfigured
 * endpoints; run `bun fetch-rpcs` afterwards to regenerate the env file.
 *
 * Dry run unless `--apply` is passed. A host stored more than once on the chain is refused rather
 * than guessed at.
 */
import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { mongoEq } from '../deploy/shared/mongo-log-utils'

import {
  findEndpointsByHost,
  hasApiCredentials,
  hostOf,
  selectEndpoints,
  type IRpcEndpoint,
} from './rpcEndpoints'

const main = defineCommand({
  meta: {
    name: 'remove-network-rpc',
    description: 'Remove an RPC endpoint from the blockchain configuration',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name the endpoint is stored under',
      required: true,
    },
    host: {
      type: 'string',
      description:
        'Host of the endpoint to remove, as audit-rpc-priorities prints it',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment of the endpoint (default is production)',
      required: false,
      default: 'production',
    },
    apply: {
      type: 'boolean',
      description: 'Write the removal to MongoDB (default is a dry run)',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    const { network, host, environment } = args

    const MONGODB_URI = process.env.MONGODB_URI
    if (!MONGODB_URI) {
      consola.error('MONGODB_URI is not defined in the environment')
      process.exit(1)
    }

    const client = new MongoClient(MONGODB_URI)
    let exitCode = 0
    try {
      await client.connect()
      const collection = client
        .db('blockchain-configs')
        .collection('RpcEndpoints')

      const doc = await collection.findOne({ chainName: mongoEq(network) })
      if (!doc) throw new Error(`No RpcEndpoints document for "${network}"`)
      const rpcs: IRpcEndpoint[] = Array.isArray(doc.rpcs) ? doc.rpcs : []

      const matches = findEndpointsByHost(rpcs, host, environment)
      if (matches.length === 0)
        throw new Error(
          `${network} has no ${environment} endpoint on host "${host}". Run audit-rpc-priorities to list its hosts.`
        )
      if (matches.length > 1)
        throw new Error(
          `${network} has ${matches.length} ${environment} endpoints on host "${host}"; refusing to guess which one to remove`
        )

      const [target] = matches as [IRpcEndpoint]
      const remaining = selectEndpoints(
        rpcs.filter((rpc) => rpc !== target),
        environment
      )
      if (remaining.length === 0)
        throw new Error(
          `Removing ${host} would leave ${network} with no ${environment} endpoint; add a replacement first`
        )

      const label = `${network} [${environment}] ${hostOf(target.url)} p=${
        target.priority
      } (${hasApiCredentials(target.url) ? 'keyed' : 'no key'})`

      if (!args.apply) {
        consola.info(`Dry run — would remove ${label}`)
        consola.info(
          `Resulting order: ${remaining
            .map((rpc) => hostOf(rpc.url))
            .join(', ')}`
        )
        return
      }

      // Endpoints predating the environment field count as production, so a production removal
      // must also match a record with no environment, and must not touch the same URL stored for
      // another environment.
      const environmentMatch =
        environment === 'production'
          ? { $in: ['production', null] }
          : environment
      const result = await collection.updateOne(
        { chainName: mongoEq(network) },
        {
          $set: { lastUpdated: new Date() },
          $pull: {
            rpcs: { url: target.url, environment: environmentMatch },
          } as never,
        }
      )
      if (result.modifiedCount !== 1)
        throw new Error(`MongoDB reported no change while removing ${label}`)

      consola.success(`Removed ${label}`)
      consola.info(
        `Resulting order: ${remaining.map((rpc) => hostOf(rpc.url)).join(', ')}`
      )
    } catch (error) {
      consola.error(error instanceof Error ? error.message : error)
      exitCode = 1
    } finally {
      await client.close()
    }
    if (exitCode !== 0) process.exit(exitCode)
  },
})

runMain(main)
