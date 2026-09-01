/**
 * CI entry point for the content-equality audit gate.
 *
 * Reads the contracts the version-control step flagged, hashes each one's import
 * closure at PR head and at every audit commit that claims to cover it, and
 * blocks unless some audit describes the source actually being merged.
 *
 * Exit codes are distinct on purpose: 1 is a mismatch the author can fix, 2 is
 * the gate not knowing. Both block — per T3 not-knowing has no acknowledgement
 * path — but a single code would hide a broken gate behind what reads as an
 * unaudited contract.
 */

import { readFileSync } from 'node:fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  extractContractVersion,
  parseContractList,
  resolveContractSource,
  runAuditGate,
  type IContractUnderCheck,
} from './audit-gate'
import type { IAuditLogFile } from './audit-log-guard'
import { createClosureReader, createGitSourceReader } from './git-source-reader'

const EXIT_FAIL = 1
const EXIT_ERROR = 2
const DEFAULT_AUDIT_LOG = 'audit/auditLog.json'

const readContracts = (
  paths: string[],
  cwd: string,
  headTreeish: string
): IContractUnderCheck[] => {
  const reader = createGitSourceReader(headTreeish, cwd)

  return paths.map((path) => {
    const source = reader.readFile(path)
    const version = source ? extractContractVersion(source) : undefined

    // Refused here rather than allowed through: with no version the gate cannot
    // look up coverage, and the resulting "no audit found" would read as an
    // unaudited contract instead of a malformed one.
    if (!version)
      throw new Error(
        `could not read a @custom:version from ${path} at ${headTreeish}`
      )

    return { path, version }
  })
}

const main = defineCommand({
  meta: {
    name: 'verify-audit-gate',
    description:
      'Blocks unless an audit covers the source closure at PR head (content, not provenance)',
  },
  args: {
    contracts: {
      type: 'string',
      description: 'Contract paths, comma- or newline-separated',
    },
    contractsFile: {
      type: 'string',
      description: 'File holding the contract paths (contracts_for_audit.txt)',
    },
    // No `default` here on purpose. citty shadows a multi-word arg's camelCase
    // key with its default value, so `--audit-log X` would parse into
    // `args['audit-log']` while `args.auditLog` still read the default — the
    // flag would be silently ignored. Single-word args are unaffected.
    auditLog: {
      type: 'string',
      description: 'Path to the audit log (default: audit/auditLog.json)',
    },
    head: {
      type: 'string',
      description: 'Tree-ish holding PR head',
      default: 'HEAD',
    },
    prTitle: {
      type: 'string',
      description: 'PR title — logged only; the gate has no title exemption',
    },
  },
  run({ args }) {
    const source = resolveContractSource(args)

    // Not a usage nicety: citty ignores an unrecognised flag, so a renamed
    // --contracts-file would leave the list empty, and an empty list is a
    // legitimate pass. Refusing here keeps a miswired gate loud.
    if (source.kind === 'absent') {
      consola.error(
        'Neither --contracts nor --contracts-file was supplied, so the gate was never told what to check. Refusing to report a verdict.'
      )
      process.exit(EXIT_ERROR)
    }

    let raw: string
    try {
      raw =
        source.kind === 'provided'
          ? source.raw
          : readFileSync(source.path, 'utf8')
    } catch (error: unknown) {
      consola.error(
        `Could not read the contract list at ${
          source.kind === 'file' ? source.path : '(inline)'
        }: ${error instanceof Error ? error.message : String(error)}`
      )
      process.exit(EXIT_ERROR)
    }

    const paths = parseContractList(raw)

    if (paths.length === 0) {
      consola.success('No contracts require an audit — nothing to verify.')
      return
    }

    const cwd = process.cwd()
    const auditLogPath = args.auditLog ?? DEFAULT_AUDIT_LOG
    let log: IAuditLogFile
    try {
      log = JSON.parse(readFileSync(auditLogPath, 'utf8')) as IAuditLogFile
    } catch (error: unknown) {
      // ERROR, not FAIL: an unreadable or malformed log means the gate has no
      // expectation to compare against, which per T3 blocks without an
      // acknowledgement path rather than reading as an unaudited contract.
      consola.error(
        `Could not read the audit log at ${auditLogPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      process.exit(EXIT_ERROR)
    }

    if (args.prTitle)
      consola.info(
        `PR title: ${args.prTitle} — recorded for the log only, it grants no exemption.`
      )

    const report = runAuditGate({
      log,
      contracts: readContracts(paths, cwd, args.head),
      headTreeish: args.head,
      deps: { closureAt: createClosureReader(cwd, args.head) },
      prTitle: args.prTitle,
    })

    for (const result of report.results) {
      const line = `${result.verdict.toUpperCase()} — ${result.reason}`
      if (result.verdict === 'pass') consola.success(line)
      else if (result.verdict === 'fail') consola.error(line)
      else consola.warn(line)
    }

    if (report.verdict === 'pass') {
      consola.success(
        `Audit gate passed: all ${report.results.length} contract(s) match audited source.`
      )
      return
    }

    consola.error(
      report.verdict === 'error'
        ? 'Audit gate could not reach a verdict. This blocks — it is not an acknowledgeable warning.'
        : 'Audit gate blocked: the source at PR head is not the source that was audited.'
    )
    process.exit(report.verdict === 'error' ? EXIT_ERROR : EXIT_FAIL)
  },
})

runMain(main)
