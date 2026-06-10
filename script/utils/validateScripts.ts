/**
 * Script Validation (static check, no execution)
 *
 * Guards against changes that silently break TS scripts (EXSC-331):
 * 1. Type check: runs `tsc-files --noEmit` over the TS files under `script/`
 *    changed between a base ref and HEAD. Removing a used import (TS2304) or
 *    a dependency a script imports (TS2307) fails the check — no execution,
 *    no fixtures.
 * 2. Import resolution: when dependency manifests (package.json / bun.lock /
 *    tsconfig.json) changed, every bare import specifier in ALL TS files
 *    under `script/` must resolve to a package declared in
 *    package.json (or a node/bun builtin). This catches "dependency removed
 *    from package.json while a script still imports it" even when no .ts
 *    file was touched.
 *
 * Used by the `.husky/pre-push` hook (fast local feedback) and the
 * `validateScripts.yml` CI workflow (enforcement backstop).
 *
 * Usage:
 *   bunx tsx ./script/utils/validateScripts.ts [--base <ref>] [--head <ref>]
 *
 *   --base  ref to diff against (default: merge-base of HEAD and origin/main)
 *   --head  ref whose changes are validated (default: HEAD)
 *
 * Package.json shortcut:
 *   bun validate-scripts
 */

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { builtinModules } from 'module'
import { join } from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLike,
  ScriptTarget,
  SyntaxKind,
} from 'typescript'
import type { Expression, Node } from 'typescript'

const SCRIPT_FILE_PATTERN = /^script\/.*\.ts$/u
const DEPENDENCY_MANIFESTS = ['package.json', 'bun.lock', 'tsconfig.json']

interface IMissingImport {
  file: string
  specifier: string
  packageName: string
}

