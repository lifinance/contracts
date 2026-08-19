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
 * re-reads `.env` on every call, then the retry loop exports an override, then forge
 * runs and resolves its endpoint from the environment.
 *
 * `exportBeforeSource` flips that order to prove the test can detect the mistake.
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
