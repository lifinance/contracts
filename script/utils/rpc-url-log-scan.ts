/**
 * Find log calls that put a raw RPC endpoint on screen.
 *
 * `ETH_NODE_URI_*` carries the provider key inside the URL, so one `consola.info(...)` naming the
 * endpoint publishes a live credential into every transcript that runs the script. An endpoint
 * reaches a log through `redactUrls()` or it does not reach one.
 *
 * Two limits, stated because a reader will otherwise assume they are not there:
 *
 * 1. The reach is {@link RPC_IDENTIFIERS}. An endpoint laundered through a variable named
 *    something else is invisible, so this narrows the class rather than closing it.
 * 2. It reads text, not an AST — a TypeScript-aware parser is not usable here (the repo's
 *    `typescript` is the Go port, whose JS compiler API is absent, and `oxc-parser` segfaults the
 *    runtime on these files). What makes the text scan trustworthy is {@link blankNonCode}: the
 *    only three ways this repo mentions an endpoint innocently — a doc comment, a help string and
 *    an object key — are removed structurally before anything is matched, and each is covered by
 *    a case in the test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Identifiers whose value is, or holds, a full endpoint URL. */
export const RPC_IDENTIFIERS: readonly string[] = [
  'rpcUrl',
  'rpcUrls',
  'fullHost',
  'nodeUrl',
  'providerUrl',
  'endpointUrl',
  'RPC_URL',
]

/**
 * Matched as a prefix, so `process.env.ETH_NODE_URI_TRON` is caught. A plain word-boundary entry
 * in {@link RPC_IDENTIFIERS} cannot be: the network suffix leaves no boundary after `URI`.
 */
const RPC_ENV_PREFIX = 'ETH_NODE_URI'

const LOG_CALL =
  /\b(?:consola|console)\s*\.\s*(?:debug|info|log|warn|error|success|start|ready|fail|box)\s*\(/g

/**
 * Sites that name an endpoint in a log deliberately. An entry is a standing exception to a
 * credential rule, so each carries its reason.
 */
export const EXEMPT = new Map<string, string>([
  [
    'script/demoScripts/demoPaxosTransit.ts',
    'prints the local anvil endpoint it starts itself (127.0.0.1), which carries no credential',
  ],
])

export interface IFinding {
  file: string
  line: number
  identifier: string
  text: string
}

/**
 * Replace every comment and string body with spaces, keeping length and newlines so offsets and
 * line numbers still line up with the original source.
 *
 * A template literal's `${...}` expressions are deliberately KEPT — `${rpcUrl}` is the single most
 * common way this leak is written, and blanking the whole template would hide exactly the case
 * this module exists to catch. Only the literal text around them is blanked.
 *
 * @param src - original source text.
 * @returns the same text with non-code spans replaced by spaces.
 */
export function blankNonCode(src: string): string {
  const out = src.split('')
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' '
  }

  // A stack, because the two contexts nest without limit: a template holds `${...}` code, which
  // holds another template, which holds another string. A single pass with one flag blanks the
  // wrong half — the first version of this kept an interpolation as code but never blanked the
  // string literals inside it, so `` `${n.replace('ETH_NODE_URI_', '')}` `` read as a live
  // endpoint. `braceDepth` is what stops an object literal's `}` from ending the interpolation.
  const stack: { kind: 'code' | 'tmpl'; braceDepth: number }[] = [
    { kind: 'code', braceDepth: 0 },
  ]
  let i = 0

  while (i < src.length) {
    const top = stack[stack.length - 1]
    if (!top) break
    const c = src[i]
    const n = src[i + 1]

    if (top.kind === 'tmpl') {
      if (c === '\\') {
        blank(i++)
        if (i < src.length) blank(i++)
      } else if (c === '$' && n === '{') {
        i += 2
        stack.push({ kind: 'code', braceDepth: 0 })
      } else if (c === '`') {
        blank(i++)
        stack.pop()
      } else blank(i++)
      continue
    }

    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++)
    } else if (c === '/' && n === '*') {
      blank(i++)
      blank(i++)
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/'))
        blank(i++)
      if (i < src.length) {
        blank(i++)
        blank(i++)
      }
    } else if (c === "'" || c === '"') {
      blank(i++)
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') blank(i++)
        if (i < src.length) blank(i++)
      }
      if (i < src.length) blank(i++)
    } else if (c === '`') {
      blank(i++)
      stack.push({ kind: 'tmpl', braceDepth: 0 })
    } else if (c === '{') {
      top.braceDepth++
      i++
    } else if (c === '}') {
      if (top.braceDepth > 0) {
        top.braceDepth--
        i++
      } else if (stack.length > 1) {
        stack.pop()
        i++
      } else i++
    } else i++
  }
  return out.join('')
}

/** Offset of the `)` matching the `(` at `openParen`. */
function endOfCall(src: string, openParen: number): number {
  let depth = 0
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

/** Argument spans of every `redactUrls(...)` / `redactErrorReason(...)` call. */
function redactedSpans(code: string): [number, number][] {
  const spans: [number, number][] = []
  const re = /\bredact(?:Urls|ErrorReason)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1
    spans.push([open, endOfCall(code, open)])
  }
  return spans
}

function tsFilesUnder(root: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(root, e)
    if (statSync(p).isDirectory()) tsFilesUnder(p, out)
    else if (
      e.endsWith('.ts') &&
      !e.endsWith('.test.ts') &&
      !e.endsWith('.d.ts')
    )
      out.push(p)
  }
  return out
}

/**
 * Scan shipped modules for log calls naming an endpoint outside a redaction.
 *
 * Enumerates the filesystem rather than `git ls-files` deliberately: an uncommitted file is
 * exactly where a new leak arrives, and a git-backed listing cannot see one.
 *
 * @param repoRoot - repository root.
 * @param roots - directories to walk, relative to the root.
 * @returns one finding per offending log argument, and the files actually examined.
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
      if (EXEMPT.has(rel)) continue

      const src = readFileSync(abs, 'utf8')
      const code = blankNonCode(src)
      const safe = redactedSpans(code)

      LOG_CALL.lastIndex = 0
      let call: RegExpExecArray | null
      while ((call = LOG_CALL.exec(code)) !== null) {
        const open = call.index + call[0].length - 1
        const close = endOfCall(code, open)
        const args = code.slice(open, close)

        for (const id of [...RPC_IDENTIFIERS, RPC_ENV_PREFIX]) {
          const idRe =
            id === RPC_ENV_PREFIX
              ? new RegExp(`\\b${id}\\w*\\b`, 'g')
              : new RegExp(`\\b${id}\\b`, 'g')
          let m: RegExpExecArray | null
          while ((m = idRe.exec(args)) !== null) {
            const at = open + m.index
            // `{ rpcUrl: network }` labels a field rather than reading an endpoint.
            if (/^\s*:/.test(code.slice(at + m[0].length))) continue
            if (safe.some(([s, e]) => at > s && at < e)) continue
            findings.push({
              file: rel,
              line: src.slice(0, at).split('\n').length,
              identifier: m[0],
              text: src
                .slice(at, Math.min(at + 70, src.length))
                .replace(/\s+/g, ' '),
            })
          }
        }
      }
    }
  return { findings, scanned }
}
