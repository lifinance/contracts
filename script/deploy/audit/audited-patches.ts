/**
 * Audited fork patches for the audit gate.
 *
 * A fork such as `contracts-tron` carries a small, separately audited patch on
 * top of upstream files. Declaring it in `audit/auditedPatches.json` lets the
 * gate read a patched import as the upstream source it was applied to, so the
 * contracts importing it are judged against their own audits exactly as
 * upstream would judge them. Only a file whose audit-relevant hash matches the
 * declared patch is substituted (comment-only edits still match, as everywhere
 * else in the gate); anything else is read as-is and drifts as before.
 */

import type { Hex } from 'viem'

import { readContractVersion } from '../shared/contract-version'

import { contractNameFromPath } from './audit-gate'
import type { IAuditLogFile } from './audit-log-guard'
import {
  hashAuditRelevantSource,
  parseImports,
  type ISourceReader,
} from './source-closure'

export const AUDITED_PATCHES_PATH = 'audit/auditedPatches.json'

export interface IAuditedPatch {
  /** Audit-relevant hash of the patched file, as the closure's per-file hashes compute it. */
  patchedSourceHash: Hex
  /** Upstream commit the patch was applied to; must be in the audit commit's history. */
  upstreamCommit: string
  /** The audit that reviewed the patch on top of that upstream source. */
  auditId: string
}

/** Patched file path to its declaration. */
export type AuditedPatches = Record<string, IAuditedPatch>

/** What the gate reads a declared patch as, wherever it finds it. */
export interface IPatchSubstitution {
  patchedSourceHash: Hex
  upstreamSource: string
}

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

  // Lower-cased because the source hashes it is compared against always are.
  return {
    patchedSourceHash: patchedSourceHash.toLowerCase() as Hex,
    upstreamCommit: upstreamCommit.toLowerCase(),
    auditId,
  }
}

/**
 * Validates a parsed `auditedPatches.json`.
 *
 * @param raw - the parsed JSON.
 * @param log - the audit log the declared audit ids must exist in.
 * @returns the declarations, keyed by patched file path.
 * @throws Error naming the offending entry when its shape is wrong or its audit
 *   is not in the log.
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

export interface IPatchGit {
  /** Reads a file at a tree-ish; `undefined` when absent or unreadable. */
  readAt: (treeish: string, path: string) => string | undefined
  /** Whether `ancestor` is in `descendant`'s history. */
  isAncestor: (ancestor: string, descendant: string) => boolean
}

/**
 * Checks a declaration against the audit it cites, whatever PR head holds.
 *
 * Runs before the substitution is kept, because it also applies at audit
 * commits when PR head no longer matches. The audit's commit must hold the
 * declared patch, so the declaration cannot vouch for source the audit never
 * reviewed, however that source reached the branch. And the upstream commit
 * must be in that commit's history, or an entry could point importers at an
 * upstream base the patch was never applied to.
 */
const assertDeclarationMatchesAudit = (
  path: string,
  patch: IAuditedPatch,
  log: IAuditLogFile,
  { readAt, isAncestor }: IPatchGit
): void => {
  const auditCommit = log.audits[patch.auditId]?.auditCommitHash
  if (
    auditCommit === undefined ||
    !isAncestor(patch.upstreamCommit, auditCommit)
  )
    throw new Error(
      `${path}: upstreamCommit ${
        patch.upstreamCommit
      } is not in the history of audit '${patch.auditId}' (${
        auditCommit ?? 'no auditCommitHash'
      }), so it is not the base that audit reviewed the patch on`
    )

  const audited = readAt(auditCommit, path)
  const auditedHash =
    audited === undefined ? undefined : hashAuditRelevantSource(audited)
  if (auditedHash !== patch.patchedSourceHash)
    throw new Error(
      `${path}: audit '${patch.auditId}' reviewed ${
        auditedHash ?? '(unreadable)'
      }, not the declared patch ${patch.patchedSourceHash}`
    )
}

/**
 * Checks a patch PR head matches against the log and against upstream.
 *
 * The audit must be recorded for the version the patch declares, or an upstream
 * audit of the same contract could vouch for it. And the patch may import only
 * what upstream imports: reading it as upstream drops its own imports from every
 * importer's closure, so a file only the patch imports would escape the gate.
 */
