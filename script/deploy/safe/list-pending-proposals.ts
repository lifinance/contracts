/**
 * List Safe Proposals (read-only)
 *
 * Non-interactive view of Safe proposals stored in MongoDB: signature counts,
 * signers, nonces, and targets - without connecting a signer or prompting.
 * Use it to verify rollout progress (e.g. "are all diamondCut proposals on
 * arbitrum/base/mainnet signed by 2 signers?") from scripts and agents;
 * confirm-safe-tx.ts remains the interactive tool for signing/executing.
 *
 * Exit codes: 0 success (even with zero matches), 1 real error,
 * 2 recoverable misconfig (missing SC_MONGODB_URI / VPN not connected).
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'

import { getTargetName } from './safe-decode-utils'
import {
  getSafeMongoCollection,
  summarizeProposalDoc,
  type IProposalSummary,
  type ISafeTxDocument,
} from './safe-utils'

dotenv.config()

const VALID_STATUSES = [
  'pending',
  'submitted',
  'executed',
  'reverted',
  'all',
] as const

const main = defineCommand({
  meta: {
    name: 'list-pending-proposals',
    description:
      'List Safe proposals from MongoDB with signature counts (read-only)',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Only show proposals for these networks (comma-separated, e.g. "arbitrum,base,mainnet")',
      required: false,
    },
    status: {
      type: 'string',
      description: `Proposal status to list (${VALID_STATUSES.join(
        '|'
      )}), default: pending`,
      required: false,
    },
    maxAgeHours: {
      type: 'string',
      description: 'Only show proposals created within the last N hours',
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
    const status = (args.status || 'pending').toLowerCase()
    if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      consola.error(
        `Invalid status "${
          args.status
        }" - must be one of: ${VALID_STATUSES.join(', ')}`
      )
      process.exit(1)
    }

    let maxAgeHours: number | undefined
    if (args.maxAgeHours) {
      maxAgeHours = Number(args.maxAgeHours)
      if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
        consola.error(
          `Invalid maxAgeHours "${args.maxAgeHours}" - must be a positive number`
        )
        process.exit(1)
      }
    }

    const networks = args.network
      ? args.network
          .split(',')
          .map((n: string) => n.trim().toLowerCase())
          .filter(Boolean)
      : undefined

    // JSON consumers parse stdout; route all human logging away from it
    if (args.json) consola.level = 0

    let mongoClient
    let pendingTransactions
    try {
      ;({ client: mongoClient, pendingTransactions } =
        await getSafeMongoCollection())
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
      const query: Record<string, unknown> = {}
      if (status !== 'all') query.status = { $eq: status }
      if (networks) query.network = { $in: networks }
      if (maxAgeHours)
        query.timestamp = {
          $gte: new Date(Date.now() - maxAgeHours * 60 * 60 * 1000), // hours -> ms
        }

      const docs = await pendingTransactions
        .find<ISafeTxDocument>(query)
        .toArray()

      const proposals: IProposalSummary[] = docs
        .map(summarizeProposalDoc)
        .sort((a, b) => a.network.localeCompare(b.network) || a.nonce - b.nonce)

      // resolve human-readable target names from local deployment logs
      const targetNames = await Promise.all(
        proposals.map((p) =>
          getTargetName(p.to as `0x${string}`, p.network).catch(() => '')
        )
      )

      if (args.json) {
        const rows = proposals.map((p, i) => ({
          ...p,
          targetName: targetNames[i] || undefined,
        }))
        process.stdout.write(
          `${JSON.stringify(
            { count: rows.length, proposals: rows },
            null,
            2
          )}\n`
        )
        return
      }

      if (!proposals.length) {
        consola.info(
          `No ${status === 'all' ? '' : `'${status}' `}proposals found${
            networks ? ` for: ${networks.join(', ')}` : ''
          }`
        )
        return
      }

      let currentNetwork = ''
      proposals.forEach((p, i) => {
        if (p.network !== currentNetwork) {
          currentNetwork = p.network
          consola.info('')
          consola.info(`=== ${p.network} (chainId ${p.chainId}) ===`)
        }
        consola.info(
          [
            `nonce ${p.nonce}`,
            `status ${p.status}`,
            `sigs ${p.signatureCount}`,
            `selector ${p.selector}`,
            `to ${p.to}${targetNames[i] ? ` ${targetNames[i]}` : ''}`,
          ].join(' | ')
        )
        consola.info(
          `  signers: ${p.signers.join(', ') || '-'} | proposed ${
            p.timestamp
          } | safeTxHash ${p.safeTxHash}`
        )
      })
      consola.info('')
      consola.success(`${proposals.length} proposal(s) listed`)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error(`Failed to query proposals: ${errorMsg}`)
      process.exit(1)
    } finally {
      await mongoClient.close(true)
    }
  },
})

runMain(main)
