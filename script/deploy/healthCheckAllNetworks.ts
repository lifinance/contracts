/**
 * Fan the single-network health check across every production network — in one process.
 *
 * Calls {@link runHealthCheckForNetwork} per production network (mainnet + active) with
 * bounded concurrency (no subprocess-per-network), collects a pass/fail/skip per network,
 * and (in GitHub Actions) writes a consolidated summary to `$GITHUB_OUTPUT` for the Slack
 * report. Exits non-zero if any network fails. Invoke via
 * `bunx tsx ./script/deploy/healthCheckAllNetworks.ts [--environment production] [--concurrency 8] [--networks a,b] [--changed-paths deployments/x.json,...]`.
 * The invariants it enforces live in `healthCheckInvariants.ts`.
 */
import { appendFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { INetwork } from '../common/types'
import { getAllActiveNetworks } from '../utils/viemScriptHelpers'

import { runHealthCheckForNetwork } from './healthCheck'

/** Per-network deadline. A network whose reads stall past this is recorded as failed so one
 * hung RPC cannot block the consolidated report (the dangling read is abandoned, not killed). */
const PER_NETWORK_TIMEOUT_MS = 5 * 60_000 // 5 minutes

/** Outcome of a single network's health check. */
export interface IHealthCheckResult {
  network: string
  status: 'passed' | 'failed' | 'skipped'
  /** Count of non-fatal warnings (e.g. reduced coverage); surfaced in the consolidated report. */
  warnings: number
  /** Trimmed detail when failed/skipped (empty on pass). */
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

/**
 * Map changed `deployments/**` file paths to the production network keys they belong to.
 * Only `deployments/<network>.json` counts — `<network>.staging.json`, `<network>.diamond.json`
 * and non-network files (e.g. `_deployments_log_file.json`) are ignored. Pure; used by the
 * push-to-main trigger to check only the networks a deploy actually touched.
 */
export function deploymentPathsToNetworks(paths: string[]): string[] {
  const networks = new Set<string>()
  for (const path of paths) {
    const match = path.trim().match(/^deployments\/([a-z0-9]+)\.json$/)
    if (match?.[1]) networks.add(match[1])
  }
  return [...networks].sort()
}

/** Aggregate per-network results into a consolidated report. Pure. */
export function summarizeHealthChecks(results: IHealthCheckResult[]): {
  total: number
  passed: string[]
  failed: string[]
  skipped: string[]
  /** Networks that passed/skipped but emitted a non-fatal warning (e.g. reduced coverage). */
  warned: string[]
} {
  const byStatus = (status: IHealthCheckResult['status']) =>
    results
      .filter((r) => r.status === status)
      .map((r) => r.network)
      .sort()
  return {
    total: results.length,
    passed: byStatus('passed'),
    failed: byStatus('failed'),
    skipped: byStatus('skipped'),
    warned: results
      .filter((r) => r.warnings > 0)
      .map((r) => r.network)
      .sort(),
  }
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

/** Run one network's health check in-process, bounded by a deadline; never throws. */
async function runOneNetwork(
  network: string,
  environment: string,
  timeoutMs: number = PER_NETWORK_TIMEOUT_MS
): Promise<IHealthCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<IHealthCheckResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          network,
          status: 'failed',
          warnings: 0,
          detail: `TIMEOUT after ${Math.round(timeoutMs / 1000)}s`,
        }),
      timeoutMs
    )
  })

  const check = async (): Promise<IHealthCheckResult> => {
    try {
      const result = await runHealthCheckForNetwork(network, environment)
      let detail = ''
      // Keep only the tail so a single network cannot flood the consolidated report.
      if (result.status === 'failed')
        detail = result.errors.slice(-5).join('\n')
      else if (result.status === 'skipped')
        detail = result.skipReason ?? 'skipped'
      return {
        network,
        status: result.status,
        warnings: result.warnings.length,
        detail,
      }
    } catch (error: unknown) {
      // runHealthCheckForNetwork is designed never to throw; guard defensively so a
      // rejection becomes a failed result rather than rejecting the concurrent job queue.
      const message = error instanceof Error ? error.message : String(error)
      return {
        network,
        status: 'failed',
        warnings: 0,
        detail: `unexpected error: ${message}`,
      }
    }
  }

  try {
    return await Promise.race([check(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Append the consolidated per-run summary to $GITHUB_OUTPUT for the Slack composer (no-op locally). */
function writeConsolidatedOutput(summary: {
  total: number
  passed: string[]
  failed: string[]
  skipped: string[]
  warned: string[]
}): void {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `total=${summary.total}`,
      `passed_count=${summary.passed.length}`,
      `failed_count=${summary.failed.length}`,
      `skipped_count=${summary.skipped.length}`,
      `warned_count=${summary.warned.length}`,
      `failed_networks=${summary.failed.join(', ')}`,
      `warned_networks=${summary.warned.join(', ')}`,
      '',
    ].join('\n')
  )
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
      default: process.env.MAX_CONCURRENT_JOBS ?? '8',
    },
    networks: {
      type: 'string',
      description:
        'Optional comma-separated network override (defaults to all production networks)',
      required: false,
    },
    'changed-paths': {
      type: 'string',
      description:
        'Comma-separated changed deployments/** paths; checks only the networks they map to (post-deploy trigger)',
      required: false,
    },
  },
  async run({ args }) {
    const environment = String(args.environment)
    const concurrency = Math.max(
      1,
      Number.parseInt(String(args.concurrency), 10) || 8
    )

    // Precedence: explicit --networks override, else --changed-paths (post-deploy), else full fleet.
    let networks: string[]
    if (args.networks)
      networks = String(args.networks)
        .split(',')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean)
    else if (args['changed-paths'] !== undefined) {
      networks = deploymentPathsToNetworks(
        String(args['changed-paths']).split(',')
      )
      if (networks.length === 0) {
        consola.success(
          'No production network deployment files changed; nothing to check.'
        )
        writeConsolidatedOutput({
          total: 0,
          passed: [],
          failed: [],
          skipped: [],
          warned: [],
        })
        process.exit(0)
      }
    } else networks = getProductionNetworkNames(getAllActiveNetworks())

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

    const { total, passed, failed, skipped, warned } =
      summarizeHealthChecks(results)

    consola.box(
      `Health check summary: ${passed.length}/${total} passed, ${failed.length} failed, ${skipped.length} skipped, ${warned.length} warned`
    )
    for (const result of results)
      if (result.status === 'failed')
        consola.error(`${result.network}\n${result.detail}`)
      else if (result.status === 'skipped')
        consola.info(`${result.network} (skipped: ${result.detail})`)
      else if (result.warnings > 0)
        consola.warn(
          `${result.network} (passed with ${result.warnings} warning(s))`
        )
      else consola.success(result.network)

    if (warned.length > 0)
      consola.warn(
        `Networks with warnings (reduced coverage): ${warned.join(', ')}`
      )

    // Publish a consolidated result for the workflow's Slack step.
    writeConsolidatedOutput({ total, passed, failed, skipped, warned })

    if (failed.length > 0) {
      consola.error(`Health check failed on: ${failed.join(', ')}`)
      process.exit(1)
    }
    consola.success('All checked networks passed the health check.')
    process.exit(0)
  },
})

// Guard so importing this module (e.g. from tests, for the pure helpers) does not execute the CLI.
if (import.meta.main) runMain(main)
