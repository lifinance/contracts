/**
 * Finds log calls that put a raw RPC endpoint on screen.
 *
 * `ETH_NODE_URI_*` embeds the provider key in the URL, so a log line naming the endpoint writes a
 * live credential into every transcript of the run. Imported by `rpc-url-log-scan.test.ts`, which
 * fails when a new such site appears under `script/` or `tasks/`.
 *
 * What it does NOT reach, so nobody mistakes a green run for a closed class:
 *
 * - bash — `.sh` is not walked at all.
 * - An endpoint viem or tronweb embeds in an error object's `message`.
 * - A name outside {@link RPC_IDENTIFIERS} / `RPC_ENV_PREFIXES`, or a method outside
 *   {@link LOG_METHODS}.
 * - Any receiver that is not a bare `consola`/`console` with a dotted method: an alias
 *   (`const c = consola`), `console['log'](…)`, `consola.info.call(…)` and a tagged template are
 *   each invisible however the method is named.
 * - A computed environment read, `process.env[name]` — the form three scripts here use.
 * - Anything needing dataflow: a value renamed, destructured to another name, or handed to a
 *   helper that logs it.
 * - The specific identifiers a path lists in {@link EXEMPT}; everything else in such a file is
 *   still scanned. And anything outside the roots the caller passes.
 */
import { type Dirent, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'

/** Identifiers whose value is, or holds, a full endpoint URL. */
export const RPC_IDENTIFIERS: readonly string[] = [
  'rpcUrl',
  'rpcUrls',
  'fullHost',
  'nodeUrl',
  'providerUrl',
  'endpointUrl',
]

/**
 * Matched as prefixes, so `ETH_NODE_URI_TRON` and `RPC_URL_TRON` are caught. `@lifi/tron-devkit`'s
 * `getTronRpcUrl` reads `RPC_URL_TRON`, so the suffixed form is the one the Tron path uses.
 */
const RPC_ENV_PREFIXES: readonly string[] = ['ETH_NODE_URI', 'RPC_URL']

/** consola's `LogType` union plus the `console` methods that dump a whole object. */
export const LOG_METHODS: readonly string[] = [
  'debug',
  'info',
  'log',
  'warn',
  'error',
  'success',
  'start',
  'ready',
  'fail',
  'box',
  'fatal',
  'trace',
  'verbose',
  'silent',
  'dir',
  'table',
  'group',
  'groupCollapsed',
]
const LOGGERS = new Set(['consola', 'console'])

/** Calls whose argument is safe to log; `hostOf` strips a URL to its host. */
const REDACTORS = new Set(['redactUrls', 'redactErrorReason', 'hostOf'])

/**
 * Sites that name an endpoint in a log deliberately. An entry is a standing exception to a
 * credential rule, so each carries its reason.
 */
export const EXEMPT = new Map<
  string,
  { identifiers: readonly string[]; why: string }
>([
  [
    'script/demoScripts/demoPaxosTransit.ts',
    {
      identifiers: ['RPC_URL'],
      why: 'RPC_URL is the local anvil endpoint the demo starts itself (127.0.0.1), no credential',
    },
  ],
])

export interface IFinding {
  file: string
  line: number
  identifier: string
  text: string
}

const namesAnEndpoint = (text: string): boolean =>
  RPC_IDENTIFIERS.includes(text) ||
  RPC_ENV_PREFIXES.some((p) => text.startsWith(p))

const calleeName = (node: ts.CallExpression): string | undefined => {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression))
    return node.expression.name.text
  return undefined
}

const isLogCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  LOGGERS.has(node.expression.expression.text) &&
  LOG_METHODS.includes(node.expression.name.text)

/**
 * True when this identifier declares a name rather than reading a value.
 *
 * An object key, a parameter, a binding, a method name and a label all *mention* the word without
 * putting an endpoint on screen. Asked structurally — is this identifier the thing its parent is
 * naming — rather than by listing declaration kinds: a fixed list of node kinds silently omits
 * accessors, methods, enum members and labels, and that omission is a false red on honest code.
 *
 * Two deliberate exceptions. A shorthand `{ rpcUrl }` is both the name and the read, so it
 * reports. A property access reads a member, so `chain.rpcUrls` reports even though `rpcUrls` is
 * its parent's `name`.
 */
