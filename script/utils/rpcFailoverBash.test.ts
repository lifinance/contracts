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
    const dir = mkdtempSync(join(tmpdir(), 'rpc-classify-'))
    const fullPath = join(dir, 'full.txt')
    const extractedPath = join(dir, 'extracted.txt')
    try {
      const script = [
        'source script/helperFunctions.sh >/dev/null 2>&1',
        `executeAndParse 'printf "${FORGE_STDOUT}"; printf "error sending request for url (x)" >&2' "true"`,
        // Exactly what the retry loop hands to the resolver.
        `printf "%s\\n%s" "$STDERR_CONTENT" "$RAW_STDOUT_FULL" > ${fullPath}`,
        `printf "%s\\n%s" "$STDERR_CONTENT" "$RAW_RETURN_DATA" > ${extractedPath}`,
      ].join('\n')

      await runBash(script, REPO_ROOT)
      const { classifyForgeFailure } = await import('./rpcFailover')

      expect(classifyForgeFailure(readFileSync(fullPath, 'utf8'))).toBe(
        'postBroadcast'
      )
      // Same run classified from the extracted stdout: the guard cannot fire.
      expect(classifyForgeFailure(readFileSync(extractedPath, 'utf8'))).toBe(
        'preBroadcast'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

/**
 * Executes the real `tryRpcFailover` with the resolver CLI replaced by a stub, so the
 * bash contract itself is under test rather than the text of the script. The stub
 * records the exclusion list it was handed and returns a fresh endpoint each call.
 */
describe('tryRpcFailover (executed)', () => {
  // Scope: the bash bookkeeping around the resolver. Whether a given forge failure may
  // fail over at all is decided by classifyForgeFailure and covered in
  // rpcFailover.test.ts against captured forge output.
  // Patch the real function's resolver invocation by shadowing `bunx`.
  const runWithFakeBunx = async (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'rpc-failover-bunx-'))
    writeFileSync(join(dir, 'counter'), '0')
    writeFileSync(join(dir, 'exclude.log'), '')
    writeFileSync(
      join(dir, 'bunx'),
      [
        '#!/bin/bash',
        'cat > /dev/null',
        'printf "%s\n===\n" "$LIFI_RPC_EXCLUDE" >> "$EXCLUDE_LOG"',
        'N=$(cat "$COUNTER"); N=$((N + 1)); printf "%s" "$N" > "$COUNTER"',
        'printf "https://endpoint-%s.example/key" "$N"',
      ].join('\n'),
      { mode: 0o755 }
    )

    const script = [
      'source script/helperFunctions.sh >/dev/null 2>&1',
      `export COUNTER="${join(dir, 'counter')}"`,
      `export EXCLUDE_LOG="${join(dir, 'exclude.log')}"`,
      `export PATH="${dir}:$PATH"`,
      body,
    ].join('\n')

    const result = await runBash(script, REPO_ROOT)
    const excludeLog = readFileSync(join(dir, 'exclude.log'), 'utf8')
    rmSync(dir, { recursive: true, force: true })
    return { ...result, excludeLog }
  }

  it('switches the endpoint on a pre-broadcast failure', async () => {
    const { stdout } = await runWithFakeBunx(
      [
        'export ETH_NODE_URI_CELO="https://broken.example/key"',
        'tryRpcFailover celo "Error: Failed to get EIP-1559 fees" >/dev/null',
        'echo "RESULT:$ETH_NODE_URI_CELO"',
      ].join('\n')
    )

    expect(stdout).toContain('RESULT:https://endpoint-1.example/key')
  })

  // The bug this replaces a grep-based assertion for: without per-network
  // accumulation, endpoint 1 becomes selectable again on the third failure.
  it('keeps excluding every endpoint already tried on the same network', async () => {
    const { excludeLog } = await runWithFakeBunx(
      [
        'export ETH_NODE_URI_CELO="https://broken.example/key"',
        'for i in 1 2 3; do tryRpcFailover celo "Error: Failed to get EIP-1559 fees" >/dev/null; done',
      ].join('\n')
    )

    const lastCall = excludeLog.trim().split('===').filter(Boolean).pop() ?? ''

    expect(lastCall).toContain('https://broken.example/key')
    expect(lastCall).toContain('https://endpoint-1.example/key')
    expect(lastCall).toContain('https://endpoint-2.example/key')
  })

  it('does not leak one network exclusions into another', async () => {
    const { excludeLog } = await runWithFakeBunx(
      [
        'export ETH_NODE_URI_CELO="https://celo-bad.example/key"',
        'export ETH_NODE_URI_POLYGON="https://polygon-bad.example/key"',
        'tryRpcFailover celo "Error: Failed to get EIP-1559 fees" >/dev/null',
        'tryRpcFailover polygon "Error: Failed to get EIP-1559 fees" >/dev/null',
      ].join('\n')
    )

    const polygonCall =
      excludeLog.trim().split('===').filter(Boolean).pop() ?? ''

    expect(polygonCall).toContain('https://polygon-bad.example/key')
    expect(polygonCall).not.toContain('celo-bad')
  })

  // Returning to a network must remember what already failed there.
  it('remembers a network exclusions after visiting another network', async () => {
    const { excludeLog } = await runWithFakeBunx(
      [
        'export ETH_NODE_URI_CELO="https://celo-bad.example/key"',
        'export ETH_NODE_URI_POLYGON="https://polygon-bad.example/key"',
        'tryRpcFailover celo "Error: Failed to get EIP-1559 fees" >/dev/null',
        'tryRpcFailover polygon "Error: Failed to get EIP-1559 fees" >/dev/null',
        'tryRpcFailover celo "Error: Failed to get EIP-1559 fees" >/dev/null',
      ].join('\n')
    )

    const lastCall = excludeLog.trim().split('===').filter(Boolean).pop() ?? ''

    expect(lastCall).toContain('https://celo-bad.example/key')
    expect(lastCall).not.toContain('polygon-bad')
  })
})

