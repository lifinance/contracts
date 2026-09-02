#!/usr/bin/env bun

/**
 * Read-only audit of the constructor arguments recorded for Tron deployments.
 *
 * Run it before trusting the deploy log to reconstruct a Tron deployment: a
 * record's constructor arguments are what a verifier appends to creation code,
 * so a record understating them describes a deployment that never happened.
 *
 * Needs `forge build` output, the deployment-log database, and the repo root as
 * the working directory.
 */

import { existsSync, readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { loadForgeArtifact } from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { EnvironmentEnum } from '../../common/types'
import { OUT_ROOT, getEnvVar } from '../../utils/utils'
import { getContractVersion } from '../shared/getContractVersion'
import {
  DatabaseConnectionManager,
  type IConfig,
  type IDeploymentRecord,
} from '../shared/mongo-log-utils'

import {
  assertRecordedArgsMatchAbi,
  constructorInputTypes,
} from './constructor-args'

/** Networks whose records this audit covers unless `--networks` says otherwise. */
const TRON_NETWORKS = ['tron', 'tronshasta'] as const

/** Keeps operator-shaped strings out of the `$in` filter; every key in `config/networks.json` matches. */
const NETWORK_KEY_RE = /^[a-zA-Z0-9-]+$/

/** Record fields reach a filesystem path, so they get the same guard `getContractVersion` applies. */
const CONTRACT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `<version>-tron[-rN]` marks a contract the fork overlays, i.e. built from source this repo does not hold. */
const FORK_VERSION_RE = /-tron(-r\d+)?$/

const DATABASE_NAME = 'contract-deployments'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The fields of a deployment record this audit reads. */
export interface IAuditableRecord {
  contractName: string
  network: string
  version: string
  address: string
  timestamp: Date
  /** Absent on records written before the field existed. */
  constructorArgs: string | undefined
  /** Present since EXSC-330; the commit whose source settles a drifted record. */
  gitCommitHash: string | undefined
}

/**
 * Where the ABI behind a record's assessment came from.
 *
 * Artifacts exist only for the working tree, so only `same-version` puts the
 * record's own ABI in hand. A plain version means the fork's source is
 * identical to this repo's — the fork-delta guard rejects an undeclared
 * divergence — so a Tron record at a plain version is still judged against the
 * source it was built from.
 */
export type AbiProvenance =
  | 'same-version'
  | 'fork-overlay'
  | 'version-drift'
  | 'unknown-source-version'

/** A record judged against its own ABI. The mismatch is a fact. */
export interface IConclusiveFinding {
  record: IAuditableRecord
  declaredTypes: string[]
  message: string
}

/**
 * A record whose ABI is not in the working tree. `workingTreeWouldSay` is what
 * the assertion produces against the ABI that IS here — a lead to chase, never
 * a verdict, because the deployed version's constructor may have differed.
 */
export interface IUnverifiedRecord {
  record: IAuditableRecord
  workingTreeTypes: string[]
  workingTreeWouldSay: string | null
  provenance: AbiProvenance
  sourceVersion: string | null
}

export interface IUnauditableRecord {
  record: IAuditableRecord
  reason: string
}

export interface IAuditReport {
  examined: number
  consistent: number
  findings: IConclusiveFinding[]
  unverified: IUnverifiedRecord[]
  unauditable: IUnauditableRecord[]
}

export interface IAuditDependencies {
  /** Resolves a contract's compiled ABI. Rejects when there is no artifact. */
  loadAbi: (contractName: string) => Promise<unknown>
  /** Resolves the working tree's `@custom:version`. Rejects when unreadable. */
  loadSourceVersion: (contractName: string) => Promise<string>
}

type ContractLookup =
  | { available: true; types: string[]; sourceVersion: string | null }
  | { available: false; reason: string }

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const resolveContract = async (
  contractName: string,
  deps: IAuditDependencies
): Promise<ContractLookup> => {
  if (!CONTRACT_NAME_RE.test(contractName))
    return {
      available: false,
      reason: `'${contractName}' is not a Solidity identifier, so no artifact can be resolved for it`,
    }

  let abi: unknown
  try {
    abi = await deps.loadAbi(contractName)
  } catch (error) {
    return {
      available: false,
      reason: `no compiled ABI (${describeError(error)})`,
    }
  }

  let types: string[]
  try {
    types = constructorInputTypes(abi, contractName)
  } catch (error) {
    return {
      available: false,
      reason: `constructor types unreadable (${describeError(error)})`,
    }
  }

  let sourceVersion: string | null = null
  try {
    sourceVersion = await deps.loadSourceVersion(contractName)
  } catch {
    // Leaves the record unverified rather than judged, which is the safe side.
  }

  return { available: true, types, sourceVersion }
}

export const provenanceOf = (
  recordedVersion: string,
  sourceVersion: string | null
): AbiProvenance => {
  if (FORK_VERSION_RE.test(recordedVersion)) return 'fork-overlay'
  if (sourceVersion === null) return 'unknown-source-version'
  return sourceVersion === recordedVersion ? 'same-version' : 'version-drift'
}

/** Runs the assertion, returning its complaint or null when the record passes. */
const assertionResult = (
  contractName: string,
  recorded: string,
  types: readonly string[]
): string | null => {
  try {
    assertRecordedArgsMatchAbi(contractName, recorded, types)
    return null
  } catch (error) {
    return describeError(error)
  }
}

/**
 * Checks each record's recorded constructor arguments against its contract's ABI.
 *
 * A record is only given a verdict when the working tree holds the version it
 * names. Judging a drifted record would state the wrong arity as fact — the
 * constructor may have taken a different number of arguments then — and acting
 * on that would corrupt a correct record, so those go to `unverified` with what
 * the working tree's ABI would have said attached as a lead.
 *
 * Lookups are memoised per contract, so a contract deployed on both Tron
 * networks is read once.
 *
 * @param records - Deployment records to audit, in the order to report them.
 * @param deps - Artifact and source-version lookups, injected so the audit is
 * testable without a build.
 * @returns Conclusive findings, records needing the deployed version's ABI, and
 * records no ABI could be resolved for.
 */
export const auditRecords = async (
  records: readonly IAuditableRecord[],
  deps: IAuditDependencies
): Promise<IAuditReport> => {
  const lookups = new Map<string, ContractLookup>()
  const report: IAuditReport = {
    examined: records.length,
    consistent: 0,
    findings: [],
    unverified: [],
    unauditable: [],
  }

  for (const record of records) {
    let lookup = lookups.get(record.contractName)
    if (!lookup) {
      lookup = await resolveContract(record.contractName, deps)
      lookups.set(record.contractName, lookup)
    }

    if (!lookup.available) {
      report.unauditable.push({ record, reason: lookup.reason })
      continue
    }

    const complaint = assertionResult(
      record.contractName,
      record.constructorArgs ?? '',
      lookup.types
    )
    const provenance = provenanceOf(record.version, lookup.sourceVersion)

    if (provenance !== 'same-version') {
      report.unverified.push({
        record,
        workingTreeTypes: lookup.types,
        workingTreeWouldSay: complaint,
        provenance,
        sourceVersion: lookup.sourceVersion,
      })
      continue
    }

    if (complaint === null) report.consistent++
    else
      report.findings.push({
        record,
        declaredTypes: lookup.types,
        message: complaint,
      })
  }

  return report
}

/**
 * Parses `--networks` into network keys.
 *
 * @param value - Comma-separated list from the CLI.
 * @returns The trimmed, non-empty entries.
 * @throws When the list is empty or an entry is not shaped like a network key.
 */
export const parseNetworks = (value: string): string[] => {
  const networks = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  if (networks.length === 0)
    throw new Error('--networks must name at least one network')

  const invalid = networks.filter((entry) => !NETWORK_KEY_RE.test(entry))
  if (invalid.length > 0)
    throw new Error(
      `--networks holds invalid network keys: ${invalid.join(', ')}`
    )

  return networks
}

/**
 * Parses `--env` into the collections to read.
 *
 * @param value - `'production'`, `'staging'` or `'all'`.
 * @returns The collection names to audit.
 * @throws When the value names no known environment.
 */
export const parseEnvironments = (
  value: string
): (keyof typeof EnvironmentEnum)[] => {
  if (value === 'all') return ['production', 'staging']
  if (value === 'production' || value === 'staging') return [value]
  throw new Error(
    `--env must be 'production', 'staging' or 'all', got '${value}'`
  )
}

/** Renders a record as one line of the report. */
export const formatRecord = (record: IAuditableRecord): string =>
  [
    record.network.padEnd(11),
    `v${record.version}`.padEnd(14),
    record.address.padEnd(36),
    record.timestamp instanceof Date && !isNaN(record.timestamp.getTime())
      ? record.timestamp.toISOString().slice(0, 10)
      : 'unknown-date',
    `recorded: ${
      record.constructorArgs === undefined
        ? '(field absent)'
        : `'${record.constructorArgs}'`
    }`,
  ].join('  ')

const PROVENANCE_LEGEND: Record<AbiProvenance, string> = {
  'same-version': 'the working tree holds this version',
  'fork-overlay':
    'a `-tron` version is built from the fork’s own source, which this repo does not hold',
  'version-drift': 'the working tree holds a different version',
  'unknown-source-version': 'the working tree version could not be read',
}

const groupBy = <T>(
  items: readonly T[],
  key: (item: T) => string
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const group = grouped.get(key(item)) ?? []
    group.push(item)
    grouped.set(key(item), group)
  }
  return grouped
}