const assertPatchCanBeSubstituted = (
  path: string,
  patch: IAuditedPatch,
  sources: { head: string; upstream: string },
  log: IAuditLogFile
): void => {
  const name = contractNameFromPath(path)
  const read = readContractVersion(sources.head)
  const version = read.kind === 'ok' ? read.version : undefined
  const listed =
    version !== undefined &&
    (log.auditedContracts[name]?.[version]?.includes(patch.auditId) ?? false)
  if (!listed)
    throw new Error(
      `${path}: audit '${patch.auditId}' is not listed for ${name}@${
        version ?? '(no readable version)'
      }`
    )

  const upstreamImports = new Set(parseImports(sources.upstream))
  const added = parseImports(sources.head).filter(
    (specifier) => !upstreamImports.has(specifier)
  )
  if (added.length > 0)
    throw new Error(
      `${path}: the patch imports ${added.join(
        ', '
      )}, which upstream does not — reading it as upstream would hide those files`
    )
}

export interface IResolvedPatches {
  /** Patched path to what the gate reads it as. */
  substitutions: Map<string, IPatchSubstitution>
  /** A log line per declaration PR head matches. */
  applied: string[]
  /** A log line per declaration PR head does not match, with the head hash. */
  mismatched: string[]
}

/**
 * Loads each declared patch's upstream source and checks it against PR head.
 *
 * @param patches - from {@link parseAuditedPatches}.
 * @param log - the audit log.
 * @param headTreeish - the tree-ish holding PR head.
 * @param git - file reads and ancestry checks against the repository.
 * @returns the substitutions and a log line per declaration.
 * @throws Error when an upstream source cannot be read, when a declaration is
 *   not the source at its audit commit or names an upstream commit outside that
 *   commit's history, or when a patch PR head matches is not audited at its
 *   version or imports what upstream does not.
 */
export const resolveAuditedPatches = (
  patches: AuditedPatches,
  log: IAuditLogFile,
  headTreeish: string,
  git: IPatchGit
): IResolvedPatches => {
  const resolved: IResolvedPatches = {
    substitutions: new Map(),
    applied: [],
    mismatched: [],
  }

  for (const [path, patch] of Object.entries(patches)) {
    const upstream = git.readAt(patch.upstreamCommit, path)
    if (upstream === undefined)
      throw new Error(
        `${path}: upstream source at ${patch.upstreamCommit} could not be read`
      )
    assertDeclarationMatchesAudit(path, patch, log, git)
    resolved.substitutions.set(path, {
      patchedSourceHash: patch.patchedSourceHash,
      upstreamSource: upstream,
    })

    const head = git.readAt(headTreeish, path)
    const headHash =
      head === undefined ? undefined : hashAuditRelevantSource(head)
    if (head === undefined || headHash !== patch.patchedSourceHash) {
      resolved.mismatched.push(
        `${path}: not read as upstream — PR head (${
          headHash ?? 'absent'
        }) is not the patch audited in '${patch.auditId}' (${
          patch.patchedSourceHash
        })`
      )
      continue
    }

    assertPatchCanBeSubstituted(path, patch, { head, upstream }, log)
    resolved.applied.push(
      `${path}: read as upstream ${patch.upstreamCommit} — PR head is the patch audited in '${patch.auditId}'`
    )
  }

  return resolved
}

/**
 * Wraps a reader so declared patches read as their upstream source.
 *
 * Applied at every tree-ish the gate reads, PR head and audit commits alike, so
 * a contract audited on a fork commit that already held the patch compares
 * upstream against upstream rather than drifting. A contract that is itself a
 * declared patch reads everything as-is: it and the patches it imports were
 * audited together, as patched code.
 *
 * @param reader - the reader at one tree-ish.
 * @param substitutions - from {@link resolveAuditedPatches}.
 * @param contractPath - the contract whose closure is being read.
 * @returns a reader for that contract's closure.
 */
export const withAuditedPatches = (
  reader: ISourceReader,
  substitutions: Map<string, IPatchSubstitution>,
  contractPath: string
): ISourceReader => {
  if (substitutions.size === 0 || substitutions.has(contractPath)) return reader

  return {
    readFile: (path) => {
      const source = reader.readFile(path)
      const patch = substitutions.get(path)
      return patch !== undefined &&
        source !== undefined &&
        hashAuditRelevantSource(source) === patch.patchedSourceHash
        ? patch.upstreamSource
        : source
    },
    readSubmodulePointer: (path) => reader.readSubmodulePointer(path),
  }
}
