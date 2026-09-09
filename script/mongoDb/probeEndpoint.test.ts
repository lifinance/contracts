/**
 * Tests for the endpoint reachability probe.
 *
 * The cleartext case is asserted against a real local server so the claim is that no request was
 * made, not merely that the return value was false — a probe that refuses a URL and contacts it
 * anyway has already leaked the credential it was protecting.
 */
// eslint-disable-next-line import/no-unresolved
import { afterEach, describe, expect, it } from 'bun:test'

import { probeEndpoint } from './probeEndpoint'

const servers: { stop: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

/** Local endpoint that answers every call, counting how many requests it received. */
function serve(): { url: string; requests: () => number } {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests++
      const { id } = (await request.json()) as { id: number }
      return Response.json({ jsonrpc: '2.0', id, result: '0x1' })
    },
  })
  servers.push(server)
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
  }
}

describe('probeEndpoint', () => {
  it('accepts a credential-free http endpoint that answers', async () => {
    const server = serve()
    expect(await probeEndpoint(server.url)).toBe(true)
    expect(server.requests()).toBeGreaterThan(0)
  })

  it('never contacts an http endpoint carrying a key in the query', async () => {
    const server = serve()
    const withKey = `${server.url}/?dkey=AbCdEf0123456789xyz`

    expect(await probeEndpoint(withKey)).toBe(false)
    expect(server.requests()).toBe(0)
  })

  it('never contacts an http endpoint carrying basic auth', async () => {
    const server = serve()
    const withAuth = server.url.replace('http://', 'http://user:pass@')

    expect(await probeEndpoint(withAuth)).toBe(false)
    expect(server.requests()).toBe(0)
  })

  it('never contacts an http endpoint carrying a key-shaped path segment', async () => {
    const server = serve()
    const withKeyPath = `${server.url}/abcdef0123456789abcdef`

    expect(await probeEndpoint(withKeyPath)).toBe(false)
    expect(server.requests()).toBe(0)
  })

  it('reports an endpoint that refuses the state read as unreachable', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { id, method } = (await request.json()) as {
          id: number
          method: string
        }
        if (method === 'eth_chainId')
          return Response.json({ jsonrpc: '2.0', id, result: '0x1' })
        return Response.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'method not available' },
        })
      },
    })
    servers.push(server)

    expect(await probeEndpoint(`http://127.0.0.1:${server.port}`)).toBe(false)
  })
})
