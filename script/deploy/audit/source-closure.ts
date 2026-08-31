/**
 * Source-closure hashing for the audit gate.
 *
 * Identifies a contract by the content of its full transitive import closure
 * rather than by which commit a PR happens to contain. Import this from the
 * audit gate and from anything that needs to ask "is this the same source that
 * was audited?".
 *
 * Reads through an injectable {@link ISourceReader} because the closure must be
 * computable at an arbitrary historical commit, not only in the working tree.
 * External dependencies live in git submodules, whose *contents* are absent from
 * the parent repo tree at any commit — so they are identified by their gitlink
 * SHA, which is present, and never walked.
 */

import { keccak256, toHex, type Hex } from 'viem'

export interface ISourceReader {
  /** Repo-relative path, or undefined when absent at this tree-ish. */
  readFile: (path: string) => string | undefined
  /** Gitlink SHA for a submodule dir, or undefined when absent at this tree-ish. */
  readSubmodulePointer: (path: string) => string | undefined
}

export interface IRemapping {
  prefix: string
  target: string
}

export interface IResolvedImport {
  path: string
  external: boolean
  /** Set when `external`: the submodule dir whose pointer identifies this file. */
  submoduleDir?: string
}

export interface ISourceClosure {
  /** Repo-owned files in the closure, including the entry point. Sorted. */
  files: string[]
  /** Submodule dir to gitlink SHA, for every external dependency reached. */
  dependencies: Record<string, string>
  /** Files or dependencies that could not be read at this tree-ish. Sorted. */
  missing: string[]
}

const IMPORT_RE = /\bimport\b[^;'"]*?['"]([^'"]+)['"]/g

/**
 * Strips comments so a commented-out import never joins the closure and a real
 * import inside a block comment is never counted.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

/**
 * @param source - Solidity source text.
 * @returns import specifiers in source order, duplicates preserved.
 */
export const parseImports = (source: string): string[] => {
  const stripped = stripComments(source)
  const found: string[] = []
  for (const match of stripped.matchAll(IMPORT_RE))
    if (match[1]) found.push(match[1])

  return found
}

/**
 * @param contents - the text of `remappings.txt` at this tree-ish.
 * @returns prefix/target pairs in file order, blank and malformed lines dropped.
 */
export const parseRemappings = (contents: string): IRemapping[] =>
  contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line) => {
      const separator = line.indexOf('=')
      if (separator <= 0) return []
      const prefix = line.slice(0, separator)
      const target = line.slice(separator + 1)
      return target.length > 0 ? [{ prefix, target }] : []
    })

/** Collapses `.` and `..` segments; keeps a leading `..` that escapes the root. */
const normalise = (path: string): string => {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..')
      out.pop()
    else out.push(segment)
  }

  return out.join('/')
}

const SUBMODULE_DIR_RE = /^(lib\/[^/]+)\//

/**
 * Resolves one import specifier to a repo-relative path.
 *
 * The longest matching remapping wins, matching solc: with `a/` and `a/b/` both
 * defined, `a/b/C.sol` must resolve through `a/b/`.
 *
 * @param fromPath - repo-relative path of the importing file.
 * @param specifier - the import specifier as written.
 * @param remappings - remappings in effect at this tree-ish.
 * @returns the resolved import, or undefined when no rule applies.
 */
export const resolveImport = (
  fromPath: string,
  specifier: string,
  remappings: IRemapping[]
): IResolvedImport | undefined => {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const dir = fromPath.split('/').slice(0, -1).join('/')
    return { path: normalise(`${dir}/${specifier}`), external: false }
  }

  const rule = remappings
    .filter((candidate) => specifier.startsWith(candidate.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]
  if (!rule) return undefined

  const path = normalise(rule.target + specifier.slice(rule.prefix.length))
  const submoduleDir = SUBMODULE_DIR_RE.exec(path)?.[1]

  return submoduleDir
    ? { path, external: true, submoduleDir }
    : { path, external: false }
}

/**
 * Walks the transitive closure of a contract's imports.
 *
 * External files are recorded as a dependency pointer and deliberately not
 * walked. A file or dependency that cannot be read is reported in `missing`
 * rather than throwing, so the caller decides whether that is a FAIL or an
 * ERROR — the audit gate treats the two differently.
 *
 * @param entryPath - repo-relative path of the contract.
 * @param reader - reads at the tree-ish being hashed.
 * @param remappings - remappings in effect at that tree-ish.
 * @returns sorted repo files, dependency pointers, and anything unreadable.
 */
export const collectSourceClosure = (
  entryPath: string,
  reader: ISourceReader,
  remappings: IRemapping[]
): ISourceClosure => {
  const files = new Set<string>()
  const dependencies: Record<string, string> = {}
  const missing = new Set<string>()
  const queue = [entryPath]

  while (queue.length > 0) {
    const path = queue.shift()
    if (path === undefined || files.has(path)) continue

    const source = reader.readFile(path)
    if (source === undefined) {
      missing.add(path)
      continue
    }
    files.add(path)

    for (const specifier of parseImports(source)) {
      const resolved = resolveImport(path, specifier, remappings)
      if (!resolved) {
        missing.add(specifier)
        continue
      }

      if (resolved.external && resolved.submoduleDir) {
        const pointer = reader.readSubmodulePointer(resolved.submoduleDir)
        if (pointer === undefined) missing.add(resolved.submoduleDir)
        else dependencies[resolved.submoduleDir] = pointer
        continue
      }

      queue.push(resolved.path)
    }
  }

  return {
    files: [...files].sort(),
    dependencies,
    missing: [...missing].sort(),
  }
}

/**
 * Hashes a closure so two trees can be compared without either being present.
 *
 * Path is bound to content, so moving code between files changes the hash. The
 * input is canonically ordered, so traversal order cannot alter the result.
 *
 * @param closure - from {@link collectSourceClosure}.
 * @param reader - the same reader the closure was collected with.
 * @returns keccak256 over the canonical closure description.
 */
export const computeSourceClosureHash = (
  closure: ISourceClosure,
  reader: ISourceReader
): Hex => {
  const files = closure.files.map((path) => [
    path,
    keccak256(toHex(reader.readFile(path) ?? '')),
  ])
  const dependencies = Object.keys(closure.dependencies)
    .sort()
    .map((dir) => [dir, closure.dependencies[dir]])

  return keccak256(toHex(JSON.stringify({ version: 1, files, dependencies })))
}
