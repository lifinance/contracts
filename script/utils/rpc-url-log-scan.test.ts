/* eslint-disable no-template-curly-in-string --
   The fixtures are TypeScript SOURCE TEXT handed to the scanner. `${rpcUrl}` is the leak being
   detected, not an interpolation this file performs. */
/**
 * Guards the rule that no shipped script puts a raw RPC endpoint into a log line.
 *
 * The scan is textual, so most of what follows aims at the scan rather than at the tree: every
 * innocent way this repo names an endpoint is pinned as a negative BESIDE a real leak in the same
 * fixture, so a check that has started refusing everything — or seeing nothing — fails here.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { blankNonCode, EXEMPT, scanForRawRpcUrlLogs } from './rpc-url-log-scan'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/** A real leak, appended to a fixture so no case can pass by the scan skipping the file. */
const LEAK = 'consola.error(`down: ${fullHost}`)\n'

/** Run the scan over a throwaway tree holding exactly `source`. */
function scanFixture(source: string): ReturnType<typeof scanForRawRpcUrlLogs> {
  const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
  try {
    mkdirSync(join(root, 'script'), { recursive: true })
    writeFileSync(join(root, 'script', 'fixture.ts'), source)
    return scanForRawRpcUrlLogs(root, ['script'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const identifiers = (source: string): string[] =>
  scanFixture(source).findings.map((f) => f.identifier)

describe('no shipped script logs a raw RPC endpoint', () => {
  it('finds nothing in script/ and tasks/', () => {
    const { findings } = scanForRawRpcUrlLogs(REPO_ROOT)
    expect(
      findings.map((f) => `${f.file}:${f.line} [${f.identifier}] ${f.text}`)
    ).toEqual([])
  })

  // A scan that walked nothing would satisfy the assertion above without reading a line.
  it('actually examined the tree it cleared', () => {
    const { scanned } = scanForRawRpcUrlLogs(REPO_ROOT)
    expect(scanned.length).toBeGreaterThan(100)
    expect(scanned).toContain('script/troncast/utils/tronweb.ts')
    expect(scanned).toContain('script/deploy/tron/deploy-core-facets.ts')
  })

  it('every exemption still names a file that exists', () => {
    const { scanned } = scanForRawRpcUrlLogs(REPO_ROOT)
    // Asserted non-empty first: a for-of over an emptied map is vacuously green.
    expect(EXEMPT.size).toBeGreaterThan(0)
    for (const path of EXEMPT.keys()) expect(scanned).toContain(path)
  })

  it('reads test files but never reports them', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
    try {
      mkdirSync(join(root, 'script'), { recursive: true })
      writeFileSync(join(root, 'script', 'a.test.ts'), LEAK)
      writeFileSync(join(root, 'script', 'b.ts'), LEAK)
      const { findings, scanned } = scanForRawRpcUrlLogs(root, ['script'])
      expect(scanned).toEqual(['script/b.ts'])
      expect(findings).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the scan fires on a new leak', () => {
  // The ticket's own criterion. It also proves the walk reads the filesystem — a `git ls-files`
  // enumeration cannot see an uncommitted file, which is where a new leak arrives.
  it('catches a freshly written file that logs the endpoint', () => {
    const { findings, scanned } = scanFixture(
      'const rpcUrl = process.env.ETH_NODE_URI_TRON\nconsola.info(`connecting via ${rpcUrl}`)\n'
    )
    expect(scanned).toContain('script/fixture.ts')
    expect(findings.map((f) => f.identifier)).toEqual(['rpcUrl'])
  })

  it('catches the endpoint read straight off the environment', () => {
    expect(
      identifiers('consola.warn(`using ${process.env.ETH_NODE_URI_TRON}`)\n')
    ).toEqual(['ETH_NODE_URI_TRON'])
  })

  // The Tron path reads the suffixed form: `@lifi/tron-devkit`'s getTronRpcUrl resolves
  // RPC_URL_TRON, so a word-boundary match on `RPC_URL` would never see it.
  it('catches the suffixed Tron endpoint variable', () => {
    expect(
      identifiers('consola.info(`${process.env.RPC_URL_TRON}`)\n')
    ).toEqual(['RPC_URL_TRON'])
  })

  it.each(['fatal', 'trace', 'verbose'])('catches consola.%s', (method) => {
    expect(identifiers(`consola.${method}(\`\${rpcUrl}\`)\n`)).toEqual([
      'rpcUrl',
    ])
  })

  it('catches console.dir, which dumps a whole object', () => {
    expect(identifiers('console.dir({ url: rpcUrl })\n')).toEqual(['rpcUrl'])
  })

  it('stays silent once the same site is redacted', () => {
    expect(
      scanFixture(
        'const rpcUrl = process.env.ETH_NODE_URI_TRON\n' +
          'consola.info(`connecting via ${redactUrls(rpcUrl)}`)\n'
      ).findings
    ).toEqual([])
  })

  it('accepts hostOf as a redaction too', () => {
    expect(scanFixture('consola.info(hostOf(rpcUrl))\n').findings).toEqual([])
  })
})

describe('the innocent mentions stay silent, beside a leak that does not', () => {
  // Each fixture carries a real leak. Without it a case would pass against a scan that had
  // stopped reading the file entirely.
  it('a doc comment naming rpcUrl is not a log', () => {
    // The comment sits INSIDE the argument list: text outside a log call is never inspected, so a
    // comment placed above one asserts nothing about comment handling.
    expect(
      identifiers(
        `consola.info(\n  // the rpcUrl is deliberately not printed\n  'network', name\n)\n${LEAK}`
      )
    ).toEqual(['fullHost'])
  })

  it('a help string mentioning --rpcUrl is not a log', () => {
    expect(
      identifiers(`consola.info('run with --rpcUrl <url>')\n${LEAK}`)
    ).toEqual(['fullHost'])
  })

  it('an object key named rpcUrl labels a field rather than reading one', () => {
    expect(
      identifiers(`consola.info('Network', { rpcUrl: networkName })\n${LEAK}`)
    ).toEqual(['fullHost'])
  })

  it('a string literal inside a template interpolation is still a string', () => {
    expect(
      identifiers(
        `consola.warn(\`\${name.replace('ETH_NODE_URI_', '')}\`)\n${LEAK}`
      )
    ).toEqual(['fullHost'])
  })
})

describe('a value read through an operator is still a value', () => {
  // Requiring only a following `:` would suppress this: it is how an override-or-default is
  // written at exactly these call sites.
  it('catches the consequent of a ternary', () => {
    expect(identifiers("consola.info(`${flag ? rpcUrl : ''}`)\n")).toEqual([
      'rpcUrl',
    ])
  })

  it('catches the alternative of a ternary', () => {
    expect(identifiers("consola.info(`${flag ? '' : rpcUrl}`)\n")).toEqual([
      'rpcUrl',
    ])
  })
})

describe('regex literals do not derail the lexer', () => {
  // A regex is blanked like a string. Without that, a quote or backtick inside one opens a
  // phantom literal that swallows the rest of the file — four shipped files went blind this way.
  it.each([
    ['a character class holding quotes', 'const RE = /[\'"]/g\n'],
    ['a character class holding a backtick', 'const RE = /[`]/g\n'],
    [
      'a scheme strip, which contains //',
      "const s = x.replace(/^https:\\/\\//, '')\n",
    ],
    ['an apostrophe inside a regex', "const RE = /don't/\n"],
  ])('still sees a leak after %s', (_name, prefix) => {
    expect(
      identifiers(`${prefix}consola.info(\`connecting via \${rpcUrl}\`)\n`)
    ).toEqual(['rpcUrl'])
  })

  it('sees a leak in a log call that itself contains a regex', () => {
    expect(
      identifiers(
        "consola.info(`${scheme.replace(/^https:\\/\\//, '')} -> ${rpcUrl}`)\n"
      )
    ).toEqual(['rpcUrl'])
  })

  // Division must not be mistaken for a regex, or real code gets blanked instead.
  it('does not read division as a regex', () => {
    expect(
      identifiers(
        `const q = a/b/c\nconsola.info('n', { rpcUrl: net })\n${LEAK}`
      )
    ).toEqual(['fullHost'])
  })

  it('does not let a parenthesis inside a regex spill the call boundary', () => {
    // An unmatched `(` in a regex used to run the "arguments" to end-of-file, reporting later,
    // unrelated lines as leaks.
    expect(
      scanFixture(
        "consola.info(msg.replace(/\\(/g, ''))\n" +
          'const rpcUrl = process.env.ETH_NODE_URI_TRON\n' +
          'const client = http(rpcUrl)\n'
      ).findings
    ).toEqual([])
  })
})

describe('malformed sources do not crash or hang the walk', () => {
  it('an unterminated call still terminates', () => {
    expect(identifiers('consola.info(`${rpcUrl}`\n')).toEqual(['rpcUrl'])
  })

  it('an unterminated string does not throw', () => {
    expect(() => scanFixture("const s = 'oops\n")).not.toThrow()
  })
})

describe('the walk survives what a real tree contains', () => {
  it('skips a directory that does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
    try {
      const { findings, scanned } = scanForRawRpcUrlLogs(root, ['nope'])
      expect(scanned).toEqual([])
      expect(findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('steps over a dangling symlink and still reads its neighbour', () => {
    // An unguarded stat throws ENOENT out of the whole scan, failing the suite with an error
    // that names neither this rule nor the file.
    const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
    try {
      mkdirSync(join(root, 'script'), { recursive: true })
      symlinkSync(
        join(root, 'script', 'gone.ts'),
        join(root, 'script', 'dangling.ts')
      )
      writeFileSync(join(root, 'script', 'real.ts'), LEAK)
      const { findings, scanned } = scanForRawRpcUrlLogs(root, ['script'])
      expect(scanned).toEqual(['script/real.ts'])
      expect(findings.map((f) => f.identifier)).toEqual(['fullHost'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not follow a symlinked directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
    try {
      mkdirSync(join(root, 'script', 'real'), { recursive: true })
      writeFileSync(join(root, 'script', 'real', 'a.ts'), LEAK)
      symlinkSync(join(root, 'script', 'real'), join(root, 'script', 'link'))
      const { scanned } = scanForRawRpcUrlLogs(root, ['script'])
      expect(scanned).toEqual(['script/real/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an unterminated regex running to end of file does not hang', () => {
    // endOfRegex gives up rather than blanking on, so the leak before it is still reported.
    expect(identifiers('consola.info(`${rpcUrl}`)\nconst RE = /abc[')).toEqual([
      'rpcUrl',
    ])
  })
})

describe('blankNonCode', () => {
  it('keeps length and line numbering so offsets still line up', () => {
    const src = "const a = 'xx' // yy\nconst b = 1\n"
    const out = blankNonCode(src)
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })

  it('blanks a string body but keeps a template interpolation', () => {
    const out = blankNonCode("const s = 'secret'\nconst t = `x ${rpcUrl} y`\n")
    expect(out).not.toContain('secret')
    expect(out).toContain('rpcUrl')
  })

  it('blanks a string nested inside a template interpolation', () => {
    const out = blankNonCode("const t = `${n.replace('ETH_NODE_URI_', '')}`\n")
    expect(out).not.toContain('ETH_NODE_URI_')
    expect(out).toContain('replace')
  })

  it('blanks a regex body but leaves division alone', () => {
    expect(blankNonCode('const RE = /secret/g\n')).not.toContain('secret')
    expect(blankNonCode('const q = total/count\n')).toContain('total/count')
  })
})