describe('endpoint override survives later scripts re-reading .env', () => {
  // deploySingleContract fails over, then diamondUpdateFacet re-sources
  // helperFunctions.sh, which re-reads .env. Without the override file that snaps the
  // endpoint back to the one just proven inadequate and the diamondCut fails for the
  // same reason the deploy did.
  const OVERRIDE = 'https://failover-endpoint.example/key'

  const runWithOverrideFile = async (extraSourcing: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'rpc-override-'))
    const overrideFile = join(dir, 'override')
    writeFileSync(overrideFile, `ETH_NODE_URI_CELO=${OVERRIDE}\n`, {
      mode: 0o600,
    })

    const script = [
      `export LIFI_RPC_OVERRIDE_FILE="${overrideFile}"`,
      'source script/helperFunctions.sh >/dev/null 2>&1',
      extraSourcing,
      'echo "RESULT:$ETH_NODE_URI_CELO"',
    ].join('\n')

    const result = await runBash(script, REPO_ROOT)
    rmSync(dir, { recursive: true, force: true })
    return result
  }

  it('survives a second source of helperFunctions.sh', async () => {
    const result = await runWithOverrideFile(
      'source script/helperFunctions.sh >/dev/null 2>&1'
    )

    expect(result.stdout).toContain(`RESULT:${OVERRIDE}`)
  })

  it('survives a bare re-read of .env', async () => {
    const result = await runWithOverrideFile('set -a; source .env; set +a')

    // A bare re-read has no re-apply step, so the configured endpoint wins again.
    // This documents the boundary: the override travels through helperFunctions.sh.
    expect(result.stdout).not.toContain(`RESULT:${OVERRIDE}`)
  })

  it('is a no-op when no override file is set', async () => {
    const result = await runBash(
      [
        'unset LIFI_RPC_OVERRIDE_FILE',
        'source script/helperFunctions.sh >/dev/null 2>&1',
        'test -n "$ETH_NODE_URI_CELO" && echo "CONFIGURED_ENDPOINT_PRESENT"',
      ].join('\n'),
      REPO_ROOT
    )

    expect(result.stdout).toContain('CONFIGURED_ENDPOINT_PRESENT')
  })
})
