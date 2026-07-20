/**
 * Enqueue a Parked Diamond-Cleanup Task (write)
 *
 * Parks a single facet-removal task in the deferred diamond-cleanup queue
 * (`deferred-cleanup.parkedTasks`, design: PR #2049) instead of proposing the removal
 * eagerly. Called by `/deprecate-contract` (once the deprecation PR URL is known)
 * per (facet, network); the removal rides along the next time the network is
 * touched. Refuses to enqueue without the originating PR URL — the reviewer must
 * be able to see which PR a deferred removal belongs to at signing time (spec §6).
 *
 * Exit codes: 0 enqueued (or a harmless duplicate no-op), 1 invalid input / real
 * error, 2 recoverable misconfig (missing MONGODB_URI).
 */

import { execSync } from 'node:child_process'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
import { getAddress, type Address } from 'viem'

import { EnvironmentEnum } from '../../common/types'

import {
  enqueueParkedTask,
  getParkedTasksCollection,
  type IParkedTaskInput,
} from './parked-tasks'

dotenv.config()

/** Resolves the enqueuer identity from git; falls back to `unknown` off a checkout. */
function resolveEnqueuer(): string {
  try {
    return (
      execSync('git config user.email', { encoding: 'utf8' }).trim() ||
      'unknown'
    )
  } catch {
    return 'unknown'
  }
}

/** Parses+checksums an address arg, exiting 1 on an invalid value. */
function requireAddress(label: string, value: string): Address {
  try {
    return getAddress(value)
  } catch {
    consola.error(`Invalid ${label}: "${value}" is not a valid address`)
    process.exit(1)
  }
}

const main = defineCommand({
  meta: {
    name: 'enqueue-parked-task',
    description:
      'Park a facet-removal task in the deferred diamond-cleanup queue (requires the originating PR URL)',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network slug (matches networks.json keys)',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Deployment environment (production only in v1)',
      default: EnvironmentEnum.production,
      required: false,
    },
    facetName: {
      type: 'string',
      description:
        'Facet to park for removal (identity; selectors resolved at drain)',
      required: true,
    },
    diamondAddress: {
      type: 'string',
      description: 'Diamond address snapshot from the deploy log',
      required: true,
    },
    facetAddress: {
      type: 'string',
      description: 'Facet address snapshot from the deploy log',
      required: true,
    },
    prUrl: {
      type: 'string',
      description:
        'Originating deprecation PR URL (REQUIRED — shown to the signer)',
      required: true,
    },
    notes: {
      type: 'string',
      description: 'Optional free-text note stored on the task',
      required: false,
    },
  },
  async run({ args }) {
    // v1 parks production removals only — the fatigue problem it solves is prod
    // Safe signing; staging/testnet broadcast directly and need no deferral.
    if (args.environment !== EnvironmentEnum.production) {
      consola.error(
        `Only '${EnvironmentEnum.production}' tasks can be parked in v1 (got "${args.environment}")`
      )
      process.exit(1)
    }

    if (!args.prUrl || args.prUrl.trim() === '') {
      consola.error(
        'prUrl is required — a parked removal must carry its originating PR so the signer can see it'
      )
      process.exit(1)
    }

    if (!args.facetName || args.facetName.trim() === '') {
      consola.error('facetName is required and cannot be blank')
      process.exit(1)
    }

    const input: IParkedTaskInput = {
      kind: 'facet-removal',
      network: args.network.toLowerCase(),
      environment: EnvironmentEnum.production,
      facetName: args.facetName,
      diamondAddress: requireAddress('diamondAddress', args.diamondAddress),
      facetAddress: requireAddress('facetAddress', args.facetAddress),
      prUrl: args.prUrl.trim(),
      enqueuer: resolveEnqueuer(),
      ...(args.notes ? { notes: args.notes } : {}),
    }

    let mongoClient
    let parkedTasks
    try {
      ;({ client: mongoClient, parkedTasks } = await getParkedTasksCollection())
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error(
        `Could not connect to the parked-tasks MongoDB: ${errorMsg}`
      )
      // missing env var is a recoverable misconfig, not a hard error
      if (errorMsg.includes('MONGODB_URI')) process.exit(2)
      process.exit(1)
    }

    try {
      const result = await enqueueParkedTask(parkedTasks, input)
      if (result === null) {
        consola.info(
          `${input.facetName} on ${input.network} is already parked (queued/proposed) — no-op`
        )
        return
      }
      consola.success(
        `Parked ${input.facetName} removal on ${input.network} (origin PR ${input.prUrl})`
      )
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error(`Failed to enqueue parked task: ${errorMsg}`)
      // Set exitCode (not process.exit) so the finally below still closes Mongo.
      process.exitCode = 1
    } finally {
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
