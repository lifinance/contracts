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
import { mapWithConcurrency } from '../utils/mapWithConcurrency'
import { redactUrls } from '../utils/redactUrls'
import { getAllActiveNetworks } from '../utils/viemScriptHelpers'

import { runHealthCheckForNetwork } from './healthCheck'

/** Per-network deadline. A network whose reads stall past this is recorded as failed so one
 * hung RPC cannot block the consolidated report (the dangling read is abandoned, not killed). */
const PER_NETWORK_TIMEOUT_MS = 5 * 60_000 // 5 minutes

/** Outcome of a single network's health check. */
export interface IHealthCheckResult {
  network: string
  status: 'passed' | 'failed' | 'skipped'
  /**
   * Non-fatal warning texts (e.g. reduced coverage). Kept as text, not a count: a warning
   * nobody can read is a warning nobody acts on, and the consolidated report groups them by
   * cause the same way it groups failures.
   */
  warnings: string[]
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
  /** Networks that emitted a non-fatal warning (e.g. reduced coverage), whatever their status. */
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
      .filter((r) => r.warnings.length > 0)
      .map((r) => r.network)
      .sort(),
  }
}

/** Networks that share one normalized cause, whether it failed them or only warned them. */
export interface ICauseGroup {
  cause: string
  /** Sorted, deduplicated network ids reporting this cause. */
  networks: string[]
}

// A cause repeats across chains with a different contract address each time, so addresses are
// masked to let the shapes collapse. 4-byte selectors are deliberately NOT masked: a different
// selector is a different cause (0x2646478b is processRoute, 0xe0cbc5f2 is not).
const EVM_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/g
const TRON_ADDRESS_PATTERN = /\b[Tt][1-9A-HJ-NP-Za-km-z]{33}\b/g

// Slack parses <...> as a link element, so the masks must avoid angle brackets or they would be
// mangled in the very message they exist to clarify.
const ADDRESS_MASK = '[address]'
const COUNT_MASK = '[n]'
const NETWORK_MASK = '[network]'

/** Cause used when a network failed without the runner capturing any error text. */
const UNKNOWN_CAUSE = 'no detail captured (see workflow run)'

/** Collapse runs of whitespace so a multi-line detail renders as one Slack bullet. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Network ids come from config, but a regex built from unescaped input is a bug waiting to land. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reduce a per-network failure detail to the shape shared by every network failing for the same
 * reason. Standalone integers are masked so "1 stale pair" and "2 stale pairs" group together;
 * the `\b` anchors keep digits inside an identifier (LiFiIntentEscrowFacetV2) intact. Pure.
 *
 * Note the masks are the price of grouping: the digest names the cause, and the workflow run
 * still holds the per-network addresses and counts.
 *
 * Endpoints are redacted FIRST, before any other masking: a detail can be a raw viem or Mongo
 * error carrying a credentialed URL, and this text is published to Slack, which is outside the
 * workflow log's masking. Redacting also happens to improve grouping — two networks failing on
 * the same RPC fault differ only in their endpoint.
 *
 * @param detail - Raw failure or warning text.
 * @param network - The network the text came from. Several warnings name their own network
 * (`…recording it in deployments/<network>.json…`), which would otherwise put each network in a
 * group of one — the exact fragmentation this function exists to prevent. Matched on word
 * boundaries so a short id (`ink`, `sei`) cannot rewrite an unrelated word.
 */
export function normalizeFailureCause(
  detail: string,
  network?: string
): string {
  const withoutNetwork = network
    ? detail.replace(
        new RegExp(`\\b${escapeForRegExp(network)}\\b`, 'gi'),
        NETWORK_MASK
      )
    : detail
  return collapseWhitespace(
    redactUrls(withoutNetwork)
      .replace(EVM_ADDRESS_PATTERN, ADDRESS_MASK)
      .replace(TRON_ADDRESS_PATTERN, ADDRESS_MASK)
      .replace(/\b\d+\b/g, COUNT_MASK)
  )
}

/**
 * Group failed networks by normalized cause, widest blast radius first. Turns "17 networks
 * failed" into the two or three root causes actually behind it. Pure.
 *
 * Grouping keys off the whole detail, which `runOneNetwork` already trims to the last 5 errors —
 * so a network failing more than five ways groups by its tail, and can land in its own group
 * rather than beside networks sharing its first cause.
 */
