/**
 * Tests for the bash side of RPC failover.
 *
 * Two things are checked here that no TypeScript test can reach: that an exported
 * endpoint override survives `deploySingleContract`'s per-call `source .env`, and that
 * the wiring in the shell scripts keeps RPC URLs out of the process table.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..', '..')

const runBash = async (script: string, cwd: string) => {
  const proc = Bun.spawn(['bash', '-c', script], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr, exitCode }
}

/**
 * Reproduces the ordering that matters in `deploySingleContract()`: the function
 * re-reads `.env` once on entry, then the retry loop exports an override, then forge
 * runs and resolves its endpoint from the environment. An override written before that
 * read is discarded.
 *
 * `exportBeforeSource` flips the order to prove the test can detect the mistake.
 */
const buildHarness = (exportBeforeSource: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-failover-'))

  writeFileSync(
    join(dir, '.env'),
    'ETH_NODE_URI_TESTCHAIN="https://broken.example.com"\n'
  )

  // Stands in for forge: records whichever endpoint the environment resolves to.
  writeFileSync(
    join(dir, 'fake-forge.sh'),
    '#!/bin/bash\nprintf "%s" "$ETH_NODE_URI_TESTCHAIN" > "$1"\n',
    { mode: 0o755 }
  )

  const override = 'export ETH_NODE_URI_TESTCHAIN="https://working.example.com"'
  const sourceEnv = 'set -a; source .env; set +a'

  writeFileSync(
    join(dir, 'deploy.sh'),
    [
      '#!/bin/bash',
      'deploySingleContract() {',
      ...(exportBeforeSource
        ? [`  ${override}`, `  ${sourceEnv}`]
        : [`  ${sourceEnv}`, `  ${override}`]),
      '  ./fake-forge.sh "$1"',
      '}',
      'deploySingleContract "$1"',
    ].join('\n'),
    { mode: 0o755 }
  )

  return dir
}

