/**
 * Audit — and optionally repair — the priority order of the `RpcEndpoints` collection.
 *
 * Reports which endpoint each chain currently resolves to and whether that endpoint carries
 * provider credentials. `--apply` rewrites priorities so every credentialed endpoint outranks
 * every uncredentialed one, preserving the existing relative order inside each group.
 *
 * Hosts are printed without their path or query string: an RPC URL routinely carries an API key.
 */
import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { mongoEq } from '../deploy/shared/mongo-log-utils'

import {
  hasApiCredentials,
  hostOf,
  prioritiesFor,
  repairOrder,
  selectEndpoints,
  type IRpcEndpoint,
} from './rpcEndpoints'

interface IChainAudit {
  chainName: string
  ordered: IRpcEndpoint[]
  repaired: IRpcEndpoint[]
  needsRepair: boolean
}

function auditChain(
  chainName: string,
  rpcs: IRpcEndpoint[],
  environment: string
): IChainAudit {
  const ordered = selectEndpoints(rpcs, environment)
  const repaired = repairOrder(ordered)
  return {
    chainName,
    ordered,
    repaired,
    needsRepair: ordered.some(
      (endpoint, i) => endpoint.url !== repaired[i]?.url
    ),
  }
}

function printChain(audit: IChainAudit) {
  const { chainName, ordered, repaired, needsRepair } = audit
  const marker = needsRepair ? '✗' : '✓'
  consola.log(`${marker} ${chainName}`)
  ordered.forEach((endpoint, index) => {
    const role = index === 0 ? 'primary ' : `fallback${index}`
    const keyed = hasApiCredentials(endpoint.url) ? 'keyed ' : 'NO KEY'
    consola.log(
      `    ${role} p=${String(endpoint.priority).padStart(4)} ${keyed} ${hostOf(
        endpoint.url
      )}`
    )
  })
  if (needsRepair)
    consola.log(
      `    -> would become: ${repaired
        .map((endpoint) => hostOf(endpoint.url))
        .join(' , ')}`
    )
}

const main = defineCommand({
  meta: {
    name: 'audit-rpc-priorities',
    description:
      'Report (and optionally repair) RPC endpoint priority order per network',
  },
  args: {
    environment: {
      type: 'string',
      description: 'Environment to audit (default is production)',
      required: false,
      default: 'production',
    },
    network: {
      type: 'string',
      description: 'Audit a single network instead of all of them',
      required: false,
    },
    apply: {
      type: 'boolean',
      description: 'Write the repaired priorities back to MongoDB',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    const MONGODB_URI = process.env.MONGODB_URI
    if (!MONGODB_URI) {
      consola.error('MONGODB_URI is not defined in the environment')
      process.exit(1)
    }

    const client = new MongoClient(MONGODB_URI)
    try {
      await client.connect()
      const collection = client
        .db('blockchain-configs')
        .collection('RpcEndpoints')

      const filter = args.network ? { chainName: mongoEq(args.network) } : {}
      const docs = await collection.find(filter).toArray()

      const audits = docs
        .filter((doc) => doc?.chainName && Array.isArray(doc?.rpcs))
        .map((doc) =>
          auditChain(
            doc.chainName,
            doc.rpcs as IRpcEndpoint[],
            args.environment
          )
        )
        .filter((audit) => audit.ordered.length > 0)
        .sort((a, b) => a.chainName.localeCompare(b.chainName))

      for (const audit of audits) printChain(audit)

      const broken = audits.filter((audit) => audit.needsRepair)
      consola.info(
        `${audits.length} network(s) audited [${args.environment}], ${broken.length} with an uncredentialed endpoint outranking a credentialed one`
      )

      if (!broken.length) return
      if (!args.apply) {
        consola.info(
          'Dry run — re-run with --apply to write the repaired order'
        )
        return
      }

      for (const audit of broken) {
        const priorities = prioritiesFor(audit.repaired.length)
        const byUrl = new Map(
          audit.repaired.map((endpoint, index) => [
            endpoint.url,
            priorities[index] as number,
          ])
        )
        const doc = await collection.findOne({
          chainName: mongoEq(audit.chainName),
        })
        const rpcs = (doc?.rpcs ?? []) as IRpcEndpoint[]
        const update: Record<string, unknown> = { lastUpdated: new Date() }
        rpcs.forEach((endpoint, index) => {
          const priority = byUrl.get(endpoint.url)
          if (priority !== undefined)
            update[`rpcs.${index}.priority`] = priority
        })
        await collection.updateOne(
          { chainName: mongoEq(audit.chainName) },
          { $set: update }
        )
        consola.success(
          `${audit.chainName}: primary is now ${hostOf(
            audit.repaired[0]?.url ?? ''
          )}`
        )
      }
    } catch (error) {
      consola.error('MongoDB operation failed:', error)
      process.exit(1)
    } finally {
      await client.close()
    }
  },
})

runMain(main)