/** How to settle a record whose ABI is not in the working tree. */
const settleHint = (record: IAuditableRecord): string =>
  record.gitCommitHash
    ? `read the constructor at the recorded commit: git show ${record.gitCommitHash}:src/**/${record.contractName}.sol`
    : `no commit recorded; find the source at v${record.version} to settle this`

/**
 * Builds the report's lines, grouped by severity.
 *
 * Separate from printing so the wording is testable without capturing a logger.
 *
 * @param environment - Collection the report is for.
 * @param networks - Network keys the records were read from.
 * @param report - Result of {@link auditRecords}.
 * @returns One entry per block, tagged with the level it should be logged at.
 */
export const renderReport = (
  environment: string,
  networks: readonly string[],
  report: IAuditReport
): { level: 'info' | 'warn' | 'error' | 'box'; text: string }[] => {
  const blocks: { level: 'info' | 'warn' | 'error' | 'box'; text: string }[] = [
    {
      level: 'info',
      text: `${environment}: examined ${
        report.examined
      } record(s) on ${networks.join(', ')}`,
    },
  ]

  for (const [contractName, findings] of groupBy(
    report.findings,
    (finding) => finding.record.contractName
  )) {
    const [first] = findings
    if (!first) continue
    blocks.push({
      level: 'error',
      text: [
        `${contractName} - ${findings.length} record(s) disagree with the ABI they were built from`,
        `  constructor: (${first.declaredTypes.join(', ') || 'no arguments'})`,
        // Per record: records under one contract fail for different reasons
        // (recorded nothing vs recorded too few words).
        ...findings.flatMap((finding) => [
          `  ${formatRecord(finding.record)}`,
          `    ${finding.message}`,
        ]),
      ].join('\n'),
    })
  }

  if (report.unverified.length > 0)
    blocks.push({
      level: 'warn',
      text: [
        `${report.unverified.length} record(s) could not be verified - the working tree does not hold the version they name.`,
        'The lines below are leads, NOT verdicts: the deployed version may have taken a different number of arguments.',
        ...report.unverified.flatMap((entry) => [
          `  ${entry.record.contractName} ${formatRecord(entry.record)}`,
          `    ${entry.provenance} (${PROVENANCE_LEGEND[entry.provenance]}${
            entry.sourceVersion
              ? `, working tree at v${entry.sourceVersion}`
              : ''
          })`,
          entry.workingTreeWouldSay
            ? `    against the working tree's ABI this would read: ${entry.workingTreeWouldSay}`
            : `    against the working tree's ABI this record is consistent`,
          `    ${settleHint(entry.record)}`,
        ]),
      ].join('\n'),
    })

  if (report.unauditable.length > 0)
    blocks.push({
      level: 'warn',
      text: [
        `${report.unauditable.length} record(s) could not be judged at all - this is not a clean result:`,
        ...report.unauditable.flatMap(({ record, reason }) => [
          `  ${record.contractName} ${formatRecord(record)}`,
          `    ${reason}`,
        ]),
      ].join('\n'),
    })

  blocks.push({
    level: 'box',
    text: [
      `environment  : ${environment}`,
      `examined     : ${report.examined}`,
      `consistent   : ${report.consistent}`,
      `findings     : ${report.findings.length}`,
      `unverified   : ${report.unverified.length}`,
      `unauditable  : ${report.unauditable.length}`,
    ].join('\n'),
  })

  return blocks
}

