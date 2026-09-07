/**
 * Static scan for the citty argument shape that makes a flag unreachable by the
 * spelling an operator most likely types.
 *
 * `args.<name>` goes through a citty proxy that falls back from the key asked
 * for to its camelCase and then its kebab-case form — but only while the key
 * asked for is missing from the parsed object. A `default` puts that key there
 * whether or not the caller passed anything, so the fallback never runs: the
 * value a caller typed under the other spelling sits on a key nobody reads and
 * the body sees the default. Against `dryRun: { type: 'boolean', default:
 * false }`, `--dry-run` therefore reads as off and the run broadcasts.
 *
 * The fix is to declare no `default` and apply the fallback in the command body
 * (`flagIsOn` for a boolean, `args.x ?? DEFAULT` for a value), so both spellings
 * reach it. See `script/deploy/safe/cli-flags.ts`.
 */

import { readFileSync } from 'fs'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
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
 * Whether citty's camelCase and kebab-case forms of a name differ, which is what
 * gives the argument two keys to disagree on. A single lowercase word has one
 * spelling and cannot exhibit the defect.
 */
const spansMoreThanOneWord = (name: string): boolean =>
  /[A-Z]/u.test(name) || name.includes('-')

const propertyName = (property: Node, source: SourceFile): string =>
  isPropertyAssignment(property)
    ? property.name.getText(source).replace(/^['"`]|['"`]$/gu, '')
    : ''

const findProperty = (
  literal: ObjectLiteralExpression,
  name: string,
  source: SourceFile
): Node | undefined =>
  literal.properties.find((property) => propertyName(property, source) === name)

const argumentsLiteral = (
  command: ObjectLiteralExpression,
  source: SourceFile
): ObjectLiteralExpression | undefined => {
  const property = findProperty(command, 'args', source)
  if (!property || !isPropertyAssignment(property)) return undefined
  return isObjectLiteralExpression(property.initializer)
    ? property.initializer
    : undefined
}

/**
 * Finds every multi-word `defineCommand` argument in one file that declares a
 * `default`.
 *
 * @param file - Path reported back in the findings.
 * @param source - The file's TypeScript source.
 * @returns One finding per offending argument, in source order.
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
      const literal = argumentsLiteral(node.arguments[0], sourceFile)
      for (const declaration of literal?.properties ?? []) {
        if (
          !isPropertyAssignment(declaration) ||
          !isObjectLiteralExpression(declaration.initializer)
        )
          continue

        const argument = propertyName(declaration, sourceFile)
        if (!spansMoreThanOneWord(argument)) continue

        const type = findProperty(declaration.initializer, 'type', sourceFile)
        // A positional is matched by its place on the command line, never by a
        // flag spelling, so it has only one key and no spelling to lose.
        if (
          type &&
          isPropertyAssignment(type) &&
          type.initializer.getText(sourceFile).replace(/['"`]/gu, '') ===
            'positional'
        )
          continue

        const declaredDefault = findProperty(
          declaration.initializer,
          'default',
          sourceFile
        )
        if (!declaredDefault || !isPropertyAssignment(declaredDefault)) continue
        // citty installs a parser default only for a value that is not
        // `undefined`, so `default: undefined` leaves the key absent and the
        // proxy fallback intact.
        if (declaredDefault.initializer.getText(sourceFile) === 'undefined')
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
