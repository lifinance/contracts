/**
 * Contract tests for the `resolveRpcUrl` CLI.
 *
 * Bash callers capture stdout with a command substitution, so the guarantees under test
 * are: stdout carries the URL and nothing else, diagnostics stay on stderr with no
 * secret in them, and a failure exits non-zero instead of printing a broken URL.
 *
 * The CLI is spawned as a subprocess because those guarantees are properties of the
 * process, not of a function. MongoDB is disabled via an empty `MONGODB_URI` so no test
 * touches the network beyond loopback.
 */

import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

const CLI_PATH = join(import.meta.dir, 'resolveRpcUrl.ts')
const REPO_ROOT = join(import.meta.dir, '..', '..')

interface ICliResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runCli(
  args: string[],
  env: Record<string, string>
): Promise<ICliResult> {
  const proc = Bun.spawn(['bunx', 'tsx', CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Keep the run hermetic: no MongoDB lookup, no inherited endpoint config.
      MONGODB_URI: '',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/** Matches a URL that exposes more than scheme+host, i.e. a path or query that can hold an API key. */
const URL_WITH_PATH_OR_QUERY = /https?:\/\/[^\s'"]+[/?][^\s'"]+/

const healthyServer = () =>
  Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { method: string; id: number }
      const result =
        body.method === 'eth_getBlockByNumber'
          ? { baseFeePerGas: '0x1', mixHash: '0x0', number: '0x1' }
          : body.method === 'eth_feeHistory'
          ? { baseFeePerGas: ['0x1'] }
          : '0x1'
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })

describe('resolveRpcUrl CLI', () => {
  it(
    'prints the resolved URL on stdout and nothing else',
    async () => {
      const server = healthyServer()
      // A key with a path segment: if the CLI ever echoes the URL to stderr, the
      // secret-guard assertion below catches it.
      const url = `${server.url.origin}/secret-api-key`
      try {
        const result = await runCli(['celo'], { ETH_NODE_URI_CELO: url })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(url)
      } finally {
        server.stop(true)
      }
    },
    { timeout: 30_000 }
  )

  it(
    'never writes a full RPC URL to stderr',
    async () => {
      const server = healthyServer()
      const url = `${server.url.origin}/secret-api-key`
      try {
        const result = await runCli(['celo'], { ETH_NODE_URI_CELO: url })

        // The guarantee is that no key-bearing URL escapes, not that a diagnostic was
        // emitted: consola's level varies with the environment, so asserting the
        // presence of a log line would make this test report on the runner instead.
        expect(result.stderr).not.toContain('secret-api-key')
        expect(result.stderr).not.toMatch(URL_WITH_PATH_OR_QUERY)
        expect(result.stdout).toBe(url)
      } finally {
        server.stop(true)
      }
    },
    { timeout: 30_000 }
  )

  it(
    'exits non-zero with empty stdout when the only endpoint is dead',
    async () => {
      // An unknown network has no networks.json entry, so the dead env var is the
      // only candidate and the failure path is unambiguous.
      const result = await runCli(['definitelynotanetwork'], {
        ETH_NODE_URI_DEFINITELYNOTANETWORK: 'http://127.0.0.1:1/dead',
      })

      expect(result.exitCode).not.toBe(0)
      // stdout must stay empty so a bash command substitution yields "" and the
      // caller's error path runs, rather than a broken URL being used.
      expect(result.stdout).toBe('')
    },
    { timeout: 30_000 }
  )

  it(
    'exits non-zero for a network with no configured endpoint at all',
    async () => {
      const result = await runCli(['definitelynotanetwork'], {})

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('no usable RPC endpoint')
    },
    { timeout: 30_000 }
  )

  it(
    'skips an endpoint excluded via the environment',
    async () => {
      const server = healthyServer()
      // A comma in the query string would be shredded by a comma-separated list.
      const url = `${server.url.origin}/only-candidate?methods=eth_call,eth_getLogs`
      try {
        const result = await runCli(['definitelynotanetwork'], {
          ETH_NODE_URI_DEFINITELYNOTANETWORK: url,
          LIFI_RPC_EXCLUDE: url,
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe('')
      } finally {
        server.stop(true)
      }
    },
    { timeout: 30_000 }
  )

  it(
    'resolves the excluded endpoint when it is not excluded (control for the test above)',
    async () => {
      const server = healthyServer()
      const url = `${server.url.origin}/only-candidate`
      try {
        const result = await runCli(['definitelynotanetwork'], {
          ETH_NODE_URI_DEFINITELYNOTANETWORK: url,
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(url)
      } finally {
        server.stop(true)
      }
    },
    { timeout: 30_000 }
  )
})
