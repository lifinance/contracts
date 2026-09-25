/**
 * Audited fork patches for the audit gate.
 *
 * A fork such as `contracts-tron` carries a small, separately audited patch on
 * top of upstream files. Declaring it in `audit/auditedPatches.json` lets the
 * gate read a patched import at PR head as the upstream source it was applied
 * to, so the contracts importing it are judged against their own audits exactly
 * as upstream would judge them. Only a byte-exact match of the declared patch is
 * substituted; anything else is read as-is and drifts as before.
 */

import type { Hex } from 'viem'

import { contractNameFromPath } from './audit-gate'
import type { IAuditLogFile } from './audit-log-guard'
import { hashAuditRelevantSource, type ISourceReader } from './source-closure'

export const AUDITED_PATCHES_PATH = 'audit/auditedPatches.json'

export interface IAuditedPatch {
  /** Audit-relevant hash of the patched file, as the closure's per-file hashes compute it. */
  patchedSourceHash: Hex
  /** Upstream commit holding the source the patch was applied to. */
  upstreamCommit: string
  /** The audit that reviewed the patch on top of that upstream source. */
  auditId: string
}

/** Patched file path to its declaration. */
export type AuditedPatches = Record<string, IAuditedPatch>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsePatch = (
  path: string,
  value: unknown,
  log: IAuditLogFile
): IAuditedPatch => {
  if (!path.endsWith('.sol'))
    throw new Error(`${path}: only .sol files can be declared as patches`)
  if (!isRecord(value)) throw new Error(`${path}: expected an object`)

  const { patchedSourceHash, upstreamCommit, auditId } = value
  if (
    typeof patchedSourceHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(patchedSourceHash)
  )
    throw new Error(`${path}: patchedSourceHash must be a 32-byte hex hash`)
  if (
    typeof upstreamCommit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(upstreamCommit)
  )
    throw new Error(`${path}: upstreamCommit must be a full commit SHA`)
  if (typeof auditId !== 'string' || log.audits[auditId] === undefined)
    throw new Error(`${path}: auditId '${String(auditId)}' is not in the log`)

  const name = contractNameFromPath(path)
  const listed = Object.values(log.auditedContracts[name] ?? {}).some((ids) =>
    ids?.includes(auditId)
  )
  if (!listed)
    throw new Error(
      `${path}: audit '${auditId}' is not listed for ${name} in auditedContracts`
    )

  return {
    patchedSourceHash: patchedSourceHash as Hex,
    upstreamCommit,
    auditId,
  }
}

/**
 * Validates a parsed `auditedPatches.json` against the audit log.
 *
 * @param raw - the parsed JSON.
 * @param log - the audit log the declared audit ids must exist in.
 * @returns the declarations, keyed by patched file path.
 * @throws Error naming the offending entry when the shape is wrong or its audit
 *   is not recorded for that contract.
 */
export const parseAuditedPatches = (
  raw: unknown,
  log: IAuditLogFile
): AuditedPatches => {
  if (!isRecord(raw))
    throw new Error('expected an object keyed by patched file path')

  return Object.fromEntries(
    Object.entries(raw).map(([path, value]) => [
      path,
      parsePatch(path, value, log),
    ])
  )
}

export interface IResolvedPatches {
  /** Patched path to the upstream source it is read as. */
  substitutions: Map<string, string>
  /** A log line per substituted declaration. */
  applied: string[]
  /** A log line per declaration PR head does not match, with the head hash. */
  mismatched: string[]
}

/**
 * Decides which declared patches match PR head exactly.
 *
 * @param patches - from {@link parseAuditedPatches}.
 * @param headTreeish - the tree-ish holding PR head.
 * @param readAt - reads a file at a tree-ish; `undefined` when absent or unreadable.
 * @returns the substitutions to apply and a log line per declaration.
 * @throws Error when a matching patch's upstream source cannot be read, since
 *   the gate would otherwise judge the file as something it is not.
 */
export const resolveAuditedPatches = (
  patches: AuditedPatches,
  headTreeish: string,
  readAt: (treeish: string, path: string) => string | undefined
): IResolvedPatches => {
  const resolved: IResolvedPatches = {
    substitutions: new Map(),
    applied: [],
    mismatched: [],
  }

  for (const [path, patch] of Object.entries(patches)) {
    const head = readAt(headTreeish, path)
    const headHash =
      head === undefined ? undefined : hashAuditRelevantSource(head)
    if (headHash !== patch.patchedSourceHash) {
      resolved.mismatched.push(
        `${path}: not read as upstream — PR head (${
          headHash ?? 'absent'
        }) is not the patch audited in '${patch.auditId}' (${
          patch.patchedSourceHash
        })`
      )
      continue
    }

    const upstream = readAt(patch.upstreamCommit, path)
    if (upstream === undefined)
      throw new Error(
        `${path}: upstream source at ${patch.upstreamCommit} could not be read`
      )

    resolved.substitutions.set(path, upstream)
    resolved.applied.push(
      `${path}: read as upstream ${patch.upstreamCommit} — PR head is the patch audited in '${patch.auditId}'`
    )
  }

  return resolved
}

/**
 * Wraps a PR-head reader so matched patches read as their upstream source.
 *
 * A contract that is itself a declared patch reads everything as-is: it and the
 * patches it imports were audited together, as patched code.
 *
 * @param reader - the reader at PR head.
 * @param substitutions - from {@link resolveAuditedPatches}.
 * @param contractPath - the contract whose closure is being read.
 * @returns a reader for that contract's closure.
 */
export const withAuditedPatches = (
  reader: ISourceReader,
  substitutions: Map<string, string>,
  contractPath: string
): ISourceReader => {
  if (substitutions.size === 0 || substitutions.has(contractPath)) return reader

  return {
    readFile: (path) => substitutions.get(path) ?? reader.readFile(path),
    readSubmodulePointer: (path) => reader.readSubmodulePointer(path),
  }
}
