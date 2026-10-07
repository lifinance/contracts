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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

import { consola } from 'consola'
import ts from 'typescript'

/** Every extension a module can be written at, so any of them could carry a route. */
export const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
]

/** Tracked but never run: retired scripts kept for reference. */
const SKIPPED_PREFIXES = ['archive/']

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

/**
 * Builds a rule predicate matching an identifier, a string (a computed lookup
 * carries a name as one) or a template part whose text is exactly `text`.
 *
 * @param text - the name the fence refuses
 * @returns the predicate, for an `IFenceRule`'s `matches`
 */
export const namesText =
  (text: string) =>
  (node: ts.Node): boolean =>
    (ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) &&
    node.text === text

const scriptKindFor = (path: string): ts.ScriptKind => {
  const extension = extname(path)
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Judges one module's source as if it were the file at `path`.
 *
 * @param fence - the fence to apply
 * @param source - the module text
 * @param path - repo-relative path, which is what `appliesTo` matches on
 * @returns one `line:column  message` entry per offending node; empty when the
 *   module passes or the fence does not apply to `path`
 */
export const findViolations = (
  fence: IFence,
  source: string,
  path: string
): string[] => {
  if (!fence.appliesTo(path)) return []

  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path)
  )
  const violations: string[] = []

  const visit = (node: ts.Node): void => {
    for (const rule of fence.rules)
      if (rule.matches(node)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        )
        violations.push(`${line + 1}:${character + 1}  ${rule.message}`)
      }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return violations
}

const toRepoPath = (path: string): string =>
  relative(process.cwd(), resolve(path)).split(sep).join('/')

const isModule = (path: string): boolean =>
  MODULE_EXTENSIONS.includes(extname(path)) &&
  !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))

/** Module files under `directory` that git tracks or would track, so build output is skipped. */
const listDirectory = (directory: string): string[] => {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      directory,
    ],
    { encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => file !== '')
    .map(toRepoPath)
    .filter(isModule)
    // `--cached` still lists a file deleted from the working tree but not yet staged.
    .filter((file) => existsSync(file))

  // A sweep that found nothing has judged nothing, which must not read as a pass.
  if (files.length === 0)
    throw new Error(
      `${directory} holds no module files git knows about. Pass a directory inside the repo.`
    )
  return files
}

/** `appliesTo` matches repo-relative paths, so from a subdirectory every file would pass unjudged. */
const assertAtRepoRoot = (): void => {
  const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], {
    encoding: 'utf8',
  }).trim()
  if (prefix !== '')
    throw new Error(
      `Run the fence from the repo root, not from ${prefix}: its paths are matched relative to the root.`
    )
}

const expandPaths = (paths: string[]): string[] => {
  assertAtRepoRoot()
  const files = new Set<string>()
  for (const path of paths) {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat)
      throw new Error(
        `${path} does not exist. Pass existing files or directories.`
      )
    if (stat.isDirectory())
      for (const file of listDirectory(path)) files.add(file)
    else if (isModule(toRepoPath(path))) files.add(toRepoPath(path))
  }
  return [...files].sort()
}

/**
 * Applies `fence` to every module in `paths` and reports what it found.
 *
 * @param fence - the fence to apply
 * @param paths - files (as lint-staged passes them) or directories to sweep
 * @returns the process exit code: 0 when nothing was refused, 1 otherwise
 * @throws when run from below the repo root, a path does not exist, or a
 *   directory holds no module files
 */
export const runFence = (fence: IFence, paths: string[]): number => {
  if (paths.length === 0)
    throw new Error(
      `${fence.name}: pass at least one file or directory to check.`
    )

  const files = expandPaths(paths)
  let checked = 0
  let refused = 0

  for (const file of files) {
    if (!fence.appliesTo(file)) continue
    checked++
    for (const violation of findViolations(
      fence,
      readFileSync(file, 'utf8'),
      file
    )) {
      refused++
      consola.error(`${file}:${violation}`)
    }
  }

  const summary = `${fence.name}: ${checked} file(s) checked, ${refused} refused`
  if (refused > 0) {
    consola.error(summary)
    return 1
  }
  consola.success(summary)
  return 0
}
