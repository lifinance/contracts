#!/usr/bin/env bun

/**
 * Read-only audit of the constructor arguments recorded for Tron deployments.
 *
 * A record's constructor arguments are what a verifier appends to creation code
 * when it rebuilds a deployment, so a record understating them describes a
 * deployment that never happened.
 *
 * This runs `assertRecordedArgsMatchAbi` over records that already exist rather
 * than over an encoder's fresh output, which is the only place its emptiness and
 * arity checks can actually fire. It never writes: correcting a record changes
 * what a verifier reconstructs, so each finding is a human's call.
 *
 * Needs `forge build` output and a `lifi-connect prod smart-contracts` tunnel.
 */

import { existsSync } from 'fs'

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

const DATABASE_NAME = 'contract-deployments'

/** The fields of a deployment record this audit reads. */
export interface IAuditableRecord {
  contractName: string
  network: string
  version: string
  address: string
  timestamp: Date
  /** Absent on records written before the field existed. */
  constructorArgs: string | undefined
}

/**
 * How far the ABI behind a verdict is from the one the record was written
 * against. Artifacts only exist for the working tree, so a record for an older
 * version is judged against a constructor that may since have changed.
 */
export type AbiProvenance =
  | 'same-version'
  | 'version-drift'
  | 'unknown-source-version'

export interface IConstructorArgsFinding {
  record: IAuditableRecord
  /** Constructor types read from the artifact, in declaration order. */
  declaredTypes: string[]
  /** What `assertRecordedArgsMatchAbi` said is wrong with this record. */
  message: string
  provenance: AbiProvenance
  /** `@custom:version` in the working tree, or null when it cannot be read. */
  sourceVersion: string | null
}

export interface IUnauditableRecord {
  record: IAuditableRecord
  reason: string
}

export interface IAuditReport {
  examined: number
  consistent: number
  findings: IConstructorArgsFinding[]
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
    // A contract whose source has since been deprecated can still have an
    // artifact, so the verdict stands - only its provenance is weaker.
  }

  return { available: true, types, sourceVersion }
}

const provenanceOf = (
  recordedVersion: string,
  sourceVersion: string | null
): AbiProvenance => {
  if (sourceVersion === null) return 'unknown-source-version'
  return sourceVersion === recordedVersion ? 'same-version' : 'version-drift'
}

/**
 * Checks each record's recorded constructor arguments against its contract's ABI.
 *
 * Lookups are memoised per contract, so a contract deployed on both Tron
 * networks is read once.
 *
 * @param records - Deployment records to audit, in the order to report them.
 * @param deps - Artifact and source-version lookups, injected so the audit is
 * testable without a build.
 * @returns Counts plus every record that failed the assertion and every record
 * that could not be judged.
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

    try {
      assertRecordedArgsMatchAbi(
        record.contractName,
        record.constructorArgs ?? '',
        lookup.types
      )
      report.consistent++
    } catch (error) {
      report.findings.push({
        record,
        declaredTypes: lookup.types,
        message: describeError(error),
        provenance: provenanceOf(record.version, lookup.sourceVersion),
        sourceVersion: lookup.sourceVersion,
      })
    }
  }

  return report
}

/** Parses `--networks`, rejecting entries not shaped like a network key. */
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

const parseEnvironments = (value: string): (keyof typeof EnvironmentEnum)[] => {
  if (value === 'all') return ['production', 'staging']
  if (value === 'production' || value === 'staging') return [value]
  throw new Error(
    `--env must be 'production', 'staging' or 'all', got '${value}'`
  )
}

/** Renders a record as one line, tagged with the provenance of its verdict. */
const formatRecord = (
  record: IAuditableRecord,
  provenance?: AbiProvenance
): string =>
  [
    record.network.padEnd(11),
    `v${record.version}`.padEnd(10),
    record.address.padEnd(36),
    record.timestamp instanceof Date && !isNaN(record.timestamp.getTime())
      ? record.timestamp.toISOString().slice(0, 10)
      : 'unknown-date',
    ...(provenance ? [`[${provenance}]`.padEnd(24)] : []),
    `recorded: ${
      record.constructorArgs === undefined
        ? '(field absent)'
        : `'${record.constructorArgs}'`
    }`,
  ].join('  ')

