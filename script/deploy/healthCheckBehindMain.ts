/**
 * Report-only "behind main" summary for the health check.
 *
 * For every `latest` key in a network's production target state, compares the version live on
 * chain with the repo's `@custom:version` and lists the contracts that lag. It never fails a run:
 * a rollout reaches the fleet over weeks, so at any time most networks lag main somewhere, and as
 * an error it would red every one of them.
 *
 * The live version is diagnosed from the live address: the diamond loupe for facets, the
 * PeripheryRegistry (falling back to the deploy log) for everything else. The committed logs are
 * consulted only to map that address to the version recorded for it, which does not go stale the
 * way their name → address entries do.
 */
import { existsSync, readFileSync } from 'fs'
import path from 'path'

import type { IOnChainFacet } from './healthCheckInvariants'
import {
  compareContractVersions,
  resolveRegisteredFacetVersion,
  type DiamondFacetLog,
} from './shared/immutableBindings'

/** `deployments/_deployments_log_file.json`: name → network → environment → version → records. */
export type DeployLog = Record<
  string,
  Record<string, Record<string, Record<string, Array<{ ADDRESS?: string }>>>>
>

/** What the summary reads for one network. */
export interface IBehindMainInput {
  networkLower: string
  /** `_targetState.json` → `<network>.production.LiFiDiamond`; undefined when absent. */
  targetContracts: Record<string, string> | undefined
  /** The diamond loupe as the run read it; empty when that read failed. */
  onChainFacets: IOnChainFacet[]
  deployedContracts: Record<string, string>
  diamondFacetLog: DiamondFacetLog | null
  deployLog: DeployLog | null
}

/** Reads the summary performs, injectable for tests. */
export interface IBehindMainDeps {
  isFacet: (name: string) => boolean
  readRegistry: (name: string) => Promise<string | null>
  repoVersion: (name: string) => Promise<string>
}

/** One contract whose live version is older than the repo's. */
export interface IBehindMainRow {
  contract: string
  live: string
  repo: string
}

/** The summary for one network. */
export interface IBehindMainReport {
  networkLower: string
  hasTargetState: boolean
  behind: IBehindMainRow[]
  current: string[]
  undiagnosed: Array<{ contract: string; reason: string }>
}

const VERSION_BASE = /^(\d+\.\d+\.\d+)/

const own = <T>(
  record: Record<string, T> | undefined,
  key: string
): T | undefined =>
  record && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined

const sameAddress = (left: string, right: string): boolean =>
  left.startsWith('0x') && right.startsWith('0x')
    ? left.toLowerCase() === right.toLowerCase()
    : left === right

/**
 * The version the deploy log records for `address` under `name` on this network.
 *
 * @returns the version, or null when the log records no deployment at that address
 */
function versionAtAddress(
  deployLog: DeployLog | null,
  name: string,
  networkLower: string,
  address: string
): string | null {
  const byVersion = own(
    own(own(deployLog ?? undefined, name), networkLower),
    'production'
  )
  if (!byVersion) return null
  for (const [version, records] of Object.entries(byVersion))
    if (
      Array.isArray(records) &&
      records.some(
        (record) =>
          typeof record?.ADDRESS === 'string' &&
          sameAddress(record.ADDRESS, address)
      )
    )
      return version
  return null
}

/** Order two versions by their MAJOR.MINOR.PATCH base; null when either has none. */
function compareBases(left: string, right: string): number | null {
  const leftBase = VERSION_BASE.exec(left.trim())?.[1]
  const rightBase = VERSION_BASE.exec(right.trim())?.[1]
  if (!leftBase || !rightBase) return null
  return compareContractVersions(leftBase, rightBase)
}

/**
 * The oldest version among the loupe addresses recorded under this facet name.
 *
 * @remarks Several addresses can match mid-rollout, when a partial cut leaves selectors on both
 *   builds; the oldest is what some calls still reach.
 */
function liveFacetVersion(
  name: string,
  input: IBehindMainInput
): string | { reason: string } {
  if (input.onChainFacets.length === 0)
    return { reason: 'on-chain facet list unavailable' }
  const versions: string[] = []
  for (const { address } of input.onChainFacets) {
    const version =
      resolveRegisteredFacetVersion(
        name,
        input.networkLower,
        address,
        input.diamondFacetLog
      ) ?? versionAtAddress(input.deployLog, name, input.networkLower, address)
    if (version !== null) versions.push(version)
  }
  if (versions.length === 0)
    return { reason: 'no routed facet address is recorded under this name' }
  return versions.reduce((oldest, version) =>
    (compareBases(version, oldest) ?? 0) < 0 ? version : oldest
  )
}

