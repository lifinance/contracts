/**
 * Finds log calls that put a raw RPC endpoint on screen.
 *
 * `ETH_NODE_URI_*` embeds the provider key in the URL, so a log line naming the endpoint writes a
 * live credential into every transcript of the run. Imported by `rpc-url-log-scan.test.ts`, which
 * fails when a new such site appears under `script/` or `tasks/`.
 *
 * What it does NOT reach, so nobody mistakes a green run for a closed class: bash (`.sh` is not
 * walked); endpoints embedded in an error object's `message` by viem or tronweb; identifiers
 * outside {@link RPC_IDENTIFIERS}; log surfaces outside {@link LOG_METHODS}; anything under a
 * path in {@link EXEMPT}, which is whole-file rather than per-line; and anything outside the
 * roots the caller passes.
 */
import { type Dirent, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

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
 * Matched as prefixes, so `ETH_NODE_URI_TRON` and `RPC_URL_TRON` are caught. A word-boundary entry
 * cannot be: the network suffix leaves no boundary after the base name. `@lifi/tron-devkit`'s
 * `getTronRpcUrl` reads `RPC_URL_TRON`, so the suffixed form is the one the Tron path uses.
 */
const RPC_ENV_PREFIXES: readonly string[] = ['ETH_NODE_URI', 'RPC_URL']

/** consola's `LogType` union plus the `console` methods that dump a whole object. */
const LOG_METHODS = [
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
] as const
const LOG_CALL = new RegExp(
  String.raw`\b(?:consola|console)\s*\.\s*(?:${LOG_METHODS.join('|')})\s*\(`,
  'g'
)

/**
 * Sites that name an endpoint in a log deliberately. An entry is a standing exception to a
 * credential rule, so each carries its reason.
 */
/** Calls whose argument is safe to log; `hostOf` strips a URL to its host. */
const REDACTORS = new Set(['redactUrls', 'redactErrorReason', 'hostOf'])

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

/** After these, a `/` starts a regex; after any other word it is division. */
const REGEX_OK_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9_$]/.test(c)

/**
 * End offset (exclusive) of the regex literal opening at `i`, or -1 if there is none on that line.
 *
 * Looked ahead without mutating, so a `/` that turns out to be division — or an unterminated
 * literal — leaves the source untouched rather than blanking a line of real code.
 *
 * @param src - source text.
 * @param i - offset of the opening `/`.
 * @returns offset just past the closing `/` and its flags, or -1.
 */
function endOfRegex(src: string, i: number): number {
  let j = i + 1
  let inClass = false
  while (j < src.length) {
    const c = src[j]
    if (c === '\n') return -1
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j++
      while (j < src.length && /[a-z]/i.test(src[j] ?? '')) j++
      return j
    }
    j++
  }
  return -1
}

/**
 * Replace every comment, string body and regex body with spaces, keeping length and newlines so
 * offsets and line numbers still line up with the original source.
 *
 * A template literal's `${...}` expressions are deliberately KEPT — `${rpcUrl}` is the most common
 * way this leak is written, and blanking the whole template would hide the case this module
 * exists to catch. Only the literal text around them is blanked.
 *
 * Regex literals are blanked for the same reason strings are: `/['"`]/` would otherwise open a
 * phantom string that swallows the rest of the file, and `/^https:\/\//` reads as a line comment.
 *
 * @param src - original source text.
 * @returns the same text with non-code spans replaced by spaces.
 */
