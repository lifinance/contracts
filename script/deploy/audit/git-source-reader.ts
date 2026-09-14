/**
 * Git-backed {@link ISourceReader} for the audit gate.
 *
 * Kept separate from `source-closure.ts` so that module stays free of
 * subprocesses and testable in memory. Use this to read a tree-ish that is not
 * the working tree — in particular a historical `auditCommitHash`.
 */

import { execFileSync } from 'node:child_process'

import { consola } from 'consola'

import type { ClosureAtResult } from './audit-gate'
import {
  collectSourceClosure,
  computeClosureDetail,
  parseRemappings,
  type ISourceReader,
} from './source-closure'

const run = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const commitIsLocal = (treeish: string, cwd: string): boolean => {
  try {
    run(['cat-file', '-e', `${treeish}^{commit}`], cwd)
    return true
  } catch {
    return false
  }
}

/**
 * Makes a commit available locally, fetching it when unreachable from any local
 * ref — the normal case for an audit commit whose PR was squash-merged.
 *
 * @param treeish - commit SHA to ensure.
 * @param cwd - repo directory.
 * @param attempts - bounded retries before giving up.
 * @returns whether the commit is present locally afterwards.
 */
export const ensureCommitAvailable = (
  treeish: string,
  cwd: string,
  attempts = 3
): boolean => {
  if (commitIsLocal(treeish, cwd)) return true

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run(['fetch', '--quiet', '--no-tags', 'origin', treeish], cwd)
    } catch {
      if (attempt === attempts) return false
      continue
    }
    if (commitIsLocal(treeish, cwd)) return true
    if (attempt === attempts) return false
  }

  return false
}

/**
 * Creates a reader over one tree-ish, memoising every lookup — the closure walk
 * revisits shared imports (LibAsset, ILiFi) many times per contract.
 *
 * @param treeish - commit SHA, branch or tag to read.
 * @param cwd - repo directory; defaults to the process cwd.
 * @returns a reader whose misses mean "absent at this tree-ish".
 */
export const createGitSourceReader = (
  treeish: string,
  cwd: string = process.cwd()
): ISourceReader => {
  const fileCache = new Map<string, string | undefined>()
  const pointerCache = new Map<string, string | undefined>()

  return {
    readFile: (path) => {
      if (fileCache.has(path)) return fileCache.get(path)
      let contents: string | undefined
      try {
        contents = run(['show', `${treeish}:${path}`], cwd)
      } catch {
        contents = undefined
      }
      fileCache.set(path, contents)
      return contents
    },

    readSubmodulePointer: (path) => {
      if (pointerCache.has(path)) return pointerCache.get(path)
      let pointer: string | undefined
      try {
        // `160000 commit <sha>\t<path>` for a gitlink; empty when absent.
        const line = run(['ls-tree', treeish, '--', path], cwd).trim()
        pointer = /^160000 commit ([0-9a-f]{40})\s/.exec(line)?.[1]
      } catch {
        pointer = undefined
      }
      pointerCache.set(path, pointer)
      return pointer
    },
  }
}

/**
 * Builds the git-backed closure reader the audit gate injects.
 *
 * A partial closure is reported as `closure-incomplete` rather than hashed: the
 * hash would look confident while covering only the files that happened to read,
 * and the unread ones are exactly where an undetected change would sit.
 *
 * @param cwd - repo directory.
 * @param headTreeish - the tree-ish that is already checked out and needs no fetch.
 * @returns a `closureAt` implementation for the gate.
 */
export const createClosureReader =
  (cwd: string, headTreeish: string) =>
  (treeish: string, contractPath: string): ClosureAtResult => {
    if (treeish !== headTreeish && !ensureCommitAvailable(treeish, cwd))
      return 'unfetchable'

    const reader = createGitSourceReader(treeish, cwd)
    if (reader.readFile(contractPath) === undefined) return 'contract-absent'

    const remappings = parseRemappings(reader.readFile('remappings.txt') ?? '')
    const closure = collectSourceClosure(contractPath, reader, remappings)

    if (closure.missing.length > 0) {
      consola.warn(
        `closure at ${treeish} for ${contractPath} could not read: ${closure.missing.join(
          ', '
        )}`
      )
      return 'closure-incomplete'
    }

    return computeClosureDetail(closure, reader)
  }