const git = (args: string[], cwd: string): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${
        result.stderr?.trim() ?? 'unknown error'
      }`
    )
  return result.stdout.trim()
}

/**
 * Diffing directly against a base branch ref would also pick up files changed
 * on the base branch since this branch forked, so resolve to the merge-base.
 */
const resolveBaseRef = (
  repoRoot: string,
  head: string,
  base?: string
): string => {
  const baseRef = base ?? 'origin/main'
  try {
    return git(['merge-base', baseRef, head], repoRoot)
  } catch {
    consola.warn(
      `Could not compute merge-base of ${baseRef} and ${head}, diffing against ${baseRef} directly`
    )
    return baseRef
  }
}

const getChangedFiles = (
  repoRoot: string,
  base: string,
  head: string
): string[] => {
  const output = git(
    ['diff', '--name-only', '--diff-filter=ACMR', base, head],
    repoRoot
  )
  return output ? output.split('\n').filter(Boolean) : []
}

const listScriptFiles = (repoRoot: string): string[] => {
  const result: string[] = []
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(repoRoot, relativeDir), {
      withFileTypes: true,
    })) {
      const relativePath = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) walk(relativePath)
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        result.push(relativePath)
    }
  }
  walk('script')
  return result
}

/**
 * Extracts the npm package name from a bare import specifier
 * (e.g. "@scope/pkg/sub/path" -> "@scope/pkg", "mongodb/lib" -> "mongodb").
 */
const getPackageName = (specifier: string): string => {
  const segments = specifier.split('/')
  if (specifier.startsWith('@') && segments.length >= 2)
    return `${segments[0]}/${segments[1]}`
  return segments[0] ?? specifier
}

const isBuiltinSpecifier = (specifier: string): boolean =>
  specifier.startsWith('node:') ||
  specifier === 'bun' ||
  specifier.startsWith('bun:') ||
  builtinModules.includes(getPackageName(specifier))

const collectBareImportSpecifiers = (filePath: string): string[] => {
  const sourceFile = createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ScriptTarget.Latest,
    true
  )
  const specifiers: string[] = []
  const visit = (node: Node): void => {
    let moduleSpecifier: Expression | undefined
    // Type-only imports are erased at runtime (tsx strips them), so a missing
    // package behind one cannot break script execution.
    if (isImportDeclaration(node) && !node.importClause?.isTypeOnly)
      moduleSpecifier = node.moduleSpecifier
    else if (isExportDeclaration(node) && !node.isTypeOnly)
      moduleSpecifier = node.moduleSpecifier
    else if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      moduleSpecifier = node.arguments[0]

    if (moduleSpecifier && isStringLiteralLike(moduleSpecifier)) {
      const specifier = moduleSpecifier.text
      // Relative/absolute imports are covered by the type check on changed
      // files; a package.json change cannot break them.
      if (!specifier.startsWith('.') && !specifier.startsWith('/'))
        specifiers.push(specifier)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

const getDeclaredPackages = (repoRoot: string): Set<string> => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8')
  ) as Record<string, Record<string, string> | undefined>
  const declared = new Set<string>()
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ])
    for (const name of Object.keys(packageJson[field] ?? {})) declared.add(name)
  return declared
}

const runTypeCheck = (repoRoot: string, files: string[]): boolean => {
  consola.info(`Type-checking ${files.length} changed script file(s):`)
  for (const file of files) consola.info(`  ${file}`)
  const result = spawnSync('bunx', ['tsc-files', '--noEmit', ...files], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0 && !existsSync(join(repoRoot, 'typechain')))
    consola.warn(
      'typechain/ is missing — if errors above mention typechain imports, run `bun typechain` first'
    )
  return result.status === 0
}

const runImportResolutionCheck = (repoRoot: string): boolean => {
  const declared = getDeclaredPackages(repoRoot)
  const missing: IMissingImport[] = []
  const allScriptFiles = listScriptFiles(repoRoot)
  consola.info(
    `Dependency manifest changed — verifying bare imports of ${allScriptFiles.length} script file(s) against package.json`
  )
  for (const file of allScriptFiles)
    for (const specifier of collectBareImportSpecifiers(join(repoRoot, file))) {
      if (isBuiltinSpecifier(specifier)) continue
      const packageName = getPackageName(specifier)
      // A package installed transitively via the lockfile (e.g. bs58 through
      // @layerzerolabs/lz-v2-utilities) still resolves at runtime, so only
      // flag packages that are neither declared nor installed.
      if (
        !declared.has(packageName) &&
        !existsSync(join(repoRoot, 'node_modules', packageName))
      )
        missing.push({ file, specifier, packageName })
    }

  if (missing.length > 0) {
    consola.error('Imports without a matching package.json dependency:')
    for (const entry of missing)
      consola.error(
        `  ${entry.file} imports '${entry.specifier}' but '${entry.packageName}' is not declared in package.json`
      )
    return false
  }
  return true
}

const main = defineCommand({
  meta: {
    name: 'validateScripts',
    description:
      'Static validation (type check + import resolution) of changed TS files under script/',
  },
  args: {
    base: {
      type: 'string',
      description:
        'Git ref to diff against (default: merge-base of HEAD and origin/main)',
    },
    head: {
      type: 'string',
      description: 'Git ref whose changes are validated (default: HEAD)',
    },
  },
  async run({ args }) {
    const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd())
    const head = args.head ?? 'HEAD'
    const base = resolveBaseRef(repoRoot, head, args.base)
    const changedFiles = getChangedFiles(repoRoot, base, head)

    const changedScriptFiles = changedFiles.filter((file) =>
      SCRIPT_FILE_PATTERN.test(file)
    )
    const manifestsChanged = changedFiles.some((file) =>
      DEPENDENCY_MANIFESTS.includes(file)
    )

    if (changedScriptFiles.length === 0 && !manifestsChanged) {
      consola.success(
        `No script/**/*.ts or dependency manifest changes between ${base} and ${head} — nothing to validate`
      )
      return
    }

    let passed = true
    if (changedScriptFiles.length > 0)
      passed = runTypeCheck(repoRoot, changedScriptFiles) && passed
    if (manifestsChanged) passed = runImportResolutionCheck(repoRoot) && passed

    if (!passed) {
      consola.error('Script validation failed')
      process.exit(1)
    }
    consola.success('Script validation passed')
  },
})

runMain(main)