async function livePeripheryVersion(
  name: string,
  input: IBehindMainInput,
  deps: IBehindMainDeps
): Promise<string | { reason: string }> {
  let address: string | null = null
  try {
    address = await deps.readRegistry(name)
  } catch {
    address = null
  }
  address ??= own(input.deployedContracts, name) ?? null
  if (!address) return { reason: 'not registered and not in the deploy log' }
  return (
    versionAtAddress(input.deployLog, name, input.networkLower, address) ?? {
      reason: `no deploy-log version recorded for ${address}`,
    }
  )
}

/**
 * Diagnose which `latest` contracts on one network run a version older than the repo's.
 *
 * @returns the report; a contract whose live or repo version cannot be established lands in
 *   `undiagnosed`, never in `current`
 */
export async function diagnoseBehindMain(
  input: IBehindMainInput,
  deps: IBehindMainDeps
): Promise<IBehindMainReport> {
  const report: IBehindMainReport = {
    networkLower: input.networkLower,
    hasTargetState: input.targetContracts !== undefined,
    behind: [],
    current: [],
    undiagnosed: [],
  }
  if (!input.targetContracts) return report

  const latest = Object.entries(input.targetContracts)
    .filter(([, value]) => value === 'latest')
    .map(([name]) => name)
    .sort()

  for (const contract of latest) {
    let repo: string
    try {
      repo = await deps.repoVersion(contract)
    } catch (error: unknown) {
      report.undiagnosed.push({
        contract,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const live = deps.isFacet(contract)
      ? liveFacetVersion(contract, input)
      : await livePeripheryVersion(contract, input, deps)
    if (typeof live !== 'string') {
      report.undiagnosed.push({ contract, reason: live.reason })
      continue
    }

    const order = compareBases(live, repo)
    if (order === null)
      report.undiagnosed.push({
        contract,
        reason: `cannot order ${live} against ${repo}`,
      })
    else if (order < 0) report.behind.push({ contract, live, repo })
    else report.current.push(contract)
  }
  return report
}

/**
 * Render one network's report as the single summary line.
 *
 * @remarks Undiagnosed contracts count in the total and are named, so a network whose live
 *   versions cannot be read never reads as nearly current.
 * @returns e.g. `[gnosis] behind main (report-only): 3 behind, 2 undiagnosed, of 20 - TokenWrapper 1.0.0 < 1.2.1, … - undiagnosed: FeeForwarder, OutputValidator`
 */
export function formatBehindMainLine(report: IBehindMainReport): string {
  const prefix = `[${report.networkLower}] behind main (report-only)`
  if (!report.hasTargetState) return `${prefix}: no production target state`
  const total =
    report.behind.length + report.current.length + report.undiagnosed.length
  const parts = [
    `${prefix}: ${report.behind.length} behind, ${report.undiagnosed.length} undiagnosed, of ${total}`,
  ]
  if (report.behind.length > 0)
    parts.push(
      report.behind
        .map(({ contract, live, repo }) => `${contract} ${live} < ${repo}`)
        .join(', ')
    )
  if (report.undiagnosed.length > 0)
    parts.push(
      `undiagnosed: ${report.undiagnosed
        .map(({ contract }) => contract)
        .join(', ')}`
    )
  return parts.join(' - ')
}

/**
 * The fleet runner's block of summary lines, one per network that produced one.
 *
 * @returns the lines sorted by network
 */
export function renderBehindMainSummary(
  results: Array<{ network: string; behindMain?: string }>
): string[] {
  return results
    .filter(
      (result): result is { network: string; behindMain: string } =>
        typeof result.behindMain === 'string' && result.behindMain !== ''
    )
    .sort((left, right) => left.network.localeCompare(right.network))
    .map((result) => result.behindMain)
}

let deployLogCache: DeployLog | null | undefined

/**
 * Read `deployments/_deployments_log_file.json` once per process.
 *
 * @returns the parsed log, or null when it is missing or does not parse
 */
export function loadDeployLog(): DeployLog | null {
  if (deployLogCache !== undefined) return deployLogCache
  const logPath = path.join(
    process.cwd(),
    'deployments',
    '_deployments_log_file.json'
  )
  try {
    deployLogCache = existsSync(logPath)
      ? (JSON.parse(readFileSync(logPath, 'utf8')) as DeployLog)
      : null
  } catch {
    deployLogCache = null
  }
  return deployLogCache
}