describe('endpoint override vs the per-call `source .env`', () => {
  it('survives when the export happens after .env is re-read', async () => {
    const dir = buildHarness(false)
    try {
      const recorded = join(dir, 'recorded.txt')
      const result = await runBash(`./deploy.sh ${recorded}`, dir)

      expect(result.exitCode).toBe(0)
      expect(readFileSync(recorded, 'utf8')).toBe('https://working.example.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Negative control: if this passed, the test above would prove nothing.
  it('is silently reverted when the export happens before .env is re-read', async () => {
    const dir = buildHarness(true)
    try {
      const recorded = join(dir, 'recorded.txt')
      await runBash(`./deploy.sh ${recorded}`, dir)

      expect(readFileSync(recorded, 'utf8')).toBe('https://broken.example.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shell wiring', () => {
  const deployScript = readFileSync(
    join(REPO_ROOT, 'script', 'deploy', 'deploySingleContract.sh'),
    'utf8'
  )
  const helpers = readFileSync(
    join(REPO_ROOT, 'script', 'helperFunctions.sh'),
    'utf8'
  )

  const lineOf = (haystack: string, needle: string) =>
    haystack.split('\n').findIndex((line) => line.includes(needle))

  it('invokes failover after the per-call `source .env`, not before', () => {
    const sourceLine = lineOf(deployScript, 'source .env')
    const failoverLine = lineOf(deployScript, 'tryRpcFailover')

    expect(sourceLine).toBeGreaterThan(-1)
    expect(failoverLine).toBeGreaterThan(sourceLine)
  })

  it('invokes failover only after a forge attempt has failed', () => {
    const forgeLine = lineOf(deployScript, '--fork-url')
    const failoverLine = lineOf(deployScript, 'tryRpcFailover')

    expect(failoverLine).toBeGreaterThan(forgeLine)
  })

  // Attempt 1 must not consult the resolver, or every healthy chain pays probe latency.
  it('does not resolve an endpoint before the first forge attempt', () => {
    const beforeForge = deployScript.slice(
      0,
      deployScript.indexOf('--fork-url')
    )

    expect(beforeForge).not.toContain('tryRpcFailover')
    expect(beforeForge).not.toContain('resolveRpcUrl.ts')
  })

  it('keeps --fork-url on the network alias so no URL reaches the process table', () => {
    expect(deployScript).toContain('--fork-url \\"$NETWORK\\"')
  })

  it('passes the excluded endpoint through the environment, never as an argument', () => {
    expect(helpers).toContain('LIFI_RPC_EXCLUDE=')
    // An RPC URL as an argv element would be world-readable via `ps`.
    expect(helpers).not.toMatch(/resolveRpcUrl\.ts[^\n]*--exclude/)
    expect(helpers).not.toMatch(/resolveRpcUrl\.ts[^\n]*\$\{?RPC_URL/)
  })

  it('pipes forge output to the resolver instead of passing it as an argument', () => {
    expect(helpers).toMatch(
      /printf '%s' "\$FORGE_OUTPUT" \|[\s\S]{0,120}resolveRpcUrl\.ts/
    )
  })
})

describe('failure classification receives forge broadcast markers', () => {
  // forge's final --json object names the broadcast artifact, which is the evidence a
  // transaction was actually sent. `extractJsonFromForgeOutput` is a no-op while stdout
  // is a clean JSON stream, but as soon as one non-JSON line appears (a compiler
  // notice, a warning) it keeps only the {"logs":...} object and the evidence is lost.
  // Classifying from the unextracted copy removes that dependency entirely.
  const FORGE_STDOUT =
    'Compiler run successful!\\n' +
    '{\\"logs\\":[],\\"returns\\":{}}\\n' +
    '{\\"status\\":\\"success\\",\\"transactions\\":\\"/tmp/fp/broadcast/D.s.sol/42220/run-latest.json\\"}\\n'

  it('keeps the broadcast artifact line that JSON extraction discards', async () => {
    const script = [
      'source script/helperFunctions.sh >/dev/null 2>&1',
      `executeAndParse 'printf "${FORGE_STDOUT}"' "true"`,
      'echo "EXTRACTED:$RAW_RETURN_DATA"',
      'echo "FULL:$RAW_STDOUT_FULL"',
    ].join('\n')

    const result = await runBash(script, REPO_ROOT)

    // Extraction keeps only the trace object...
    expect(result.stdout).toContain('EXTRACTED:{"logs":[]')
    expect(result.stdout).not.toMatch(/EXTRACTED:[^\n]*run-latest\.json/)
    // ...while the unextracted copy still names the broadcast artifact.
    expect(result.stdout).toMatch(/FULL:[\s\S]*run-latest\.json/)
  })

  it('classifies the captured output as post-broadcast', async () => {
    const script = [
      'source script/helperFunctions.sh >/dev/null 2>&1',
      `executeAndParse 'printf "${FORGE_STDOUT}"; printf "error sending request for url (x)" >&2' "true"`,
      // Exactly what the retry loop hands to the resolver.
      'printf "%s\\n%s" "$STDERR_CONTENT" "$RAW_STDOUT_FULL" > /tmp/lifi-classify-full.txt',
      'printf "%s\\n%s" "$STDERR_CONTENT" "$RAW_RETURN_DATA" > /tmp/lifi-classify-extracted.txt',
    ].join('\n')

    await runBash(script, REPO_ROOT)
    const { classifyForgeFailure } = await import('./rpcFailover')

    const full = readFileSync('/tmp/lifi-classify-full.txt', 'utf8')
    const extracted = readFileSync('/tmp/lifi-classify-extracted.txt', 'utf8')

    expect(classifyForgeFailure(full)).toBe('postBroadcast')
    // Same run classified from the extracted stdout: the guard cannot fire.
    expect(classifyForgeFailure(extracted)).toBe('preBroadcast')
  })
})

describe('failover wiring safeguards', () => {
  const helpers = readFileSync(
    join(REPO_ROOT, 'script', 'helperFunctions.sh'),
    'utf8'
  )

  it('classifies from the unextracted stdout, not the JSON-extracted one', () => {
    const deployScript = readFileSync(
      join(REPO_ROOT, 'script', 'deploy', 'deploySingleContract.sh'),
      'utf8'
    )
    const call = deployScript.slice(deployScript.indexOf('tryRpcFailover'))

    expect(call).toContain('RAW_STDOUT_FULL')
  })

  it('accumulates exclusions so two bad endpoints cannot be chosen alternately', () => {
    expect(helpers).toContain('RPC_FAILOVER_EXCLUDED')
    expect(helpers).toMatch(
      /RPC_FAILOVER_EXCLUDED="\$\{RPC_FAILOVER_EXCLUDED:\+/
    )
  })

  it('masks a newly selected endpoint in GitHub Actions logs', () => {
    expect(helpers).toContain('::add-mask::$NEW_RPC_URL')
  })

  // getRPCUrl runs in tight per-selector loops; a probe there would cost minutes.
  it('leaves getRPCUrl free of resolver calls', () => {
    const start = helpers.indexOf('function getRPCUrl()')
    const body = helpers.slice(
      start,
      helpers.indexOf('function tryRpcFailover')
    )

    expect(start).toBeGreaterThan(-1)
    expect(body).not.toContain('resolveRpcUrl.ts')
  })
})
