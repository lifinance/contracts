/**
 * Enumerates the immutables `src/` declares, from the compiler's own AST.
 *
 * The compiler already knows exactly which state variables are `immutable` — the AST node carries
 * `mutability: "immutable"`, which neither the ABI nor the bytecode can tell apart from `constant`
 * or a plain state variable. Asking it removes the whole class of "a declaration shaped in a way
 * the reader cannot parse produces nothing, so the immutable is never asked for": there is no
 * parser left to miss a shape.
 *
 * What replaces that risk is a narrower and checkable one — a source file the compiler never
 * emitted an AST for. {@link findSourcesWithoutAst} asks that question directly, so an
 * unenumerated file fails the gate instead of quietly contributing nothing.
 *
 * The build writes to its own output directory so a developer's `out/` is never touched, and so
 * artifacts carrying an AST cannot reach a workflow that caches `out/` without one.
 */

import { execFileSync } from 'child_process'
import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/** One `<type> [visibility] immutable <name>;` in a contract. */
export interface IImmutableDeclaration {
  /** Repo-relative path, as the compiler recorded it. */
  file: string
  /**
   * The enclosing contract, as the AST names it. This is the registry's key,
   * and it is not a function of {@link file}: one file can declare several
   * contracts, and two files can share a basename.
   */
  contract: string
  /** 1-indexed line the declaration sits on. */
  line: number
  /**
   * The AST node's own id, which is the key Foundry's `immutableReferences`
   * uses. Only meaningful within the compilation that assigned it, so a
   * consumer must take both from one build. Absent when the AST omitted it.
   */
  astId?: number
  /** The declared type, e.g. `address`, `uint256`, `contract IGasZip`. */
  type: string
  /** As written; undefined when the declaration omits it. */
  visibility?: 'public' | 'private' | 'internal'
  name: string
}

/** Where the AST build writes, kept apart from the `out/` every other job caches. */
export const AST_OUT_DIR = 'out-immutables'

const AST_CACHE_DIR = 'cache-immutables'

/**
 * Compile `src/` with the AST attached to each artifact.
 *
 * @param outDir - Artifact directory; defaults to {@link AST_OUT_DIR}.
 * @returns The directory the artifacts were written to.
 */
export const buildAst = (outDir: string = AST_OUT_DIR): string => {
  // forge leaves the artifact of a contract that no longer exists in place, and the enumeration
  // reads every artifact it finds — so a deleted contract would keep contributing immutables.
  rmSync(outDir, { recursive: true, force: true })
  execFileSync('forge', ['build', 'src', '--ast'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      FOUNDRY_OUT: outDir,
      FOUNDRY_CACHE_PATH: AST_CACHE_DIR,
    },
  })
  return outDir
}

/** Every `.json` under a directory, recursing, excluding forge's `build-info`. */
const artifactFiles = (directory: string): string[] => {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }

  const found: string[] = []
  for (const entry of entries.sort()) {
    if (entry === 'build-info') continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...artifactFiles(path))
    else if (entry.endsWith('.json')) found.push(path)
  }
  return found
}

/**
 * Line number for a byte offset into a source file.
 *
 * The AST reports positions in BYTES, while reading a file as a string gives character indices —
 * and these sources carry non-ASCII characters in comments, so the two drift apart. Counting
 * newline bytes in the raw buffer is the only reading that stays correct.
 */
const lineOffsets = (file: string): number[] => {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return []
  }

  const starts = [0]
  for (let index = 0; index < buffer.length; index++)
    if (buffer[index] === 0x0a) starts.push(index + 1)
  return starts
}

const lineAt = (starts: number[], byteOffset: number): number => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((starts[mid] as number) <= byteOffset) low = mid
    else high = mid - 1
  }
  return low + 1
}

interface IAstVariable {
  id?: number
  nodeType?: string
  mutability?: string
  name?: string
  visibility?: string
  src?: string
  typeDescriptions?: { typeString?: string }
}

interface IAstNode {
  nodeType?: string
  name?: string
  nodes?: IAstVariable[]
}

interface IArtifact {
  ast?: { absolutePath?: string; nodes?: IAstNode[] }
}

const VISIBILITIES = new Set(['public', 'private', 'internal'])

/**
 * Read every immutable declared under `src/` out of a directory of AST-carrying artifacts.
 *
 * A source file with more than one contract is emitted once per contract, each artifact carrying
 * the same source-unit AST, so declarations are de-duplicated by file and position.
 *
 * @param outDir - Artifact directory produced by {@link buildAst}.
 * @returns The declarations, and the set of source files an AST was actually found for.
 */
export const readImmutableDeclarations = (
  outDir: string = AST_OUT_DIR
): { declarations: IImmutableDeclaration[]; sourceFiles: Set<string> } => {
  const byPosition = new Map<string, IImmutableDeclaration>()
  const sourceFiles = new Set<string>()
  const offsetsByFile = new Map<string, number[]>()

  for (const artifactPath of artifactFiles(outDir)) {
    let artifact: IArtifact
    try {
      artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as IArtifact
    } catch {
      continue
    }

    const file = artifact.ast?.absolutePath
    if (!file || !file.startsWith('src/')) continue
    sourceFiles.add(file)

    for (const node of artifact.ast?.nodes ?? []) {
      if (node.nodeType !== 'ContractDefinition') continue
      for (const member of node.nodes ?? []) {
        if (member.nodeType !== 'VariableDeclaration') continue
        if (member.mutability !== 'immutable') continue
        if (!member.name || !member.src) continue

        let starts = offsetsByFile.get(file)
        if (!starts) {
          starts = lineOffsets(file)
          offsetsByFile.set(file, starts)
        }

        const byteOffset = Number(member.src.split(':')[0])
        byPosition.set(`${file}:${member.src}`, {
          file,
          contract: node.name ?? '',
          line: Number.isFinite(byteOffset) ? lineAt(starts, byteOffset) : 0,
          type: member.typeDescriptions?.typeString ?? 'unknown',
          name: member.name,
          ...(typeof member.id === 'number' ? { astId: member.id } : {}),
          ...(member.visibility && VISIBILITIES.has(member.visibility)
            ? {
                visibility: member.visibility as
                  | 'public'
                  | 'private'
                  | 'internal',
              }
            : {}),
        })
      }
    }
  }

  const declarations = [...byPosition.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  )
  return { declarations, sourceFiles }
}

/**
 * Source files the enumeration never saw.
 *
 * An immutable in a file with no AST is invisible to the gate, so this is asked before anything
 * else — the same question `findUnreadableImmutableLines` asked of a parser, put to the compiler,
 * where it has a definite answer.
 *
 * @param expected - Repo-relative `src/**\/*.sol` paths the gate must account for.
 * @param seen - Source files an AST was found for.
 * @returns The unenumerated files, in the order given.
 */
export const findSourcesWithoutAst = (
  expected: readonly string[],
  seen: ReadonlySet<string>
): string[] => expected.filter((file) => !seen.has(file))