export function groupFailuresByCause(
  results: IHealthCheckResult[]
): ICauseGroup[] {
  return groupByCause(
    results
      .filter((result) => result.status === 'failed')
      .map((result) => ({
        network: result.network,
        // trim(), not a bare falsy check: a whitespace-only detail normalizes to an empty cause,
        // which groupByCause drops — and a failed network missing from the digest contradicts the
        // failure count right above it.
        text: result.detail.trim() || UNKNOWN_CAUSE,
      }))
  )
}

/**
 * Group warning texts by normalized cause, widest blast radius first. Pure.
 *
 * Warnings are collected from EVERY network regardless of status: a network can fail one
 * invariant and warn on another, and dropping that warning because the network was already red
 * is how a warning goes unseen for months. A network emitting several distinct warnings appears
 * in several groups — that is the point, since each cause is a separate decision.
 */
export function groupWarningsByCause(
  results: IHealthCheckResult[]
): ICauseGroup[] {
  return groupByCause(
    results.flatMap((result) =>
      result.warnings.map((text) => ({ network: result.network, text }))
    )
  )
}

/**
 * Collapse (network, text) pairs into one group per normalized cause, ordered by how many
 * networks each cause hit. Pure.
 */
function groupByCause(
  entries: { network: string; text: string }[]
): ICauseGroup[] {
  const byCause = new Map<string, Set<string>>()
  for (const entry of entries) {
    const cause = normalizeFailureCause(entry.text, entry.network)
    if (!cause) continue
    const networks = byCause.get(cause) ?? new Set<string>()
    networks.add(entry.network)
    byCause.set(cause, networks)
  }
  return [...byCause.entries()]
    .map(([cause, networks]) => ({ cause, networks: [...networks].sort() }))
    .sort(
      (a, b) =>
        b.networks.length - a.networks.length || a.cause.localeCompare(b.cause)
    )
}

/**
 * Shorten to at most `limit` characters, breaking after a whole word so the line does not end
 * mid-token. Falls back to a hard cut when there is no space to break on.
 */
