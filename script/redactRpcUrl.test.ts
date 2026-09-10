/**
 * Regression tests for the two bash endpoint redactors — `redactRpcUrl`
 * (`script/helperFunctions.sh`) and `bgRedactUrl`
 * (`script/emergency/emergencyPauseBreakGlass.sh`) — and for the shared bash paths that print
 * their output: the retry helper that returns it, and `parseExecuteCommandResult`.
 *
 * `getRPCUrl` returns the keyed `ETH_NODE_URI_<NETWORK>` on stdout and `cast` embeds `--rpc-url`
 * in its error text, so both the value and any RPC failure carry the provider key.
 *
 * `bgRedactUrl` is a deliberate second copy: the break-glass script must not depend on
 * `helperFunctions.sh` loading. Both are exercised here so the copy cannot rot.
 */
import { execFileSync } from 'child_process'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * Run `script` with the named bash functions pulled out of their files.
 *
 * The functions are extracted rather than sourced: `emergencyPauseBreakGlass.sh` runs `main` at
 * the bottom, so sourcing it would execute the break-glass path.
 *
 * @param defs - [file, function name] pairs to make available
 * @param script - bash to run once the definitions are loaded
 * @param args - positional arguments for the script
 */
function withBashFns(
  defs: [string, string][],
  script: string,
  args: string[] = []
): string {
  const extracts = defs
    .map(
      ([file, fn]) =>
        // -E, not BRE: BSD sed has no `\\?`, so a basic-regex extraction silently matches nothing
        // and every test then fails with "command not found".
        `source <(sed -nE '/^(function )?${fn}\\(\\) \\{/,/^\\}/p' ${file})`
    )
    .join('\n')
  return execFileSync(
    'bash',
    ['-c', `${extracts}\n${script}`, 'harness', ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }
  )
}

const REDACTORS: [string, string][] = [
  ['script/helperFunctions.sh', 'redactRpcUrl'],
  ['script/emergency/emergencyPauseBreakGlass.sh', 'bgRedactUrl'],
]

describe.each(REDACTORS)('%s > %s', (file, fn) => {
  const redact = (value: string): string =>
    withBashFns([[file, fn]], `${fn} "$1"`, [value])

  it.each([
    ['a key in the path', 'https://lb.drpc.org/ogrpc/KEY123'],
    ['a key in the query', 'https://eth.example/v1?dkey=KEY123'],
    ['a nodereal-style path key', 'https://eth-mainnet.nodereal.io/v1/KEY123'],
    ['a websocket endpoint', 'wss://eth.example/ws/KEY123'],
  ])('removes %s', (_name, url) => {
    expect(redact(url)).toBe('[redacted-url]')
  })

  it('redacts a URL inside a realistic cast error, keeping the rest', () => {
    const out = redact(
      'Error: error sending request for url (https://x.io/v1/KEY123): operation timed out'
    )
    expect(out).not.toContain('KEY123')
    expect(out).toContain('operation timed out')
  })

  it('leaves text with no endpoint untouched', () => {
    // Paired negative: a redactor returning a constant would satisfy every case above.
    expect(redact('no endpoint here')).toBe('no endpoint here')
  })

  it('redacts every endpoint on the line, not just the first', () => {
    const out = redact('primary https://a.io/K1 fallback https://b.io/K2')
    expect(out).not.toContain('K1')
    expect(out).not.toContain('K2')
  })

  it('survives an empty argument under set -u', () => {
    expect(withBashFns([[file, fn]], `set -u; ${fn} ""`)).toBe('')
  })
})

/**
 * Both scripts define their own `rpcCallWithRetry`. The readiness one runs on a schedule in
 * GitHub Actions, where its output lands in a CI log, and was the untested of the two.
 */
