/**
 * Audit — and optionally repair — the priority order of the `RpcEndpoints` collection.
 *
 * Reports which endpoint each chain currently resolves to, whether it carries provider
 * credentials, and (with `--probe`, implied by `--apply`) whether it actually answers.
 * `--apply` rewrites priorities where the chain resolves to the wrong primary, ranking a
 * reachable endpoint above an unreachable one and, among reachable endpoints, a credentialed one
 * above an uncredentialed one. Fallback order is reported but not rewritten.
 *
 * Hosts are printed without their path or query string: an RPC URL routinely carries an API key.
 */
import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { mongoEq } from '../deploy/shared/mongo-log-utils'
import { mapWithConcurrency } from '../utils/mapWithConcurrency'

import { probeEndpoint } from './probeEndpoint'
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
  /** The stored `rpcs` array, so a repair can address entries by their position in it. */
  rpcs: IRpcEndpoint[]
  ordered: IRpcEndpoint[]
  repaired: IRpcEndpoint[]
  needsRepair: boolean
}

/** Endpoints that answered the probe. An empty set means no probe was run. */
type ReachableUrls = Set<string> | undefined

const PROBE_CONCURRENCY = 6

function auditChain(
  chainName: string,
  rpcs: IRpcEndpoint[],
  environment: string,
  reachable: ReachableUrls
): IChainAudit {
  const ordered = selectEndpoints(rpcs, environment)
  const repaired = repairOrder(
    ordered,
    reachable ? (url) => reachable.has(url) : undefined
  )
  return {
    chainName,
    rpcs,
    ordered,
    repaired,
    // Only the primary is worth a write. Reachability is momentary and stored priority is durable
    // config, so ranking the whole list on a probe makes every run disagree with the last about
    // which flaky fallback goes where — churn that never settles. A misordered fallback costs one
    // failed request at runtime; the fallback transport moves past it.
    needsRepair: ordered[0]?.url !== repaired[0]?.url,
  }
}

/** Probe every distinct endpoint once, regardless of how many chains list it. */
async function probeAll(urls: string[]): Promise<Set<string>> {
  const distinct = [...new Set(urls)]
  consola.info(`Probing ${distinct.length} distinct endpoint(s)...`)
  const results = await mapWithConcurrency(
    distinct,
    PROBE_CONCURRENCY,
    async (url) => ({ url, ok: await probeEndpoint(url) })
  )
  return new Set(results.filter((r) => r.ok).map((r) => r.url))
}

function printChain(audit: IChainAudit, reachable: ReachableUrls) {
  const { chainName, ordered, repaired, needsRepair } = audit
  const marker = needsRepair ? '✗' : '✓'
  consola.log(`${marker} ${chainName}`)
  ordered.forEach((endpoint, index) => {
    const role = index === 0 ? 'primary ' : `fallback${index}`
    const keyed = hasApiCredentials(endpoint.url) ? 'keyed ' : 'NO KEY'
    const health = !reachable
      ? ''
      : reachable.has(endpoint.url)
      ? ' up  '
      : ' DOWN'
    consola.log(
      `    ${role} p=${String(endpoint.priority).padStart(
        4
      )} ${keyed}${health} ${hostOf(endpoint.url)}`
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
      description:
        'Write the repaired priorities back to MongoDB (implies --probe)',
      required: false,
      default: false,
    },
    probe: {
      type: 'boolean',
      description:
        'Check each endpoint answers eth_chainId and eth_getCode before ranking it',
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
      const usable = docs.filter(
        (doc) => doc?.chainName && Array.isArray(doc?.rpcs)
      )

      // --apply always probes: a credentialed endpoint can be expired or gone, and ranking one
      // above a chain's only working public endpoint takes that chain down.
      const reachable =
        args.apply || args.probe
          ? await probeAll(
              usable.flatMap((doc) =>
                selectEndpoints(
                  doc.rpcs as IRpcEndpoint[],
                  args.environment
                ).map((endpoint) => endpoint.url)
              )
            )
          : undefined

      const audits = usable
        .map((doc) =>
          auditChain(
            doc.chainName,
            doc.rpcs as IRpcEndpoint[],
            args.environment,
            reachable
          )
        )
        .filter((audit) => audit.ordered.length > 0)
        .sort((a, b) => a.chainName.localeCompare(b.chainName))

      for (const audit of audits) printChain(audit, reachable)

      const broken = audits.filter((audit) => audit.needsRepair)
      consola.info(
        `${audits.length} network(s) audited [${args.environment}], ${broken.length} resolving to the wrong primary`
      )
      if (reachable) {
        const stranded = audits.filter(
          (audit) =>
            audit.repaired.length > 0 &&
            !audit.repaired.some((endpoint) => reachable.has(endpoint.url))
        )
        if (stranded.length)
          consola.warn(
            `${
              stranded.length
            } network(s) have no reachable endpoint at all: ${stranded
              .map((audit) => audit.chainName)
              .join(', ')}`
          )
      }

      if (!broken.length) return
      if (!args.apply) {
        consola.info(
          'Dry run — re-run with --apply to write the repaired order'
        )
        return
      }

      for (const audit of broken) {
        const priorities = prioritiesFor(audit.repaired.length)
        // Keyed by position in the stored array, not by URL: a chain can list the same URL twice
        // (two keys on one host), and a URL-keyed map collapses those into one entry, leaving the
        // duplicates tied and the repair unable to converge.
        const update: Record<string, unknown> = { lastUpdated: new Date() }
        audit.repaired.forEach((endpoint, rank) => {
          const storedIndex = audit.rpcs.indexOf(endpoint)
          if (storedIndex !== -1)
            update[`rpcs.${storedIndex}.priority`] = priorities[rank] as number
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
