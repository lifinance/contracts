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
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  ScriptTarget,
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
  literal.properties.find((property) => propertyName(property, source) === name)

/**
 * Resolves an identifier to a same-file `const` initialised with an object
 * literal. An `args` block is routinely assembled from a shared const, by name
 * or by spread, and a shared block is exactly where the next flag gets added.
 */
const resolveObjectLiteral = (
  node: Node,
  source: SourceFile
): ObjectLiteralExpression | undefined => {
  if (isObjectLiteralExpression(node)) return node
  if (!isIdentifier(node)) return undefined

  const name = node.text
  let found: ObjectLiteralExpression | undefined
  const visit = (candidate: Node): void => {
    if (
      isVariableDeclaration(candidate) &&
      isIdentifier(candidate.name) &&
      candidate.name.text === name &&
      candidate.initializer
    ) {
      const initializer = isObjectLiteralExpression(candidate.initializer)
        ? candidate.initializer
        : undefined
      if (initializer) found = initializer
    }
    forEachChild(candidate, visit)
  }
  visit(source)
  return found
}

/** Every argument declaration in an `args` block, following spreads. */
const argumentDeclarations = (
  literal: ObjectLiteralExpression,
  source: SourceFile,
  seen: Set<ObjectLiteralExpression>
): Node[] => {
  if (seen.has(literal)) return []
  seen.add(literal)

  return literal.properties.flatMap((property) => {
    if (isPropertyAssignment(property)) return [property]
    if (isSpreadAssignment(property)) {
      const spread = resolveObjectLiteral(property.expression, source)
      return spread ? argumentDeclarations(spread, source, seen) : []
    }
    return []
  })
}

/**
 * Finds every offending argument in one file.
 *
 * @param file - Path reported back in the findings.
 * @param source - The file's TypeScript source.
 * @returns One finding per offending argument, in source order.
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
        ? argumentDeclarations(literal, sourceFile, new Set())
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
        if (
          ['undefined', 'void 0'].includes(
            declaredDefault.initializer.getText(sourceFile).trim()
          )
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
