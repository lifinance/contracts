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

const isGlobalObject = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isIdentifier(node) &&
  GLOBAL_OBJECTS.includes(node.text)

/** `globalThis.Bun`, `global['Bun']` and `const { Bun } = globalThis`. */
const readsBunOffGlobalObject = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node))
    return isGlobalObject(node.expression) && node.name.text === 'Bun'
  if (ts.isElementAccessExpression(node))
    return (
      isGlobalObject(node.expression) &&
      specifierText(node.argumentExpression) === 'Bun'
    )
  if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent))
    return false
  const key = node.propertyName ?? node.name
  const declaration = node.parent.parent
  return (
    ts.isIdentifier(key) &&
    key.text === 'Bun' &&
    ts.isVariableDeclaration(declaration) &&
    isGlobalObject(declaration.initializer)
  )
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
