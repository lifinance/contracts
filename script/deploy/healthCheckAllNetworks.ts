/**
 * Fan the single-network health check across every production network.
 *
 * Runs `script/deploy/healthCheck.ts` once per production network (mainnet + active) with
 * bounded concurrency, collects a pass/fail per network, and (in GitHub Actions) writes a
 * consolidated summary to `$GITHUB_OUTPUT` for the Slack report. Exits non-zero if any
 * network fails. Invoke via
 * `bunx tsx ./script/deploy/healthCheckAllNetworks.ts [--environment production] [--concurrency 5] [--networks a,b]`.
 * This is the runner behind the scheduled `healthCheckAllNetworks` workflow; the invariants
 * it enforces live in `healthCheckInvariants.ts`.
 */
import { appendFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { INetwork } from '../common/types'
import { spawnAndCapture } from '../utils/spawnAndCapture'
import { getAllActiveNetworks } from '../utils/viemScriptHelpers'

/** Outcome of a single network's health check. */
export interface IHealthCheckResult {
  network: string
  passed: boolean
  /** Trimmed error output when the check failed (empty on success). */
  detail: string
}

/**
 * Production networks are `type: "mainnet"` AND `status: "active"`. Pure over the given
 * network list so it can be unit-tested without reading config.
 *
 * @param networks - Networks to filter (typically `getAllActiveNetworks()`).
 * @returns Sorted list of production network ids.
 */
export function getProductionNetworkNames(networks: INetwork[]): string[] {
  return networks
    .filter((n) => n.type === 'mainnet' && n.status === 'active')
    .map((n) => n.id)
    .sort()
}

/** Aggregate per-network results into a consolidated report. Pure. */
export function summarizeHealthChecks(results: IHealthCheckResult[]): {
  total: number
  passed: string[]
  failed: string[]
} {
  const passed = results
    .filter((r) => r.passed)
    .map((r) => r.network)
    .sort()
  const failed = results
    .filter((r) => !r.passed)
    .map((r) => r.network)
    .sort()
  return { total: results.length, passed, failed }
}

/**
 * Run `mapper` over `items` with at most `limit` in flight at once. Preserves input
 * order in the returned results. Used to bound RPC pressure across many networks.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const current = next++
      const item = items[current]
      if (item === undefined) continue
      results[current] = await mapper(item, current)
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

/** Run the single-network health check as a child process; never throws. */
async function runOneNetwork(
  network: string,
  environment: string
): Promise<IHealthCheckResult> {
  try {
    await spawnAndCapture('bunx', [
      'tsx',
      'script/deploy/healthCheck.ts',
      '--network',
      network,
      '--environment',
      environment,
    ])
    return { network, passed: true, detail: '' }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    // Keep only the tail so a single network cannot flood the consolidated report.
    return {
      network,
      passed: false,
      detail: detail.split('\n').slice(-5).join('\n'),
    }
  }
}

const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Health Check (all networks)',
    description:
      'Run the diamond health check across every production network and report a consolidated result',
  },
  args: {
    environment: {
      type: 'string',
      description: 'Environment to check (production or staging)',
      default: 'production',
    },
    concurrency: {
      type: 'string',
      description: 'Maximum health checks to run in parallel',
      default: process.env.MAX_CONCURRENT_JOBS ?? '5',
    },
    networks: {
      type: 'string',
      description:
        'Optional comma-separated network override (defaults to all production networks)',
      required: false,
    },
  },
  async run({ args }) {
    const environment = String(args.environment)
    const concurrency = Math.max(
      1,
      Number.parseInt(String(args.concurrency), 10) || 5
    )

    const networks = args.networks
      ? String(args.networks)
          .split(',')
          .map((n) => n.trim().toLowerCase())
          .filter(Boolean)
      : getProductionNetworkNames(getAllActiveNetworks())

    if (networks.length === 0) {
      consola.error('No production networks resolved; nothing to check.')
      process.exit(1)
    }

    consola.info(
      `Running health check across ${networks.length} network(s) [${environment}], concurrency ${concurrency}...`
    )

    const results = await mapWithConcurrency(networks, concurrency, (network) =>
      runOneNetwork(network, environment)
    )

    const { total, passed, failed } = summarizeHealthChecks(results)

    consola.box(
      `Health check summary: ${passed.length}/${total} passed, ${failed.length} failed`
    )
    for (const result of results)
      if (result.passed) consola.success(result.network)
      else consola.error(`${result.network}\n${result.detail}`)

    // Publish a consolidated result for the workflow's Slack step.
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        [
          `total=${total}`,
          `passed_count=${passed.length}`,
          `failed_count=${failed.length}`,
          `failed_networks=${failed.join(', ')}`,
          '',
        ].join('\n')
      )

    if (failed.length > 0) {
      consola.error(`Health check failed on: ${failed.join(', ')}`)
      process.exit(1)
    }
    consola.success('All production networks passed the health check.')
    process.exit(0)
  },
})

// Guard so importing this module (e.g. from tests, for the pure helpers) does not execute the CLI.
if (import.meta.main) runMain(main)