function declaresRatherThanReads(node: ts.Identifier): boolean {
  const p = node.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) return false
  if (ts.isShorthandPropertyAssignment(p)) return false
  const named = p as ts.Node & {
    name?: ts.Node
    propertyName?: ts.Node
    label?: ts.Node
  }
  return (
    named.name === node || named.propertyName === node || named.label === node
  )
}

function tsFilesUnder(root: string, out: string[] = []): string[] {
  let entries: Dirent[]
  try {
    // withFileTypes, so the kind comes back with the listing: a second stat call would both
    // follow symlinked directories (a self-referential one loops) and race a file being removed
    // between the two calls.
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const name = e.name
    if (name === 'node_modules' || name.startsWith('.') || e.isSymbolicLink())
      continue
    const p = join(root, name)
    if (e.isDirectory()) tsFilesUnder(p, out)
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts')
    )
      out.push(p)
  }
  return out
}

/**
 * Scan shipped modules for log calls naming an endpoint outside a redaction.
 *
 * Uses the TypeScript parser rather than a text scan. Every distinction that decides a case here
 * is a question about the grammar — a type annotation versus a value, a binding versus a read, a
 * comment or string versus code, a regex literal versus division — and none of them survives an
 * approximation of the grammar.
 *
 * Enumerates the filesystem rather than `git ls-files` deliberately: an uncommitted file is
 * exactly where a new leak arrives, and a git-backed listing cannot see one.
 *
 * @param repoRoot - repository root.
 * @param roots - directories to walk, relative to the root.
 * @returns one finding per offending identifier, and the files actually examined.
 * @throws never for an unreadable path — a directory or file it cannot read is skipped.
 */
export function scanForRawRpcUrlLogs(
  repoRoot: string,
  roots: string[] = ['script', 'tasks']
): { findings: IFinding[]; scanned: string[] } {
  const findings: IFinding[] = []
  const scanned: string[] = []

  for (const r of roots)
    for (const abs of tsFilesUnder(join(repoRoot, r))) {
      const rel = relative(repoRoot, abs).replace(/\\/g, '/')
      scanned.push(rel)
      // Per identifier, never per file: the one exempted file also holds a real
      // `ETH_NODE_URI_MAINNET` for its anvil fork, so skipping the whole file would hide a
      // credential-bearing log added to it later.
      const exemptHere = EXEMPT.get(rel)?.identifiers ?? []

      let src: string
      try {
        src = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      // The parser error-recovers rather than throwing, so a malformed file still yields a tree.
      const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true)

      const visit = (
        node: ts.Node,
        inLog: boolean,
        redacted: boolean
      ): void => {
        // A type never renders at runtime, so `cfg as { rpcUrl?: string }` names nothing.
        if (ts.isTypeNode(node)) return

        const nowLog = inLog || isLogCall(node)
        const nowRedacted =
          redacted ||
          (ts.isCallExpression(node) && REDACTORS.has(calleeName(node) ?? ''))

        if (
          nowLog &&
          !nowRedacted &&
          ts.isIdentifier(node) &&
          namesAnEndpoint(node.text) &&
          !exemptHere.includes(node.text) &&
          !declaresRatherThanReads(node)
        )
          findings.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            identifier: node.text,
            text: src
              .slice(
                node.getStart(sf),
                Math.min(node.getStart(sf) + 70, src.length)
              )
              .replace(/\s+/g, ' '),
          })

        ts.forEachChild(node, (c) => {
          // `consola.info` — the method name is not an argument.
          if (
            nowLog &&
            ts.isCallExpression(node) &&
            c === node.expression &&
            isLogCall(node)
          )
            return
          visit(c, nowLog, nowRedacted)
        })
      }
      visit(sf, false, false)
    }
  return { findings, scanned }
}