function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit - 1)
  const lastSpace = head.lastIndexOf(' ')
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`
}

/**
 * Render grouped causes as Slack bullet lines. Capped on every axis so one pathological run
 * cannot turn the alert into a wall of text nobody reads — and so the message stays well inside
 * the 40k-character ceiling on an incoming webhook's `text` field, which Slack rejects outright
 * rather than truncating.
 */
export function renderCauseDigest(
  groups: ICauseGroup[],
  options: {
    maxGroups?: number
    maxNetworksPerGroup?: number
    maxCauseChars?: number
  } = {}
): string {
  const maxGroups = options.maxGroups ?? 6
  const maxNetworksPerGroup = options.maxNetworksPerGroup ?? 12
  const maxCauseChars = options.maxCauseChars ?? 160
  if (groups.length === 0) return ''

  const lines = groups.slice(0, maxGroups).map((group) => {
    const shown = group.networks.slice(0, maxNetworksPerGroup)
    const omitted = group.networks.length - shown.length
    const list =
      omitted > 0 ? `${shown.join(', ')}, +${omitted} more` : shown.join(', ')
    const cause = truncateAtWord(collapseWhitespace(group.cause), maxCauseChars)
    return `• ${cause} (${group.networks.length}): ${list}`
  })

  const hidden = Math.max(0, groups.length - maxGroups)
  if (hidden > 0)
    lines.push(`… ${hidden} further cause(s) not shown — see the workflow run`)
  return lines.join('\n')
}

/** Run one network's health check in-process, bounded by a deadline; never throws. */
async function runOneNetwork(
  network: string,
  environment: string,
  timeoutMs: number = PER_NETWORK_TIMEOUT_MS
): Promise<IHealthCheckResult> {
  // Cancel a timed-out network's in-flight RPC reads instead of only abandoning the promise:
  // Promise.race resolves via the deadline while the check keeps issuing reads, so without
  // this the fleet would exceed --concurrency on slow-RPC days. The signal is threaded into
  // the viem transport by runHealthCheckForNetwork.
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<IHealthCheckResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({
        network,
        status: 'failed',
        warnings: [],
        detail: `TIMEOUT after ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)
  })

  const check = async (): Promise<IHealthCheckResult> => {
    try {
      const result = await runHealthCheckForNetwork(
        network,
        environment,
        controller.signal
      )
      let detail = ''
      // Keep only the tail so a single network cannot flood the consolidated report.
      if (result.status === 'failed')
        detail = result.errors.slice(-5).join('\n')
      else if (result.status === 'skipped')
        detail = result.skipReason ?? 'skipped'
      return {
        network,
        status: result.status,
        warnings: result.warnings,
        detail,
      }
    } catch (error: unknown) {
      // runHealthCheckForNetwork is designed never to throw; guard defensively so a
      // rejection becomes a failed result rather than rejecting the concurrent job queue.
      const message = error instanceof Error ? error.message : String(error)
      return {
        network,
        status: 'failed',
        warnings: [],
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

/** Heredoc terminator for the multi-line digest output. */
const DIGEST_DELIMITER = 'HEALTHCHECK_DIGEST_EOF'

export interface IConsolidatedSummary {
  total: number
  passed: string[]
  failed: string[]
  skipped: string[]
  warned: string[]
  /** Pre-rendered failure-cause digest; empty when there is nothing to report. */
  failureDigest: string
  /** Pre-rendered warning-cause digest; empty when no network warned. */
  warningDigest: string
}

/**
 * One `$GITHUB_OUTPUT` entry for a digest: a heredoc block when there is text, a plain empty
 * scalar when there is not.
 *
 * A digest is assembled from revert strings and RPC errors, so a line that happens to equal the
 * terminator would close the heredoc early and let the remaining text be parsed as further step
 * outputs. Dropping such lines keeps the block well-formed.
 */
function digestOutput(key: string, digest: string): string[] {
  if (!digest) return [`${key}=`]
  const body = digest
    .split('\n')
    .filter((line) => line.trim() !== DIGEST_DELIMITER)
    .join('\n')
  return [`${key}<<${DIGEST_DELIMITER}`, body, DIGEST_DELIMITER]
}

/** Render the consolidated summary in $GITHUB_OUTPUT syntax. Pure. */
export function formatConsolidatedOutput(
  summary: IConsolidatedSummary
): string {
  const lines = [
    `total=${summary.total}`,
    `passed_count=${summary.passed.length}`,
    `failed_count=${summary.failed.length}`,
    `skipped_count=${summary.skipped.length}`,
    `warned_count=${summary.warned.length}`,
    `failed_networks=${summary.failed.join(', ')}`,
    `warned_networks=${summary.warned.join(', ')}`,
  ]
  lines.push(...digestOutput('failure_digest', summary.failureDigest))
  lines.push(...digestOutput('warning_digest', summary.warningDigest))
  return [...lines, ''].join('\n')
}

/** Append the consolidated per-run summary to $GITHUB_OUTPUT for the Slack composer (no-op locally). */
function writeConsolidatedOutput(summary: IConsolidatedSummary): void {
  if (!process.env.GITHUB_OUTPUT) return
  appendFileSync(process.env.GITHUB_OUTPUT, formatConsolidatedOutput(summary))
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
      // Intersect with the production fleet: the push trigger fires on any deployments/*.json
      // change, but production-scoped invariants must only run against mainnet+active networks.
      // Without this, a change to deployments/basesepolia.json would run production checks
      // against a testnet and post a false 🚨 ACTION NEEDED alert (see cron path below).
      const productionNetworks = new Set(
        getProductionNetworkNames(getAllActiveNetworks())
      )
      networks = deploymentPathsToNetworks(
        String(args['changed-paths']).split(',')
      ).filter((n) => productionNetworks.has(n))
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
          failureDigest: '',
          warningDigest: '',
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
      else if (result.warnings.length > 0)
        consola.warn(
          `${result.network} (passed with ${result.warnings.length} warning(s))`
        )
      else consola.success(result.network)

    if (warned.length > 0)
      consola.warn(
        `Networks with warnings (reduced coverage): ${warned.join(', ')}`
      )

    // Publish a consolidated result for the workflow's Slack step, including the grouped
    // cause digest so the alert names the root causes instead of only counting networks.
    writeConsolidatedOutput({
      total,
      passed,
      failed,
      skipped,
      warned,
      failureDigest: renderCauseDigest(groupFailuresByCause(results)),
      warningDigest: renderCauseDigest(groupWarningsByCause(results)),
    })

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