const PROVENANCE_LEGEND: Record<AbiProvenance, string> = {
  'same-version':
    'the working tree holds this exact version, so the ABI is the one the record was written against',
  'version-drift':
    'the working tree holds a different version - confirm the constructor of the deployed version before acting',
  'unknown-source-version':
    'the working tree version could not be read - confirm the constructor of the deployed version before acting',
}

const groupByContract = (
  findings: readonly IConstructorArgsFinding[]
): Map<string, IConstructorArgsFinding[]> => {
  const grouped = new Map<string, IConstructorArgsFinding[]>()
  for (const finding of findings) {
    const group = grouped.get(finding.record.contractName) ?? []
    group.push(finding)
    grouped.set(finding.record.contractName, group)
  }
  return grouped
}

const printReport = (
  environment: string,
  networks: readonly string[],
  report: IAuditReport
): void => {
  consola.info(
    `${environment}: examined ${report.examined} record(s) on ${networks.join(
      ', '
    )}`
  )

  for (const [contractName, findings] of groupByContract(report.findings)) {
    const [first] = findings
    if (!first) continue
    consola.error(
      [
        `${contractName} - ${findings.length} record(s) disagree with the ABI`,
        `  constructor: (${first.declaredTypes.join(', ') || 'no arguments'})`,
        // Per record rather than per group: records under one contract fail for
        // different reasons (recorded nothing vs recorded too few words).
        ...findings.flatMap((finding) => [
          `  ${formatRecord(finding.record, finding.provenance)}`,
          `    ${finding.message}`,
        ]),
      ].join('\n')
    )
  }

  if (report.unauditable.length > 0)
    consola.warn(
      [
        `${report.unauditable.length} record(s) could not be judged - this is not a clean result:`,
        ...report.unauditable.flatMap(({ record, reason }) => [
          `  ${record.contractName} ${formatRecord(record)}`,
          `    ${reason}`,
        ]),
      ].join('\n')
    )

  const provenances = new Set(report.findings.map((f) => f.provenance))
  if (provenances.size > 0)
    consola.info(
      ['ABI provenance of the verdicts above:']
        .concat(
          [...provenances].map(
            (provenance) => `  ${provenance}: ${PROVENANCE_LEGEND[provenance]}`
          )
        )
        .join('\n')
    )

  consola.box(
    [
      `environment  : ${environment}`,
      `examined     : ${report.examined}`,
      `consistent   : ${report.consistent}`,
      `findings     : ${report.findings.length}`,
      `unauditable  : ${report.unauditable.length}`,
    ].join('\n')
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
      description: 'Also exit non-zero when records could not be judged',
      default: false,
    },
  },
  async run({ args }) {
    const networks = parseNetworks(String(args.networks))
    const environments = parseEnvironments(String(args.env))

    // Without a build every contract reads as "no artifact", which a reader
    // takes for an audit that found nothing wrong.
    if (!existsSync(OUT_ROOT))
      throw new Error(
        `No Foundry artifacts at ${OUT_ROOT}. Run 'forge build' before auditing - without them every record is unauditable.`
      )

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
            constructorArgs: record.constructorArgs,
          })),
          deps
        )
      }
    } finally {
      await connection.disconnect()
    }

    if (args.json) console.log(JSON.stringify(reports, null, 2))
    else
      for (const [environment, report] of Object.entries(reports))
        printReport(environment, networks, report)

    const all = Object.values(reports)
    const findings = all.reduce((sum, r) => sum + r.findings.length, 0)
    const unauditable = all.reduce((sum, r) => sum + r.unauditable.length, 0)

    if (!args.json && findings > 0)
      consola.info(
        'Nothing was written. A record drives what a verifier reconstructs, so each correction needs a decision before it is applied.'
      )

    if (findings > 0 || (args.strict && unauditable > 0)) process.exit(1)
  },
})

if (import.meta.main) runMain(main)
