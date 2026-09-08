/**
 * Behavioral tests for the RPC fallback transport, run against real local HTTP servers rather
 * than mocks: what is under test is whether viem's `fallback` actually advances past an HTTP 429
 * from a rate-limited endpoint and a JSON-RPC "method not found" from a method-restricted one,
 * which a stubbed transport cannot establish.
 */
// eslint-disable-next-line import/no-unresolved
import { afterEach, describe, expect, it } from 'bun:test'
import { createPublicClient } from 'viem'

import { getRPCEnvVarName, getRPCFallbacksEnvVarName } from './utils'
import {
  getFallbackTransportForChain,
  getViemChainForNetworkName,
} from './viemScriptHelpers'

const NETWORK = 'mainnet'
const PRIMARY_ENV = getRPCEnvVarName(NETWORK)
const FALLBACKS_ENV = getRPCFallbacksEnvVarName(NETWORK)

const DEPLOYED_CODE = '0x6080604052'

const servers: { stop: () => void }[] = []
const savedEnv = {
  primary: process.env[PRIMARY_ENV],
  fallbacks: process.env[FALLBACKS_ENV],
}

/** Local JSON-RPC endpoint whose every response is produced by `respond`. */
function serve(respond: (id: number) => Response): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as { id: number }
      return respond(payload.id)
    },
  })
  servers.push(server)
  return `http://localhost:${server.port}`
}

/** Echoes the request id back: viem correlates the response by it. */
function rpcResult(id: number, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result })
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  if (savedEnv.primary === undefined) delete process.env[PRIMARY_ENV]
  else process.env[PRIMARY_ENV] = savedEnv.primary
  if (savedEnv.fallbacks === undefined) delete process.env[FALLBACKS_ENV]
  else process.env[FALLBACKS_ENV] = savedEnv.fallbacks
})

function clientFor(primary: string, fallbacks: string[]) {
  process.env[PRIMARY_ENV] = primary
  if (fallbacks.length) process.env[FALLBACKS_ENV] = fallbacks.join(' ')
  else delete process.env[FALLBACKS_ENV]
  const chain = getViemChainForNetworkName(NETWORK)
  return createPublicClient({
    chain,
    transport: getFallbackTransportForChain(chain),
  })
}

describe('getFallbackTransportForChain', () => {
  it('advances past an endpoint that answers HTTP 429', async () => {
    const throttled = serve(
      () => new Response('rate limited: obtain an api key', { status: 429 })
    )
    const healthy = serve((id) => rpcResult(id, DEPLOYED_CODE))

    const client = clientFor(throttled, [healthy])
    const code = await client.getCode({
      address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    })

    expect(code).toBe(DEPLOYED_CODE)
  })

  it('advances past an endpoint that does not implement the method', async () => {
    const restricted = serve((id) =>
      Response.json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'the method eth_getCode does not exist/is not available',
        },
      })
    )
    const healthy = serve((id) => rpcResult(id, DEPLOYED_CODE))

    const client = clientFor(restricted, [healthy])
    const code = await client.getCode({
      address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    })

    expect(code).toBe(DEPLOYED_CODE)
  })

  it('fails when every endpoint is throttled, rather than reporting empty state', async () => {
    const first = serve(() => new Response('rate limited', { status: 429 }))
    const second = serve(() => new Response('rate limited', { status: 429 }))

    const client = clientFor(first, [second])

    let threw = false
    try {
      await client.getCode({
        address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
  })

  it('uses a plain http transport when the chain has one endpoint', () => {
    const only = serve((id) => rpcResult(id, DEPLOYED_CODE))
    expect(clientFor(only, []).transport.type).toBe('http')
  })

  it('uses a fallback transport when the chain has more than one endpoint', () => {
    const primary = serve((id) => rpcResult(id, DEPLOYED_CODE))
    const backup = serve((id) => rpcResult(id, DEPLOYED_CODE))
    expect(clientFor(primary, [backup]).transport.type).toBe('fallback')
  })
})

describe('getViemChainForNetworkName', () => {
  it('keeps the primary at index 0 so existing callers resolve it unchanged', () => {
    const primary = serve((id) => rpcResult(id, DEPLOYED_CODE))
    const backup = serve((id) => rpcResult(id, DEPLOYED_CODE))
    process.env[PRIMARY_ENV] = primary
    process.env[FALLBACKS_ENV] = backup

    const chain = getViemChainForNetworkName(NETWORK)
    expect(chain.rpcUrls.default.http[0]).toBe(primary)
    expect(chain.rpcUrls.default.http).toHaveLength(2)
  })

  it('ignores an empty fallbacks variable', () => {
    const primary = serve((id) => rpcResult(id, DEPLOYED_CODE))
    process.env[PRIMARY_ENV] = primary
    process.env[FALLBACKS_ENV] = '   '

    expect(getViemChainForNetworkName(NETWORK).rpcUrls.default.http).toEqual([
      primary,
    ])
  })
})