/** True when the run should exit non-zero. */
export const shouldFail = (
  reports: Record<string, IAuditReport>,
  strict: boolean
): boolean => {
  const all = Object.values(reports)
  const sum = (pick: (report: IAuditReport) => number): number =>
    all.reduce((total, report) => total + pick(report), 0)

  if (sum((report) => report.findings.length) > 0) return true

  // Every record unauditable is a broken build reading as "nothing found",
  // which is the one silent failure this audit exists to rule out.
  if (
    all.some(
      (report) =>
        report.examined > 0 && report.unauditable.length === report.examined
    )
  )
    return true

  return (
    strict &&
    sum((report) => report.unverified.length + report.unauditable.length) > 0
  )
}

/**
 * Loads an ABI without `loadForgeArtifact`'s per-contract "Loaded X from" line,
 * which buries the findings under one line per contract audited.
 */
const loadAbiQuietly = async (contractName: string): Promise<unknown> => {
  const level = consola.level
  consola.level = 0
  try {
    return (await loadForgeArtifact(contractName, OUT_ROOT)).abi
  } finally {
    consola.level = level
  }
}

/**
 * Fails before any record is read when the environment cannot answer for one.
 *
 * A directory check alone is not enough: a tree built under a profile that
 * writes to `out/<profile>` leaves `out/` present and empty of the artifacts
 * this reads, which would turn every record into "unauditable" - a report with
 * no findings.
 */
