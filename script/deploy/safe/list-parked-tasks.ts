/**
 * List Parked Diamond-Cleanup Tasks (read-only)
 *
 * Non-interactive view of the deferred diamond-cleanup queue
 * (`sc_private.parkedTasks`, design: PR #2049). Shows which facet removals are
 * parked per network, their status, age, and originating deprecation PR — so an
 * operator can see the backlog and audit the parked set without a live drain.
 * Mirrors list-pending-proposals.ts (citty/consola, `--json`, VPN-gated).
 *
 * Exit codes: 0 success (even with zero matches), 1 real error,
 * 2 recoverable misconfig (missing SC_MONGODB_URI / VPN not connected).
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'

import {
  getParkedTasksCollection,
  listParkedTasks,
  type IListParkedTasksFilter,
  type IParkedTask,
  type ParkedTaskStatus,
} from './parked-tasks'

dotenv.config()

const VALID_STATUSES = [
  'queued',
  'proposed',
  'executed',
  'cancelled',
  'superseded',
  'all',
] as const

/** Human-readable age (e.g. "3d 4h", "5h", "12m") from `createdAt` to now. */
function formatAge(createdAt: Date): string {
  const ms = Date.now() - new Date(createdAt).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

const main = defineCommand({
  meta: {
    name: 'list-parked-tasks',
    description:
      'List parked diamond-cleanup tasks from MongoDB grouped by network (read-only)',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Only show tasks for these networks (comma-separated, e.g. "arbitrum,base,mainnet")',
      required: false,
    },
    pr: {
      type: 'string',
      description: 'Only show tasks whose originating PR URL matches exactly',
      required: false,
    },
    status: {
      type: 'string',
      description: `Task status to list (${VALID_STATUSES.join(
        '|'
      )}), default: all`,
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Print machine-readable JSON to stdout instead of a table',
      default: false,
      required: false,
    },
  },
  async run({ args }) {
    const status = (args.status || 'all').toLowerCase()
    if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      consola.error(
        `Invalid status "${
          args.status
        }" - must be one of: ${VALID_STATUSES.join(', ')}`
      )
      process.exit(1)
    }

    const networks = args.network
      ? [
          ...new Set(
            args.network
              .split(',')
              .map((n: string) => n.trim().toLowerCase())
              .filter(Boolean)
          ),
        ]
      : undefined

    // JSON consumers parse stdout; suppress info/success but keep errors visible
    if (args.json) consola.level = 0

    let mongoClient
    let parkedTasks
    try {
      ;({ client: mongoClient, parkedTasks } = await getParkedTasksCollection())
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error(`Could not connect to Safe MongoDB: ${errorMsg}`)
      // missing env var or VPN are recoverable misconfigs, not hard errors
      if (
        errorMsg.includes('SC_MONGODB_URI') ||
        errorMsg.includes('VPN connection required')
      )
        process.exit(2)
      process.exit(1)
    }

    try {
      const base: IListParkedTasksFilter = {}
      if (args.pr) base.prUrl = args.pr
      if (status !== 'all') base.status = status as ParkedTaskStatus

      // One filtered read per requested network (reuses the store helper); a
      // single unfiltered read when no --network is given.
      const filters: IListParkedTasksFilter[] = networks?.length
        ? networks.map((network) => ({ ...base, network }))
        : [base]
      const tasks = (
        await Promise.all(filters.map((f) => listParkedTasks(parkedTasks, f)))
      )
        .flat()
        .sort(
          (a, b) =>
            a.network.localeCompare(b.network) ||
            a.facetName.localeCompare(b.facetName)
        )

      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ count: tasks.length, tasks }, null, 2)}\n`
        )
        return
      }

      if (!tasks.length) {
        consola.info(
          `No ${status === 'all' ? '' : `'${status}' `}parked tasks found${
            networks ? ` for: ${networks.join(', ')}` : ''
          }`
        )
        return
      }

      let currentNetwork = ''
      const perNetwork: Record<string, { queued: number; proposed: number }> =
        {}
      tasks.forEach((t: IParkedTask) => {
        if (t.network !== currentNetwork) {
          currentNetwork = t.network
          consola.info('')
          consola.info(`=== ${t.network} ===`)
        }
        const counts = (perNetwork[t.network] ??= { queued: 0, proposed: 0 })
        if (t.status === 'queued') counts.queued++
        if (t.status === 'proposed') counts.proposed++
        consola.info(
          [
            `${t.facetName}`,
            `status ${t.status}`,
            `age ${formatAge(t.createdAt)}`,
            `PR ${t.prUrl}`,
            `safeTxHash ${t.safeTxHash ?? '-'}`,
          ].join(' | ')
        )
      })

      consola.info('')
      for (const [network, counts] of Object.entries(perNetwork))
        consola.info(
          `${network}: ${counts.queued} queued, ${counts.proposed} proposed`
        )
      consola.success(`${tasks.length} parked task(s) listed`)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error(`Failed to query parked tasks: ${errorMsg}`)
      process.exit(1)
    } finally {
      // A cleanup-only failure must not flip an otherwise-successful run
      try {
        await mongoClient.close(true)
      } catch (closeError: unknown) {
        const closeMsg =
          closeError instanceof Error ? closeError.message : String(closeError)
        consola.warn(`Failed to close MongoDB connection: ${closeMsg}`)
      }
    }
  },
})

runMain(main)
