/**
 * Finds citty `defineCommand` arguments that declare a `default` on a name
 * spanning more than one word, a shape that makes one of the argument's two
 * spellings a silent no-op. Imported by `validateScripts.ts`, which sweeps every
 * file under `script/`.
 */

import { readFileSync } from 'fs'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isAsExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSpreadAssignment,
  isVariableStatement,
  ScriptTarget,
  SyntaxKind,
} from 'typescript'
import type { Node, ObjectLiteralExpression, SourceFile } from 'typescript'

export interface ICittyArgDefault {
  /** Path as it was passed in, so a caller can report it unchanged. */
  file: string
  /** 1-indexed line of the offending argument declaration. */
  line: number
  /** The argument name as declared. */
  argument: string
}

/**
 * citty's own word separators (scule's `STR_SPLITTERS`) plus a capital, which
 * splits a camelCase name. A name carrying any of them has a camelCase and a
 * kebab-case form that differ, and that is what gives the argument two keys.
 */
const SEPARATORS = /[A-Z_./-]/u

/** Strips quotes and any trailing `as const` so a literal compares by value. */
const literalText = (node: Node, source: SourceFile): string =>
  node
    .getText(source)
    .replace(/\s+as\s+const\s*$/u, '')
    .replace(/^['"`]|['"`]$/gu, '')

const propertyName = (property: Node, source: SourceFile): string =>
  isPropertyAssignment(property) ? literalText(property.name, source) : ''

const findProperty = (
  literal: ObjectLiteralExpression,
  name: string,
  source: SourceFile
): Node | undefined =>
  properties(literal, source).find(
    (property) => propertyName(property, source) === name
  )

/** Unwraps `as const`, `satisfies T` and parentheses around an expression. */
const unwrap = (node: Node): Node => {
  let current = node
  while (
    isAsExpression(current) ||
    isSatisfiesExpression(current) ||
    isParenthesizedExpression(current)
  )
    current = current.expression
  return current
}

/**
 * Resolves an identifier to a module-scope variable initialised with an object
 * literal. An `args` block is routinely assembled from a shared const, by name
 * or by spread, and a shared block is exactly where the next flag gets added.
 *
 * Deliberately module scope only. A same-named binding inside a function is a
 * different variable, and resolving to it would report a line the command never
 * reads — a false failure on a gate that blocks every push.
 */
const resolveObjectLiteral = (
  node: Node,
  source: SourceFile
): ObjectLiteralExpression | undefined => {
  const target = unwrap(node)
  if (isObjectLiteralExpression(target)) return target
  if (!isIdentifier(target)) return undefined

  const name = target.text
  for (const statement of source.statements) {
    if (!isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        !isIdentifier(declaration.name) ||
        declaration.name.text !== name ||
        !declaration.initializer
      )
        continue
      const initializer = unwrap(declaration.initializer)
      if (isObjectLiteralExpression(initializer)) return initializer
    }
  }
  return undefined
}

/**
 * Every property of an object literal, following spreads into the literals they
 * name. The `seen` set is load-bearing, not defensive: mutually spread consts
 * (`const a = { ...b }`, `const b = { ...a }`) otherwise recurse until the stack
 * overflows and the whole check crashes.
 */
const properties = (
  literal: ObjectLiteralExpression,
  source: SourceFile,
  seen: Set<ObjectLiteralExpression> = new Set()
): Node[] => {
  if (seen.has(literal)) return []
  seen.add(literal)

  return literal.properties.flatMap((property) => {
    if (isPropertyAssignment(property)) return [property]
    if (isSpreadAssignment(property)) {
      const spread = resolveObjectLiteral(property.expression, source)
      return spread ? properties(spread, source, seen) : []
    }
    return []
  })
}

/**
 * Finds every offending argument in one file.
 *
 * @param file - Path reported back in the findings.
 * @param source - The file's TypeScript source.
 * @returns One finding per offending argument. Declaration order, which is
 * source order unless a spread pulls arguments in from elsewhere.
 *
 * @remarks
 * `args.<name>` goes through a citty proxy that falls back from the key asked
 * for to its camelCase and then its kebab-case form — but only while the key
 * asked for is missing from the parsed object. A `default` puts that key there
 * whether or not the caller passed anything, so the fallback never runs: the
 * value a caller typed under the other spelling sits on a key nobody reads.
 * Against `dryRun: { type: 'boolean', default: false }`, `--dry-run` reads as
 * off and the run broadcasts. Declare no `default` and apply the fallback in the
 * command body instead — `flagIsOn` for a boolean, `args.x ?? DEFAULT` for a
 * value. See `script/deploy/safe/cli-flags.ts`.
 */
export const findMultiWordArgDefaults = (
  file: string,
  source: string
): ICittyArgDefault[] => {
  const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, true)
  const findings: ICittyArgDefault[] = []

  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      node.expression.getText(sourceFile) === 'defineCommand' &&
      node.arguments[0] &&
      isObjectLiteralExpression(node.arguments[0])
    ) {
      const args = findProperty(node.arguments[0], 'args', sourceFile)
      const literal =
        args && isPropertyAssignment(args)
          ? resolveObjectLiteral(args.initializer, sourceFile)
          : undefined

      for (const declaration of literal
        ? properties(literal, sourceFile)
        : []) {
        if (
          !isPropertyAssignment(declaration) ||
          !isObjectLiteralExpression(declaration.initializer)
        )
          continue

        const argument = propertyName(declaration, sourceFile)
        if (!SEPARATORS.test(argument)) continue

        // A positional's `default` is also what makes it optional, so dropping
        // it turns the argument required and citty throws when it is omitted —
        // a different fix from the flag case, and deliberately not this check's
        // business. It is not harmless: a `default` on a multi-word positional
        // still discards a flag-shaped `--repo-root <x>`.
        const type = findProperty(declaration.initializer, 'type', sourceFile)
        if (
          type &&
          isPropertyAssignment(type) &&
          literalText(type.initializer, sourceFile) === 'positional'
        )
          continue

        const declaredDefault = findProperty(
          declaration.initializer,
          'default',
          sourceFile
        )
        if (!declaredDefault || !isPropertyAssignment(declaredDefault)) continue
        // citty installs a parser default only for a value that is not
        // `undefined`, so those leave the key absent and the fallback intact.
        const value = unwrap(declaredDefault.initializer)
        if (
          value.kind === SyntaxKind.VoidExpression ||
          (isIdentifier(value) && value.text === 'undefined')
        )
          continue

        findings.push({
          file,
          argument,
          line:
            sourceFile.getLineAndCharacterOfPosition(
              declaration.getStart(sourceFile)
            ).line + 1,
        })
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)

  return findings
}

/**
 * Scans files on disk for the same shape.
 *
 * @param repoRoot - Root the paths are relative to.
 * @param files - Repo-relative paths to scan.
 * @returns Every finding across the given files.
 */
export const scanFilesForMultiWordArgDefaults = (
  repoRoot: string,
  files: string[]
): ICittyArgDefault[] =>
  files.flatMap((file) =>
    findMultiWordArgDefaults(file, readFileSync(`${repoRoot}/${file}`, 'utf8'))
  )