export function blankNonCode(src: string): string {
  const out = src.split('')
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' '
  }

  // A stack, because the contexts nest without limit: a template holds `${...}` code, which holds
  // another template, which holds another string. `braceDepth` is what stops an object literal's
  // `}` from ending the interpolation.
  const stack: { kind: 'code' | 'tmpl'; braceDepth: number }[] = [
    { kind: 'code', braceDepth: 0 },
  ]
  let i = 0
  // Decides the `/` ambiguity. A regex may follow an operator or a keyword, never a value.
  let prevChar = ''
  let prevTwo = ''
  let prevWord = ''
  const endsAValue = (): boolean =>
    [')', ']', "'", '"', '`'].includes(prevChar) ||
    prevTwo === '++' ||
    prevTwo === '--'

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
        prevChar = ''
        prevWord = ''
      } else if (c === '`') {
        blank(i++)
        stack.pop()
        prevChar = '`'
        prevWord = ''
      } else blank(i++)
      continue
    }

    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && n === '*') {
      blank(i++)
      blank(i++)
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/'))
        blank(i++)
      if (i < src.length) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    if (
      c === '/' &&
      (!isWordChar(prevChar) || REGEX_OK_AFTER_WORD.has(prevWord)) &&
      !endsAValue()
    ) {
      const end = endOfRegex(src, i)
      if (end !== -1) {
        while (i < end) blank(i++)
        prevChar = '/'
        prevWord = ''
        continue
      }
    }
    if (c === "'" || c === '"') {
      // Looked ahead before blanking, and bounded to the line: a quoted string cannot hold a raw
      // newline, so a quote with no partner on its own line is not a string opener — usually a
      // quote inside a regex this pass declined to read as one. Blanking such a quote all the way
      // to end-of-file is what made four shipped files invisible, so any future mis-decision is
      // now confined to the line it happens on.
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n')
        j += src[j] === '\\' ? 2 : 1
      if (j < src.length && src[j] === c) while (i <= j) blank(i++)
      else i++
      prevChar = c
      prevTwo = ''
      prevWord = ''
      continue
    }
    if (c === '`') {
      blank(i++)
      stack.push({ kind: 'tmpl', braceDepth: 0 })
      continue
    }
    if (c !== undefined && /[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < src.length && isWordChar(src[j])) j++
      prevWord = src.slice(i, j)
      prevChar = src[j - 1] ?? ''
      i = j
      continue
    }
    if (c === '{') top.braceDepth++
    else if (c === '}') {
      if (top.braceDepth > 0) top.braceDepth--
      else if (stack.length > 1) stack.pop()
    }
    if (c !== undefined && !/\s/.test(c)) {
      prevTwo = prevChar + c
      prevChar = c
      prevWord = ''
    }
    i++
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

/** Argument spans of every redaction call. */
function redactedSpans(code: string): [number, number][] {
  const spans: [number, number][] = []
  const re = new RegExp(String.raw`\b(?:${[...REDACTORS].join('|')})\s*\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1
    spans.push([open, endOfCall(code, open)])
  }
  return spans
}

/**
 * True when the identifier at `at` is an object-literal key rather than a value being read.
 *
 * Both halves are required. Testing only for a following `:` also suppresses the consequent of a
 * ternary — `${flag ? rpcUrl : ''}` — which is a normal way to write an endpoint override, so the
 * preceding `{` or `,` is what separates a label from a value.
 *
 * @param code - blanked source.
 * @param at - offset of the identifier.
 * @param length - identifier length.
 * @returns whether this occurrence names a field.
 */
function isObjectKey(code: string, at: number, length: number): boolean {
  if (!/^\s*:/.test(code.slice(at + length))) return false
  let b = at - 1
  while (b >= 0 && /\s/.test(code[b] ?? '')) b--
  const prev = code[b]
  return prev === '{' || prev === ','
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
 * Enumerates the filesystem rather than `git ls-files` deliberately: an uncommitted file is
 * exactly where a new leak arrives, and a git-backed listing cannot see one.
 *
 * @param repoRoot - repository root.
 * @param roots - directories to walk, relative to the root.
 * @returns one finding per offending log argument, and the files actually examined.
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
      if (EXEMPT.has(rel)) continue

      let src: string
      try {
        src = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      const code = blankNonCode(src)
      const safe = redactedSpans(code)

      LOG_CALL.lastIndex = 0
      let call: RegExpExecArray | null
      while ((call = LOG_CALL.exec(code)) !== null) {
        const open = call.index + call[0].length - 1
        const close = endOfCall(code, open)
        const args = code.slice(open, close)

        for (const id of [...RPC_IDENTIFIERS, ...RPC_ENV_PREFIXES]) {
          const idRe = RPC_ENV_PREFIXES.includes(id)
            ? new RegExp(String.raw`\b${id}\w*\b`, 'g')
            : new RegExp(String.raw`\b${id}\b`, 'g')
          let m: RegExpExecArray | null
          while ((m = idRe.exec(args)) !== null) {
            const at = open + m.index
            if (isObjectKey(code, at, m[0].length)) continue
            if (safe.some(([st, e]) => at > st && at < e)) continue
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
