/**
 * The credential rule this repo now enforces: no shipped script puts a raw RPC endpoint into a
 * log line.
 *
 * `ETH_NODE_URI_*` embeds the provider key in the URL, so `consola.info(`… ${rpcUrl}`)` writes a
 * live credential into every transcript of every run. One such site (troncast) leaked the Tron
 * key into a session on 2026-09-09.
 *
 * The scan is textual, so most of what follows is aimed at the scan itself rather than at the
 * tree: each innocent way this repo mentions an endpoint is pinned as a NEGATIVE beside a real
 * leak in the same fixture, so a check that started refusing everything — or nothing — fails here
 * before it reaches a reviewer.
 */
/* eslint-disable no-template-curly-in-string --
   The fixtures below are TypeScript SOURCE TEXT handed to the scanner. `${rpcUrl}` is the leak
   being detected, not an interpolation this file means to perform. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** Run the scan over a throwaway tree holding exactly `source`. */
function scanFixture(source: string): ReturnType<typeof scanForRawRpcUrlLogs> {
  const root = mkdtempSync(join(tmpdir(), 'rpc-log-scan-'))
  try {
    const dir = join(root, 'script')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fixture.ts'), source)
    return scanForRawRpcUrlLogs(root, ['script'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

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
    // A stale exemption silently widens the rule to a path nobody is watching.
    for (const path of EXEMPT.keys()) expect(scanned).toContain(path)
  })
})

describe('the scan fires on a new leak', () => {
  // The ticket's own criterion: add a log of a raw RPC URL and watch it go red. It also proves
  // the walk reads the filesystem — a `git ls-files` enumeration cannot see an uncommitted file,
  // which is precisely the file a new leak arrives in.
  it('catches a freshly written file that logs the endpoint', () => {
    const { findings, scanned } = scanFixture(
      'const rpcUrl = process.env.ETH_NODE_URI_TRON\nconsola.info(`connecting via ${rpcUrl}`)\n'
    )
    expect(scanned).toContain('script/fixture.ts')
    expect(findings.map((f) => f.identifier)).toEqual(['rpcUrl'])
  })

  it('catches the endpoint read straight off the environment', () => {
    const { findings } = scanFixture(
      'consola.warn(`using ${process.env.ETH_NODE_URI_TRON}`)\n'
    )
    expect(findings.map((f) => f.identifier)).toEqual(['ETH_NODE_URI_TRON'])
  })

  it('stays silent once the same site is redacted', () => {
    const { findings } = scanFixture(
      'const rpcUrl = process.env.ETH_NODE_URI_TRON\n' +
        'consola.info(`connecting via ${redactUrls(rpcUrl)}`)\n'
    )
    expect(findings).toEqual([])
  })
})

describe('the three innocent mentions stay silent, beside a leak that does not', () => {
  // Each case carries a real leak alongside the innocent form. Without it the case would pass
  // against a scan that had stopped looking at that file at all.
  const leak = 'consola.error(`down: ${fullHost}`)\n'

  it('a doc comment naming rpcUrl is not a log', () => {
    const { findings } = scanFixture(
      `/** Takes an rpcUrl and logs it. */\n${leak}`
    )
    expect(findings.map((f) => f.identifier)).toEqual(['fullHost'])
  })

  it('a help string mentioning --rpcUrl is not a log', () => {
    const { findings } = scanFixture(
      `consola.info('run with --rpcUrl <url>')\n${leak}`
    )
    expect(findings.map((f) => f.identifier)).toEqual(['fullHost'])
  })

  it('an object key named rpcUrl labels a field rather than reading one', () => {
    const { findings } = scanFixture(
      `consola.info('Network', { rpcUrl: networkName })\n${leak}`
    )
    expect(findings.map((f) => f.identifier)).toEqual(['fullHost'])
  })

  it('a string literal inside a template interpolation is still a string', () => {
    // The bug this pins: keeping `${...}` as code, but forgetting that code can hold strings.
    const { findings } = scanFixture(
      `consola.warn(\`\${name.replace('ETH_NODE_URI_', '')}\`)\n${leak}`
    )
    expect(findings.map((f) => f.identifier)).toEqual(['fullHost'])
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
})
