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

import { decideAppendOnly, type IAuditLogFile } from './audit-log-guard'
import {
  createGitSourceReader,
  ensureCommitAvailable,
} from './git-source-reader'

const EXIT_FAIL = 1
const EXIT_ERROR = 2
const DEFAULT_AUDIT_LOG = 'audit/auditLog.json'

const readLogAt = (
  treeish: string,
  path: string,
  cwd: string
): IAuditLogFile | undefined => {
  const contents = createGitSourceReader(treeish, cwd).readFile(path)
  if (contents === undefined) return undefined

  try {
    return JSON.parse(contents) as IAuditLogFile
  } catch (error: unknown) {
    // Not returned as undefined: that means "absent", and an absent log at base
    // is a pass. Malformed is the opposite — the guard cannot tell what was
    // recorded, so it must not report the file as untouched.
    throw new Error(
      `${path} at ${treeish} is not valid JSON, so the audit log cannot be compared: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
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
    // No `default`: citty shadows a multi-word arg's camelCase key with its
    // default, which would make `--audit-log` silently ignored.
    auditLog: {
      type: 'string',
      description: 'Path to the audit log (default: audit/auditLog.json)',
    },
  },
  run({ args }) {
    const cwd = process.cwd()

    const auditLogPath = args.auditLog ?? DEFAULT_AUDIT_LOG

    const decision = decideAppendOnly({
      auditLogPath,
      baseTreeish: args.base,
      headTreeish: args.head,
      baseResolved: ensureCommitAvailable(args.base, cwd),
      before: readLogAt(args.base, auditLogPath, cwd),
      after: readLogAt(args.head, auditLogPath, cwd),
    })

    if (decision.verdict === 'pass') {
      consola.success(decision.reason)
      return
    }

    consola.error(decision.reason)
    process.exit(decision.verdict === 'error' ? EXIT_ERROR : EXIT_FAIL)
  },
})

runMain(main)
