/**
 * Runs an AST fence — a fixed set of syntax rules that must hold across the
 * tree — over files and directories, for `funnel-fence.ts` and
 * `node-runtime-fence.ts`.
 *
 * Files are parsed with the TypeScript compiler and judged on their syntax
 * nodes only. Comments are never read, so no inline directive can switch a
 * fence off: that is the property the fences exist for, and the reason they do
 * not run inside oxlint, which honours every disable comment.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

import { consola } from 'consola'
import ts from 'typescript'

/** Every extension a module can be written at, so any of them could carry a route. */
export const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]

/** Tracked but never run: retired scripts kept for reference. */
const SKIPPED_PREFIXES = ['archive/']

const PARSE_ERROR = 'cannot be parsed, so the fence refuses it unjudged'

export interface IFenceRule {
  matches: (node: ts.Node) => boolean
  message: string
}

export interface IFence {
  name: string
  /** Whether the fence judges the file at this repo-relative path at all. */
  appliesTo: (path: string) => boolean
  rules: IFenceRule[]
}

interface ITarget {
  /** Relative to the repo root, with `/` separators: what `appliesTo` matches on. */
  repoPath: string
  absolutePath: string
}

const scriptKindFor = (path: string): ts.ScriptKind => {
  const extension = extname(path)
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** The parser's syntax errors for `sourceFile`, through the public Program API. */
const syntaxErrors = (sourceFile: ts.SourceFile): readonly ts.Diagnostic[] => {
  const host = ts.createCompilerHost({})
  host.getSourceFile = (): ts.SourceFile => sourceFile
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options: { allowJs: true, noLib: true, noResolve: true },
    host,
  })
  return program.getSyntacticDiagnostics(sourceFile)
}

/**
 * Judges a module's syntax nodes against `rules`. A module that does not parse
 * is refused outright: judging the tree the parser recovered from it would let
 * a fence's verdict depend on how that recovery went.
 */
const judge = (rules: IFenceRule[], source: string, path: string): string[] => {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path)
  )
  const at = (position: number): string => {
    const { line, character } =
      sourceFile.getLineAndCharacterOfPosition(position)
    return `${line + 1}:${character + 1}`
  }

  const errors = syntaxErrors(sourceFile)
  if (errors.length > 0)
    return errors.map(
      (error) =>
        `${at(error.start ?? 0)}  ${PARSE_ERROR}: ` +
        ts.flattenDiagnosticMessageText(error.messageText, ' ')
    )

  const violations: string[] = []
  const visit = (node: ts.Node): void => {
    for (const rule of rules)
      if (rule.matches(node))
        violations.push(`${at(node.getStart(sourceFile))}  ${rule.message}`)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

/**
 * Judges one module's source as if it were the file at `path`.
 *
 * @param fence - the fence to apply
 * @param source - the module text
 * @param path - repo-relative path, which is what `appliesTo` matches on
 * @returns one `line:column  message` entry per offending node or syntax
 *   error; empty when the module passes or the fence does not apply to `path`
 */
export const findViolations = (
  fence: IFence,
  source: string,
  path: string
): string[] => (fence.appliesTo(path) ? judge(fence.rules, source, path) : [])

const repoRoot = (): string =>
  realpathSync(
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
  )

const isModule = (repoPath: string): boolean =>
  MODULE_EXTENSIONS.includes(extname(repoPath)) &&
  !SKIPPED_PREFIXES.some((prefix) => repoPath.startsWith(prefix))

/**
 * Locates a file argument against the repo root. Only its directory is
 * resolved through symlinks, so a symlinked checkout path still lands inside
 * the repo while a symlinked file keeps its own name.
 */
const toTarget = (root: string, path: string): ITarget => {
  const absolutePath = join(
    realpathSync(dirname(resolve(path))),
    basename(path)
  )
  const repoPath = relative(root, absolutePath).split(sep).join('/')
  if (repoPath.startsWith('../') || isAbsolute(repoPath))
    throw new Error(
      `${path} is outside the repository at ${root}. Run the fence from inside the repo it judges.`
    )
  return { repoPath, absolutePath }
}

/** Module files under `directory` that git tracks or would track, so build output is skipped. */
const listDirectory = (root: string, directory: string): ITarget[] => {
  const targets = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--full-name',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      directory,
    ],
    { encoding: 'utf8' }
  )
    .split('\0')
    .filter((repoPath) => repoPath !== '' && isModule(repoPath))
    .map((repoPath) => ({ repoPath, absolutePath: join(root, repoPath) }))
    // `--cached` still lists a file deleted from the working tree but not yet staged.
    .filter((target) => existsSync(target.absolutePath))

  // A sweep that found nothing has judged nothing, which must not read as a pass.
  if (targets.length === 0)
    throw new Error(
      `${directory} holds no module files git knows about. Pass a directory inside the repo.`
    )
  return targets
}

const expandPaths = (root: string, paths: string[]): ITarget[] => {
  const targets = new Map<string, ITarget>()
  for (const path of paths) {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat)
      throw new Error(
        `${path} does not exist. Pass existing files or directories.`
      )
    const found = stat.isDirectory()
      ? listDirectory(root, path)
      : [toTarget(root, path)].filter((target) => isModule(target.repoPath))
    for (const target of found) targets.set(target.repoPath, target)
  }
  return [...targets.values()].sort((a, b) =>
    a.repoPath.localeCompare(b.repoPath)
  )
}

/**
 * Applies `fence` to every module in `paths` and reports what it found.
 *
 * @param fence - the fence to apply
 * @param paths - files (as lint-staged passes them) or directories to sweep
 * @returns the process exit code: 0 when nothing was refused, 1 otherwise
 * @throws when a path does not exist or lies outside the repo, or a directory
 *   holds no module files
 */
export const runFence = (fence: IFence, paths: string[]): number => {
  if (paths.length === 0)
    throw new Error(
      `${fence.name}: pass at least one file or directory to check.`
    )

  const targets = expandPaths(repoRoot(), paths).filter((target) =>
    fence.appliesTo(target.repoPath)
  )
  let refused = 0

  for (const { repoPath, absolutePath } of targets)
    for (const violation of judge(
      fence.rules,
      readFileSync(absolutePath, 'utf8'),
      repoPath
    )) {
      refused++
      consola.error(`${repoPath}:${violation}`)
    }

  const summary = `${fence.name}: ${targets.length} file(s) checked, ${refused} refused`
  if (refused > 0) {
    consola.error(summary)
    return 1
  }
  consola.success(summary)
  return 0
}
