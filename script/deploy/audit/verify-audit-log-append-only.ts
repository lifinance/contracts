/**
 * CI entry point for the append-only guard on `audit/auditLog.json`.
 *
 * The content gate compares source against the hash recorded in this file, so an
 * author who can rewrite an existing entry defeats the gate inside the same PR.
 * This compares the file on the PR's base against PR head and blocks any change
 * to already-recorded history. Adding entries, contracts, versions and audit ids
 * stays free — the file is meant to grow.
 *
 * It must run whenever the file changes, independently of whether the PR touches
 * a contract: tampering with the log is exactly the move that would otherwise
 * arrive in a PR the audit gate never inspects.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  diffAuditLog,
  formatAuditLogViolations,
  type IAuditLogFile,
} from './audit-log-guard'
import { createGitSourceReader } from './git-source-reader'

const readLogAt = (
  treeish: string,
  path: string,
  cwd: string
): IAuditLogFile | undefined => {
  const contents = createGitSourceReader(treeish, cwd).readFile(path)
  if (contents === undefined) return undefined

  return JSON.parse(contents) as IAuditLogFile
}

const main = defineCommand({
  meta: {
    name: 'verify-audit-log-append-only',
    description:
      'Blocks a PR that rewrites history already recorded in the audit log',
  },
  args: {
    base: {
      type: 'string',
      description: "Tree-ish for the PR's base",
      required: true,
    },
    head: {
      type: 'string',
      description: 'Tree-ish for PR head',
      default: 'HEAD',
    },
    auditLog: {
      type: 'string',
      description: 'Path to the audit log',
      default: 'audit/auditLog.json',
    },
  },
  run({ args }) {
    const cwd = process.cwd()
    const before = readLogAt(args.base, args.auditLog, cwd)
    const after = readLogAt(args.head, args.auditLog, cwd)

    if (after === undefined) {
      // Deleting the log is not "no violations" — it removes every recorded
      // expectation at once, which is the strongest form of the tampering this
      // guard exists to catch.
      consola.error(
        `${args.auditLog} does not exist at ${args.head}. The audit log cannot be removed.`
      )
      process.exit(1)
    }

    if (before === undefined) {
      consola.success(
        `${args.auditLog} does not exist at ${args.base} — nothing recorded yet, so nothing can have been rewritten.`
      )
      return
    }

    const { violations } = diffAuditLog(before, after)

    if (violations.length === 0) {
      consola.success(
        `${args.auditLog} is append-only in this PR: no existing entry was changed or removed.`
      )
      return
    }

    consola.error(formatAuditLogViolations(violations))
    consola.error(
      `The audit log is append-only. ${violations.length} existing record(s) were modified or removed — add new entries instead.`
    )
    process.exit(1)
  },
})

runMain(main)
