/* eslint-disable no-template-curly-in-string --
   The fixtures are TypeScript SOURCE TEXT handed to the scanner. `${rpcUrl}` is the leak being
   detected, not an interpolation this file performs. */
/**
 * Guards the rule that no shipped script puts a raw RPC endpoint into a log line.
 *
 * Every innocent way this repo names an endpoint is pinned as a negative BESIDE a real leak in
 * the same fixture, so a scan that has started refusing everything — or seeing nothing — fails
 * here rather than in review.
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

import {
  EXEMPT,
  LOG_METHODS,
  RPC_IDENTIFIERS,
  scanForRawRpcUrlLogs,
} from './rpc-url-log-scan'

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

  it('walks every root it claims, not just script/', () => {
    // Dropping `tasks` from the default roots leaves >100 files scanned and both asserted paths
    // present, so nothing else here would notice.
    const { scanned } = scanForRawRpcUrlLogs(REPO_ROOT)
    expect(scanned.some((p) => p.startsWith('tasks/'))).toBe(true)
  })

  it('every exemption still names a file that exists', () => {
    const { scanned } = scanForRawRpcUrlLogs(REPO_ROOT)
    // Asserted non-empty first: a for-of over an emptied map is vacuously green.
    expect(EXEMPT.size).toBeGreaterThan(0)
    for (const path of EXEMPT.keys()) expect(scanned).toContain(path)
  })

  // Pinned by VALUE for the same reason as the vocabulary below: a widened exemption would
  // otherwise carry its own test with it and silence a real leak in that file.
  it('pins the exempted identifiers', () => {
    expect(
      [...EXEMPT].map(([path, { identifiers }]) => [path, identifiers])
    ).toEqual([['script/demoScripts/demoPaxosTransit.ts', ['RPC_URL']]])
    for (const { why } of EXEMPT.values()) expect(why.length).toBeGreaterThan(0)
  })

  it('an exempted file is still scanned for everything it did not exempt', () => {
    // The one exempted file also reads ETH_NODE_URI_MAINNET for its anvil fork. A whole-file
    // skip would hide a credential-bearing log added there later.
    const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
    try {
      const roots = new Set<string>()
      for (const [path, entry] of EXEMPT) {
        mkdirSync(join(root, path.slice(0, path.lastIndexOf('/'))), {
          recursive: true,
        })
        const exemptedLogs = entry.identifiers
          .map((id) => `consola.info(\`\${${id}}\`)`)
          .join('\n')
        writeFileSync(
          join(root, path),
          `${exemptedLogs}\nconsola.warn(\`\${process.env.ETH_NODE_URI_MAINNET}\`)\n`
        )
        roots.add(path.slice(0, path.indexOf('/')))
      }
      const { findings } = scanForRawRpcUrlLogs(root, [...roots])
      expect(findings.map((f) => f.identifier)).toEqual(
        [...EXEMPT.keys()].map(() => 'ETH_NODE_URI_MAINNET')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it('catches an endpoint reached through a property chain', () => {
    expect(
      identifiers('consola.info(`${chain.rpcUrls.default.http[0]}`)\n')
    ).toEqual(['rpcUrls'])
  })

  it.each(['fatal', 'trace', 'verbose'])('catches consola.%s', (method) => {
    expect(identifiers(`consola.${method}(\`\${rpcUrl}\`)\n`)).toEqual([
      'rpcUrl',
    ])
  })

  it('catches console.dir, which dumps a whole object', () => {
    expect(identifiers('console.dir({ url: rpcUrl })\n')).toEqual(['rpcUrl'])
  })

  it('catches a shorthand property, which reads the variable', () => {
    expect(identifiers('consola.info({ rpcUrl })\n')).toEqual(['rpcUrl'])
  })

  it('catches a computed key, where the endpoint becomes the printed key', () => {
    expect(identifiers('consola.info({ [rpcUrl]: n })\n')).toEqual(['rpcUrl'])
  })

  // The two sets are pinned by VALUE. Iterating the constant alone is self-referential: deleting
  // an entry also deletes its case, so the assertion moves with the mutation.
  it('pins the vocabulary and the log surface', () => {
    expect([...RPC_IDENTIFIERS]).toEqual([
      'rpcUrl',
      'rpcUrls',
      'fullHost',
      'nodeUrl',
      'providerUrl',
      'endpointUrl',
    ])
    expect([...LOG_METHODS]).toEqual([
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
    ])
  })

  it.each([...RPC_IDENTIFIERS])('catches the identifier %s', (name) => {
    expect(identifiers(`consola.info(\`\${${name}}\`)\n`)).toEqual([name])
  })

  it.each([...LOG_METHODS])('catches consola.%s', (method) => {
    expect(identifiers(`consola.${method}(\`\${rpcUrl}\`)\n`)).toEqual([
      'rpcUrl',
    ])
  })

  it('reports the line and the text a developer reads when CI goes red', () => {
    const [finding] = scanFixture(
      '// a leading comment\nconst x = 1\nconsola.info(`connecting via ${rpcUrl}`)\n'
    ).findings
    expect(finding?.line).toBe(3)
    expect(finding?.text).toContain('rpcUrl')
  })

  it('stays silent once the same site is redacted', () => {
    expect(
      scanFixture(
        'const rpcUrl = process.env.ETH_NODE_URI_TRON\n' +
          'consola.info(`connecting via ${redactUrls(rpcUrl)}`)\n'
      ).findings
    ).toEqual([])
  })

  it('accepts a redactor reached through a namespace', () => {
    // `utils.redactUrls(...)` — without the member branch of calleeName this reads as an
    // unredacted call and reports honest code.
    expect(
      scanFixture('consola.info(utils.redactUrls(rpcUrl))\n').findings
    ).toEqual([])
  })

  it.each(['hostOf', 'redactErrorReason'])(
    'accepts %s as a redaction too',
    (fn) => {
      // redactErrorReason has 27 call sites in the repo and was unpinned.
      expect(scanFixture(`consola.info(${fn}(rpcUrl))\n`).findings).toEqual([])
    }
  )
})

describe('the innocent mentions stay silent, beside a leak that does not', () => {
  // Each fixture carries a real leak. Without it a case would pass against a scan that had
  // stopped reading the file entirely.
  it('a doc comment naming rpcUrl is not a log', () => {
    // Inside the argument list: text outside a log call is never inspected, so a comment placed
    // above one would assert nothing about comment handling.
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

  it('a type annotation names a field that never renders', () => {
    expect(
      identifiers(`consola.info('cfg', cfg as { rpcUrl?: string })\n${LEAK}`)
    ).toEqual(['fullHost'])
  })

  it('a parameter binding is a name, not a read', () => {
    expect(
      identifiers(
        `consola.info(list.map((rpcUrl) => hostOf(rpcUrl)).join())\n${LEAK}`
      )
    ).toEqual(['fullHost'])
  })

  it('a type query names a type, not a value', () => {
    // `cfg as { rpcUrl?: string }` is caught by the property-signature rule alone; this shape
    // reaches the identifier only if type nodes are skipped outright.
    expect(identifiers(`consola.info(cfg as typeof rpcUrl)\n${LEAK}`)).toEqual([
      'fullHost',
    ])
  })

  it('a variable declared inside the call is a name, not a read', () => {
    expect(
      identifiers(
        `consola.info((() => { const rpcUrl = pick(); return hostOf(rpcUrl) })())\n${LEAK}`
      )
    ).toEqual(['fullHost'])
  })

  it('a consola or console method that prints nothing is not a log surface', () => {
    expect(identifiers(`console.time(rpcUrl)\n${LEAK}`)).toEqual(['fullHost'])
    expect(identifiers(`consola.withTag(rpcUrl)\n${LEAK}`)).toEqual([
      'fullHost',
    ])
  })

  it.each([
    ['a method shorthand', 'consola.info({ rpcUrl() { return 1 } })'],
    ['a getter', 'consola.info({ get rpcUrl() { return 1 } })'],
    ['a setter', 'consola.info({ set rpcUrl(v) {} })'],
    ['a class property', 'consola.info(class { rpcUrl = 1 })'],
    [
      'a named function expression',
      'consola.info((function rpcUrl(){ return 1 })())',
    ],
    ['a renamed binding', 'consola.info((({ rpcUrl: u }) => hostOf(u))(o))'],
  ])('%s names something rather than reading it', (_n, src) => {
    // Asked structurally, so this list is illustration rather than the rule — an enumeration of
    // declaration kinds is what left accessors and methods reporting.
    expect(identifiers(`${src}\n${LEAK}`)).toEqual(['fullHost'])
  })

  it('a logger that is not consola or console is not a log surface', () => {
    // Without the receiver check this becomes "any x.info()", and every wrapper in the repo
    // starts failing CI.
    expect(identifiers(`logger.info(\`\${rpcUrl}\`)\n${LEAK}`)).toEqual([
      'fullHost',
    ])
  })

  it('a vocabulary word inside a regex is not a value', () => {
    expect(identifiers(`consola.info(typeof /rpcUrl/)\n${LEAK}`)).toEqual([
      'fullHost',
    ])
  })
})

describe('a value read through an operator is still a value', () => {
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

describe('grammar the previous text-scanning versions got wrong', () => {
  // Each of these blinded or false-alarmed a hand-written lexer across three rounds. They are
  // kept as behaviour, not as lexer internals: the parser is what makes them uninteresting.
  it.each([
    ['a character class holding quotes', 'const RE = /[\'"]/g\n'],
    ['a character class holding a backtick', 'const RE = /[`]/g\n'],
    [
      'a scheme strip, which contains //',
      "const s = x.replace(/^https:\\/\\//, '')\n",
    ],
    ['an apostrophe inside a regex', "const RE = /don't/\n"],
    [
      'a regex in value position after a call',
      'if (isTron(net)) /[\'"]/.test(s)\n',
    ],
    [
      'a regex in value position after an index',
      'const R = LIST[0] /[\'"]/.test(s)\n',
    ],
  ])('still sees a leak after %s', (_name, prefix) => {
    expect(
      identifiers(`${prefix}consola.info(\`connecting via \${rpcUrl}\`)\n`)
    ).toEqual(['rpcUrl'])
  })

  it('does not report a vocabulary word in a regex reached without a semicolon', () => {
    expect(
      scanFixture(
        'consola.info(\n  items.map((x) => {\n    n++\n    return /rpcUrl/.test(x)\n  }).length\n)\n'
      ).findings
    ).toEqual([])
  })

  it('does not let a parenthesis inside a regex spill the call boundary', () => {
    expect(
      scanFixture(
        "consola.info(msg.replace(/\\(/g, ''))\n" +
          'const rpcUrl = process.env.ETH_NODE_URI_TRON\n' +
          'const client = http(rpcUrl)\n'
      ).findings
    ).toEqual([])
  })
})

describe('malformed sources do not crash the walk', () => {
  it('an unterminated call still reports what it can', () => {
    // The parser error-recovers rather than throwing.
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
})
