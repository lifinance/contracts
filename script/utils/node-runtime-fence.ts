/**
 * Node-runtime fence.
 *
 * Shipped modules under `script/` and `tasks/` run on Node via `bunx tsx`;
 * only `*.test.ts` runs under Bun. This refuses the Bun-only APIs a shipped
 * module could reach for:
 *
 * - `import.meta` members Node does not provide. The one the type checker cannot
 *   catch is `import.meta.main`: `@types/node` declares it, but `tsx` leaves it
 *   `undefined` for a `.ts` entry on every Node version, so a CLI guarded by it
 *   exits 0 without doing anything. The rule allowlists the members Node 22
 *   implements rather than denylisting Bun's, so `dir`, `file`, `path`, `env`
 *   and a destructured or passed-around `import.meta` are refused as well.
 * - the `Bun` global, and `bun` / `bun:*` loaded by import, `import()` or
 *   `require()`. `tsconfig.node.json` already rejects these for the files
 *   `typecheck-files.sh` is given; this repeats the check over the whole tree,
 *   so it holds even for a caller that type-checks against the wrong config.
 *
 * Run by lint-staged on staged files and by `bun lint:node-runtime` (and
 * `.github/workflows/validateScripts.yml`) over `script/` and `tasks/`. It
 * reads no comments, so no inline disable can switch it off.
 */

import ts from 'typescript'

import { type IFence, runFence } from './fence-runner'
import { isEntrypoint } from './is-entrypoint'

const NODE_IMPORT_META_MEMBERS = ['url', 'dirname', 'filename', 'resolve']
const BUN_SPECIFIER = /^bun(:|$)/
const GLOBAL_OBJECTS = ['globalThis', 'global']

const IMPORT_META_MESSAGE =
  `Shipped modules run on Node via \`bunx tsx\`, which provides only ` +
  `import.meta.{${NODE_IMPORT_META_MEMBERS.join(',')}}. For a CLI entry ` +
  `guard use isEntrypoint(import.meta.url) from script/utils/is-entrypoint.ts; ` +
  `for the module's directory use dirname(fileURLToPath(import.meta.url)).`

const BUN_MESSAGE =
  `Shipped modules run on Node via \`bunx tsx\`, where Bun APIs do not exist. ` +
  `Use the node: equivalent (e.g. readFile/writeFile from node:fs/promises).`

const isUnsupportedImportMeta = (node: ts.Node): boolean => {
  if (
    !ts.isMetaProperty(node) ||
    node.keywordToken !== ts.SyntaxKind.ImportKeyword
  )
    return false
  const { parent } = node
  const isSupportedMemberRead =
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    NODE_IMPORT_META_MEMBERS.includes(parent.name.text)
  return !isSupportedMemberRead
}

/** The leading text of a module specifier, so `bun:${x}` is judged by its `bun:`. */
const specifierText = (node: ts.Node | undefined): string | undefined => {
  if (node === undefined) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isTemplateExpression(node)) return node.head.text
  return undefined
}

const isBunSpecifier = (node: ts.Node | undefined): boolean =>
  BUN_SPECIFIER.test(specifierText(node) ?? '')

const loadsBun = (node: ts.Node): boolean => {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    return isBunSpecifier(node.moduleSpecifier)
  if (ts.isExternalModuleReference(node)) return isBunSpecifier(node.expression)
  if (!ts.isCallExpression(node)) return false
  const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
  const isRequire =
    ts.isIdentifier(node.expression) && node.expression.text === 'require'
  return (isImportCall || isRequire) && isBunSpecifier(node.arguments[0])
}

/** Whether `node` is a name slot (a declared name, a member name) rather than a value read. */
const isNameSlot = (node: ts.Identifier): boolean => {
  const parent = node.parent as ts.Node & {
    name?: ts.Node
    propertyName?: ts.Node
  }
  if (ts.isShorthandPropertyAssignment(parent)) return false
  if (ts.isQualifiedName(parent)) return parent.right === node
  return parent.name === node || parent.propertyName === node
}

const readsBunGlobal = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && node.text === 'Bun' && !isNameSlot(node)

/** `node` without the parentheses and type assertions that leave its value unchanged. */
const unwrap = (node: ts.Node): ts.Node => {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  )
    current = current.expression
  return current
}

const isGlobalObject = (node: ts.Node | undefined): boolean => {
  if (node === undefined) return false
  const value = unwrap(node)
  return ts.isIdentifier(value) && GLOBAL_OBJECTS.includes(value.text)
}

const literalText = (node: ts.Node): string | undefined => {
  const value = unwrap(node)
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
    ? value.text
    : undefined
}

/** The name a property key spells: `Bun`, `'Bun'` and `['Bun']` all spell `Bun`. */
const keyText = (key: ts.Node): string | undefined => {
  if (ts.isIdentifier(key)) return key.text
  if (ts.isComputedPropertyName(key)) return literalText(key.expression)
  return literalText(key)
}

/** The value a destructuring pattern reads from, when the pattern is the target side. */
const destructuredValue = (pattern: ts.Node): ts.Node | undefined => {
  const { parent } = pattern
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent)
  )
    return parent.name === pattern ? parent.initializer : undefined
  const isAssignmentTarget =
    ts.isBinaryExpression(parent) &&
    parent.left === pattern &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  return isAssignmentTarget ? parent.right : undefined
}

/**
 * `{ Bun: b }` or `{ ['Bun']: b }` taken off a global object by declaration,
 * parameter default or assignment. A shorthand `({ Bun } = globalThis)` reads
 * the `Bun` identifier itself, so `readsBunGlobal` already refuses it.
 */
const destructuresBunOffGlobalObject = (node: ts.Node): boolean => {
  let key: ts.Node
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent))
    key = node.propertyName ?? node.name
  else if (
    ts.isPropertyAssignment(node) &&
    ts.isObjectLiteralExpression(node.parent)
  )
    key = node.name
  else return false
  return (
    keyText(key) === 'Bun' && isGlobalObject(destructuredValue(node.parent))
  )
}

/** `globalThis.Bun`, `(global)['Bun']` and `Bun` destructured off either. */
const readsBunOffGlobalObject = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node))
    return isGlobalObject(node.expression) && node.name.text === 'Bun'
  if (ts.isElementAccessExpression(node))
    return (
      isGlobalObject(node.expression) &&
      literalText(node.argumentExpression) === 'Bun'
    )
  return destructuresBunOffGlobalObject(node)
}

export const NODE_RUNTIME_FENCE: IFence = {
  name: 'node-runtime fence',
  // `bun test` provides every Bun API.
  appliesTo: (path) =>
    (path.startsWith('script/') || path.startsWith('tasks/')) &&
    !path.endsWith('.test.ts'),
  rules: [
    { matches: isUnsupportedImportMeta, message: IMPORT_META_MESSAGE },
    { matches: loadsBun, message: BUN_MESSAGE },
    { matches: readsBunGlobal, message: BUN_MESSAGE },
    { matches: readsBunOffGlobalObject, message: BUN_MESSAGE },
  ],
}

if (isEntrypoint(import.meta.url))
  process.exit(runFence(NODE_RUNTIME_FENCE, process.argv.slice(2)))