const RETRY_SCRIPTS: [string, [string, string][]][] = [
  [
    'script/emergency/emergencyPauseBreakGlass.sh',
    [
      ['script/emergency/emergencyPauseBreakGlass.sh', 'bgRedactUrl'],
      ['script/emergency/emergencyPauseBreakGlass.sh', 'rpcCallWithRetry'],
    ],
  ],
  [
    'script/utils/verifyEmergencyPauseReadinessGitHub.sh',
    [
      ['script/helperFunctions.sh', 'redactRpcUrl'],
      [
        'script/utils/verifyEmergencyPauseReadinessGitHub.sh',
        'rpcCallWithRetry',
      ],
    ],
  ],
]

describe.each(RETRY_SCRIPTS)('%s > rpcCallWithRetry', (_label, defs) => {
  const run = (script: string): string =>
    withBashFns(
      defs,
      `RPC_MAX_ATTEMPTS=2\nRPC_RETRY_SLEEP_SECONDS=0\n${script}`
    )

  it('redacts the endpoint on the exhaustion path', () => {
    // The failing path is the one that runs during an incident, and every caller echoes what it
    // returns. Redacting only the per-attempt retry line left this one leaking.
    const out = run(
      `failing() { echo "Error: error sending request for url (https://lb.drpc.org/ogrpc?network=base&dkey=FAKEKEY777)" >&2; return 1; }\n` +
        `rpcCallWithRetry "label" failing 2>/dev/null || true`
    )
    expect(out).not.toContain('FAKEKEY777')
    expect(out).toContain('[redacted-url]')
  })

  it('redacts an endpoint that arrived on stdout instead of stderr', () => {
    // The `${LAST_ERR:-$OUT}` fallback: helpers that merge stderr with 2>&1 land here.
    const out = run(
      `failing() { echo "failed for url (https://x.io/v1/FAKEKEY888)"; return 1; }\n` +
        `rpcCallWithRetry "label" failing 2>/dev/null || true`
    )
    expect(out).not.toContain('FAKEKEY888')
    expect(out).toContain('[redacted-url]')
  })

  it('leaves a successful result verbatim', () => {
    // The success path returns data callers parse — a balance, an address. Redacting it would
    // break every one of them, so this is the assertion that keeps the fix honest.
    expect(
      run(`ok() { echo "1000000000000000000"; }\nrpcCallWithRetry "label" ok`)
    ).toBe('1000000000000000000')
  })

  it('does not redact a URL that appears in successful output', () => {
    expect(
      run(
        `ok() { echo "see https://docs.example/x"; }\nrpcCallWithRetry "label" ok`
      )
    ).toBe('see https://docs.example/x')
  })
})

/**
 * The widest of the bash paths: every `forge script` execution routed through `executeAndParse`
 * lands here, and `error` is not debug-gated, so a failed deploy prints the captured stderr —
 * which carries `--rpc-url` — on any run, not only a `DEBUG=true` one.
 */
describe('script/helperFunctions.sh > parseExecuteCommandResult', () => {
  const run = (stderr: string): string =>
    withBashFns(
      [
        ['script/helperFunctions.sh', 'redactRpcUrl'],
        ['script/helperFunctions.sh', 'error'],
        ['script/helperFunctions.sh', 'echoDebug'],
        ['script/helperFunctions.sh', 'parseExecuteCommandResult'],
      ],
      `parseExecuteCommandResult "$1" "deploy failed" "continue" 2>&1 || true`,
      [JSON.stringify({ stdout: '', stderr, returnCode: 1 })]
    )

  it('redacts the endpoint in the stderr it prints on failure', () => {
    const out = run(
      'Error: error sending request for url (https://lb.drpc.org/ogrpc?network=base&dkey=FAKEKEY999)'
    )
    expect(out).not.toContain('FAKEKEY999')
    expect(out).toContain('[redacted-url]')
    expect(out).toContain('deploy failed')
  })

  it('leaves failure stderr that names no endpoint intact', () => {
    expect(run('EvmError: Revert')).toContain('EvmError: Revert')
  })
})
