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

const IMPORT_KEYWORD_RE = /\bimport\b/g

interface IStringLiteral {
  start: number
  end: number
  body: string
}

interface IScannedSource {
  /** Source with comment bodies blanked; string literals left intact. */
  code: string
  /** Every string literal, in source order. */
  strings: IStringLiteral[]
}

/**
 * Splits source into code, comments and string literals in one pass.
 *
 * Scanned rather than regex-replaced because regexes fail silently in both
 * directions. A `/*` inside one string literal and a `*\/` inside a later one
 * make a comment regex span between them and delete every real import in
 * between, with nothing recorded as missing — the closure hash would then be
 * taken over an incomplete set, the one outcome this module must never produce.
 * And the word `import` inside a string would be read as an import if string
 * bodies were not tracked.
 *
 * @param source - Solidity source text.
 * @returns the source with comments blanked, plus every string literal located.
 */
const scanSource = (source: string): IScannedSource => {
  const out = source.split('')
  const strings: IStringLiteral[] = []
  let index = 0

  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at++)
      if (out[at] !== '\n') out[at] = ' '
  }

  while (index < source.length) {
    const two = source.slice(index, index + 2)

    if (two === '//') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      blank(index, stop)
      index = stop
      continue
    }

    if (two === '/*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }

    const quote = source[index]
    if (quote === '"' || quote === "'") {
      let at = index + 1
      while (at < source.length) {
        if (source[at] === '\\') {
          at += 2
          continue
        }
        if (source[at] === quote) break
        at++
      }
      const closing = Math.min(at, source.length)
      strings.push({
        start: index,
        end: closing,
        body: source.slice(index + 1, closing),
      })
      index = closing + 1
      continue
    }

    index++
  }

  return { code: out.join(''), strings }
}

/**
 * @param source - Solidity source text.
 * @returns import specifiers in source order, duplicates preserved.
 */
export const parseImports = (source: string): string[] => {
  const { code, strings } = scanSource(source)
  const found: string[] = []

  for (const match of code.matchAll(IMPORT_KEYWORD_RE)) {
    const at = match.index
    if (at === undefined) continue

    // Only an `import` sitting in code counts. Inside a string literal it is
    // just text, and inside a comment the keyword is already blanked away.
    if (strings.some((literal) => at > literal.start && at < literal.end))
      continue

    const specifier = strings.find((literal) => literal.start > at)
    if (!specifier) continue

    // A statement terminator before the quote means this `import` had no
    // specifier of its own and the next literal belongs to something else.
    if (code.slice(at, specifier.start).includes(';')) continue

    found.push(specifier.body)
  }

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
 * Roots foundry resolves a non-relative, non-remapped specifier against
 * (`foundry.toml`: `libs = ["node_modules", "lib"]`), plus the repo's own source
 * roots. Without these a direct path such as EcoFacet's
 * `lib/openzeppelin-contracts/.../IERC20.sol` resolves to nothing, and the gate
 * reports `closure-incomplete` for that contract on every commit — a permanent
 * ERROR with no way to clear it.
 */
const DIRECT_PATH_ROOTS = ['lib/', 'node_modules/', 'src/', 'test/']

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

  const path = rule
    ? normalise(rule.target + specifier.slice(rule.prefix.length))
    : DIRECT_PATH_ROOTS.some((root) => specifier.startsWith(root))
    ? normalise(specifier)
    : undefined

  if (path === undefined) return undefined

  const submoduleDir = SUBMODULE_DIR_RE.exec(path)?.[1]
  if (submoduleDir) return { path, external: true, submoduleDir }

  // Not readable from git at any tree-ish, so it cannot be hashed or pointed at.
  // Reported as external so the closure walk records it rather than silently
  // dropping it; the caller still sees it as a dependency it could not pin.
  if (path.startsWith('node_modules/'))
    return { path, external: true, submoduleDir: 'node_modules' }

  return { path, external: false }
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