const assertEnvironmentCanAnswer = (): void => {
  const artifacts = existsSync(OUT_ROOT)
    ? readdirSync(OUT_ROOT).filter((entry) => entry.endsWith('.sol'))
    : []
  if (artifacts.length === 0)
    throw new Error(
      `No Foundry artifacts under ${OUT_ROOT}. Run 'forge build' with the default profile before auditing - without them every record is unauditable.`
    )

  // getContractVersion resolves `src/` against the working directory, so from
  // anywhere else every record silently loses its version provenance.
  if (resolve(process.cwd()) !== REPO_ROOT)
    throw new Error(
      `Run this from the repo root (${REPO_ROOT}); the contract source lookup resolves against the working directory.`
    )
}

const main = defineCommand({
  meta: {
    name: 'audit-recorded-constructor-args',
    description:
      'Read-only: checks the constructor arguments recorded for Tron deployments against each contract ABI',
  },
  args: {
    env: {
      type: 'string',
      description: "Collection to audit: 'production', 'staging' or 'all'",
      default: 'all',
    },
    networks: {
      type: 'string',
      description: 'Comma-separated network keys to audit',
      default: TRON_NETWORKS.join(','),
    },
    json: {
      type: 'boolean',
      description: 'Emit the report as JSON on stdout instead of a table',
      default: false,
    },
    strict: {
      type: 'boolean',
      description:
        'Also exit non-zero when records could not be verified or judged',
      default: false,
    },
  },
  async run({ args }) {
    const networks = parseNetworks(String(args.networks))
    const environments = parseEnvironments(String(args.env))

    assertEnvironmentCanAnswer()

    const config: IConfig = {
      mongoUri: getEnvVar('MONGODB_URI'),
      batchSize: 100,
      databaseName: DATABASE_NAME,
    }

    // JSON consumers parse stdout; suppress info/success but keep errors visible.
    if (args.json) consola.level = 0

    const deps: IAuditDependencies = {
      loadAbi: loadAbiQuietly,
      loadSourceVersion: getContractVersion,
    }

    const connection = DatabaseConnectionManager.getInstance(config)
    const reports: Record<string, IAuditReport> = {}

    try {
      await connection.connect()

      for (const environment of environments) {
        const records = await connection
          .getCollection<IDeploymentRecord>(environment)
          .find({ network: { $in: networks } })
          .sort({ contractName: 1, network: 1, timestamp: 1 })
          .toArray()

        reports[environment] = await auditRecords(
          records.map((record) => ({
            contractName: record.contractName,
            network: record.network,
            version: record.version,
            address: record.address,
            timestamp: record.timestamp,
            // `?? undefined` so a null field renders as absent, not as the string "null".
            constructorArgs: record.constructorArgs ?? undefined,
            gitCommitHash: record.gitCommitHash ?? undefined,
          })),
          deps
        )
      }
    } finally {
      await connection.disconnect()
    }

    if (args.json) console.log(JSON.stringify(reports, null, 2))
    else {
      for (const [environment, report] of Object.entries(reports))
        for (const block of renderReport(environment, networks, report))
          if (block.level === 'error') consola.error(block.text)
          else if (block.level === 'warn') consola.warn(block.text)
          else if (block.level === 'box') consola.box(block.text)
          else consola.info(block.text)

      consola.info(
        'Nothing was written. This audits recorded arguments only - a contract deployed but never recorded is outside it.'
      )
    }

    if (shouldFail(reports, Boolean(args.strict))) process.exit(1)
  },
})

if (import.meta.main) runMain(main)
