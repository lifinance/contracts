import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import {
  classifyForgeFailure,
  collectCandidates,
  probeRpcEndpoint,
  redactRpcUrl,
  selectBestCandidate,
  type IRpcCandidate,
  resolveEndpoint,
  type IRpcProbe,
} from './rpcFailover'

const probe = (url: string, over: Partial<IRpcProbe> = {}): IRpcProbe => ({
  url,
  live: true,
  feeHistory: true,
  eip1559Block: true,
  gasPrice: true,
  ...over,
})

describe('redactRpcUrl', () => {
  it('keeps only scheme and host so API keys in the path never surface', () => {
    expect(
      redactRpcUrl('https://lb.drpc.org/ogrpc?network=celo&dkey=SECRET')
    ).toBe('https://lb.drpc.org')
    expect(redactRpcUrl('https://eth.example.com/v2/abc123def')).toBe(
      'https://eth.example.com'
    )
  })

  it('preserves a non-default port because it identifies the endpoint', () => {
    expect(redactRpcUrl('http://127.0.0.1:8545/key')).toBe(
      'http://127.0.0.1:8545'
    )
  })

  it('never echoes the input when it cannot be parsed', () => {
    expect(redactRpcUrl('not a url at all')).toBe('<unparseable-url>')
  })

  it('redacts basic-auth credentials embedded in the authority', () => {
    expect(redactRpcUrl('https://user:pass@rpc.example.com/path')).toBe(
      'https://rpc.example.com'
    )
  })
})

describe('collectCandidates', () => {
  it('unions env, mongo and networks.json in trust order', () => {
    const result = collectCandidates({
      envUrl: 'https://env.example.com',
      mongoRpcs: [
        { url: 'https://low.example.com', priority: 1 },
        { url: 'https://high.example.com', priority: 9 },
      ],
      networksJsonUrl: 'https://njson.example.com',
    })

    expect(result.map((c) => c.url)).toEqual([
      'https://env.example.com',
      'https://high.example.com',
      'https://low.example.com',
      'https://njson.example.com',
    ])
    expect(result.map((c) => c.source)).toEqual([
      'env',
      'mongo',
      'mongo',
      'networksJson',
    ])
  })

  it('deduplicates the same endpoint across sources, keeping the most trusted', () => {
    const result = collectCandidates({
      envUrl: 'https://same.example.com',
      mongoRpcs: [{ url: 'https://same.example.com/', priority: 5 }],
      networksJsonUrl: 'https://same.example.com',
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('env')
  })

  it('treats host case and trailing slashes as the same endpoint', () => {
    const result = collectCandidates({
      envUrl: 'https://Same.Example.com/',
      mongoRpcs: [{ url: 'https://same.example.com', priority: 5 }],
    })

    expect(result).toHaveLength(1)
  })

  it('drops excluded endpoints so a failed one is never retried', () => {
    const result = collectCandidates({
      envUrl: 'https://broken.example.com',
      mongoRpcs: [{ url: 'https://good.example.com', priority: 1 }],
      exclude: ['https://broken.example.com'],
    })

    expect(result.map((c) => c.url)).toEqual(['https://good.example.com'])
  })

  it('matches exclusions using the same normalization as dedup', () => {
    const result = collectCandidates({
      mongoRpcs: [{ url: 'https://Broken.example.com/', priority: 1 }],
      exclude: ['https://broken.example.com'],
    })

    expect(result).toHaveLength(0)
  })

  it('ignores empty or malformed sources rather than throwing', () => {
    const result = collectCandidates({
      envUrl: '',
      mongoRpcs: [{ url: 'not-a-url', priority: 1 }],
      networksJsonUrl: undefined,
    })

    expect(result).toEqual([])
  })

  it('ignores non-http schemes', () => {
    const result = collectCandidates({ envUrl: 'ws://rpc.example.com' })

    expect(result).toEqual([])
  })
})

describe('selectBestCandidate', () => {
  const candidates: IRpcCandidate[] = [
    { url: 'https://a.example.com', source: 'env', priority: 0 },
    { url: 'https://b.example.com', source: 'mongo', priority: 5 },
    { url: 'https://c.example.com', source: 'networksJson', priority: 0 },
  ]

  it('rejects a dead endpoint even when it is the most trusted', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { live: false }),
      probe('https://b.example.com'),
      probe('https://c.example.com'),
    ])

    expect(best?.url).toBe('https://b.example.com')
  })

  it('prefers more capabilities over more trust (the celo case)', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { feeHistory: false }),
      probe('https://b.example.com', { feeHistory: false }),
      probe('https://c.example.com'),
    ])

    expect(best?.url).toBe('https://c.example.com')
    expect(best?.source).toBe('networksJson')
  })

  it('falls back to trust then priority when capabilities tie', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com'),
      probe('https://b.example.com'),
      probe('https://c.example.com'),
    ])

    expect(best?.url).toBe('https://a.example.com')
  })

  it('orders equally-capable mongo endpoints by descending priority', () => {
    const mongoOnly: IRpcCandidate[] = [
      { url: 'https://low.example.com', source: 'mongo', priority: 1 },
      { url: 'https://high.example.com', source: 'mongo', priority: 9 },
    ]
    const best = selectBestCandidate(mongoOnly, [
      probe('https://low.example.com'),
      probe('https://high.example.com'),
    ])

    expect(best?.url).toBe('https://high.example.com')
  })

  // The moonbeam/fuse case: mixHash is absent chain-wide, so requiring it would
  // reject every candidate and hard-fail a chain that deploys fine with --legacy.
  it('still returns a live endpoint when NO candidate has a capability', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { eip1559Block: false }),
      probe('https://b.example.com', { eip1559Block: false }),
      probe('https://c.example.com', { eip1559Block: false }),
    ])

    expect(best).not.toBeNull()
    expect(best?.url).toBe('https://a.example.com')
    expect(best?.chainCapabilities.eip1559Block).toBe(false)
  })

  it('reports chain capabilities as the union across candidates', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', {
        feeHistory: false,
        eip1559Block: false,
      }),
      probe('https://b.example.com', { feeHistory: true, eip1559Block: false }),
      probe('https://c.example.com', {
        feeHistory: false,
        eip1559Block: false,
      }),
    ])

    expect(best?.chainCapabilities).toEqual({
      feeHistory: true,
      eip1559Block: false,
    })
  })

  it('computes the capability union from live endpoints only', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { feeHistory: false }),
      probe('https://b.example.com', { live: false, feeHistory: true }),
      probe('https://c.example.com', { feeHistory: false }),
    ])

    expect(best?.chainCapabilities.feeHistory).toBe(false)
  })

  it('returns null when every candidate is dead rather than a broken URL', () => {
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { live: false }),
      probe('https://b.example.com', { live: false }),
      probe('https://c.example.com', { live: false }),
    ])

    expect(best).toBeNull()
  })

  it('returns null for an empty candidate list', () => {
    expect(selectBestCandidate([], [])).toBeNull()
  })

  it('ignores probes with no matching candidate', () => {
    const best = selectBestCandidate(
      [candidates[0] as IRpcCandidate],
      [probe('https://a.example.com'), probe('https://orphan.example.com')]
    )

    expect(best?.url).toBe('https://a.example.com')
  })
})

describe('classifyForgeFailure', () => {
  it.each([
    [
      'missing field `mixHash`',
      'Failed to get EIP-1559 fees; deserialization error: missing field `mixHash`',
    ],
    [
      'feeHistory unsupported',
      'server returned an error response: error code -32601: method eth_feeHistory does not exist',
    ],
    [
      'connection refused',
      'error sending request: tcp connect error: Connection refused (os error 61)',
    ],
    [
      'dns failure',
      'error sending request: dns error: failed to lookup address information',
    ],
    ['timeout', 'error sending request: operation timed out'],
    [
      'no output',
      'No JSON output received. This usually indicates a connection/RPC error.',
    ],
  ])(
    'classifies %s as pre-broadcast (safe to switch endpoint)',
    (_label, output) => {
      expect(classifyForgeFailure(output)).toBe('preBroadcast')
    }
  )

  it.each([
    [
      'already known',
      'server returned an error response: error code -32603: already known',
    ],
    ['nonce too low', 'server returned an error response: nonce too low'],
    ['replacement underpriced', 'replacement transaction underpriced'],
    ['already imported', 'Transaction with the same hash was already imported'],
  ])(
    'classifies %s as post-broadcast (never switch endpoint)',
    (_label, output) => {
      expect(classifyForgeFailure(output)).toBe('postBroadcast')
    }
  )

  it('classifies an unrecognised failure as unknown', () => {
    expect(classifyForgeFailure('EvmError: Revert')).toBe('unknown')
  })

  it('classifies empty output as unknown', () => {
    expect(classifyForgeFailure('')).toBe('unknown')
  })

  // A transaction that reached the mempool must pin the endpoint regardless of what
  // else the output says: switching backends mid-sequence is what produced the
  // moonbeam -32603 stall during the FeeForwarder rollout.
  it('lets post-broadcast win when both signatures are present', () => {
    const mixed = 'missing field `mixHash`\nlater: already known'
    expect(classifyForgeFailure(mixed)).toBe('postBroadcast')
  })

  it('matches case-insensitively', () => {
    expect(classifyForgeFailure('ALREADY KNOWN')).toBe('postBroadcast')
    expect(classifyForgeFailure('CONNECTION REFUSED')).toBe('preBroadcast')
  })
})

describe('probeRpcEndpoint', () => {
  const startServer = (
    handler: (method: string) => unknown | { error: unknown }
  ) => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { method: string; id: number }
        const outcome = handler(body.method)
        if (outcome && typeof outcome === 'object' && 'error' in outcome)
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: outcome.error,
          })
        return Response.json({ jsonrpc: '2.0', id: body.id, result: outcome })
      },
    })
    return server
  }

  const fullBlock = {
    baseFeePerGas: '0x1',
    mixHash: '0x0',
    number: '0x1',
  }

  it('reports every capability for a healthy endpoint', async () => {
    const server = startServer((method) => {
      if (method === 'eth_blockNumber') return '0x1'
      if (method === 'eth_feeHistory') return { baseFeePerGas: ['0x1'] }
      if (method === 'eth_getBlockByNumber') return fullBlock
      return '0x1'
    })
    try {
      const result = await probeRpcEndpoint(server.url.href)
      expect(result).toMatchObject({
        live: true,
        feeHistory: true,
        eip1559Block: true,
        gasPrice: true,
      })
    } finally {
      server.stop(true)
    }
  })

  // celo: answers eth_blockNumber fine but has no eth_feeHistory, which is exactly
  // why a liveness-only health check selects a broken endpoint.
  it('detects a live endpoint that lacks eth_feeHistory', async () => {
    const server = startServer((method) => {
      if (method === 'eth_feeHistory')
        return { error: { code: -32601, message: 'method not found' } }
      if (method === 'eth_getBlockByNumber') return fullBlock
      return '0x1'
    })
    try {
      const result = await probeRpcEndpoint(server.url.href)
      expect(result.live).toBe(true)
      expect(result.feeHistory).toBe(false)
      expect(result.eip1559Block).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  // moonbeam/fuse: baseFeePerGas present, mixHash absent.
  it('detects a block that forge cannot deserialize as EIP-1559', async () => {
    const server = startServer((method) => {
      if (method === 'eth_getBlockByNumber')
        return { baseFeePerGas: '0x1', number: '0x1' }
      if (method === 'eth_feeHistory') return { baseFeePerGas: ['0x1'] }
      return '0x1'
    })
    try {
      const result = await probeRpcEndpoint(server.url.href)
      expect(result.live).toBe(true)
      expect(result.eip1559Block).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it('marks an endpoint dead when it is unreachable', async () => {
    const result = await probeRpcEndpoint('http://127.0.0.1:1/', 500)
    expect(result.live).toBe(false)
    expect(result.feeHistory).toBe(false)
  })

  it('marks an endpoint dead on a non-2xx response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('nope', { status: 503 }),
    })
    try {
      const result = await probeRpcEndpoint(server.url.href)
      expect(result.live).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it('marks an endpoint dead when eth_blockNumber errors', async () => {
    const server = startServer(() => ({
      error: { code: -32000, message: 'unsupported' },
    }))
    try {
      const result = await probeRpcEndpoint(server.url.href)
      expect(result.live).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it('survives a malformed JSON response instead of throwing', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('<html>not json</html>', { status: 200 }),
    })
    try {
      const result = await probeRpcEndpoint(server.url.href)
      expect(result.live).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it('times out a hanging endpoint rather than blocking the run', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' })
      },
    })
    try {
      const started = Date.now()
      const result = await probeRpcEndpoint(server.url.href, 300)
      expect(result.live).toBe(false)
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      server.stop(true)
    }
  })

  // The probe result is a fixed set of booleans plus the URL it belongs to. Carrying a
  // free-form error string would let a transport error quoting the full URL (forge does
  // exactly this) escape into logs downstream.
  it('exposes no free-form error text that could carry the URL into logs', async () => {
    const result = await probeRpcEndpoint('http://127.0.0.1:1/secret-key', 300)

    expect(Object.keys(result).sort()).toEqual([
      'eip1559Block',
      'feeHistory',
      'gasPrice',
      'live',
      'url',
    ])
    expect(Object.entries(result).filter(([key]) => key !== 'url')).toEqual([
      ['live', false],
      ['feeHistory', false],
      ['eip1559Block', false],
      ['gasPrice', false],
    ])
  })
})

describe('resolveEndpoint (negative controls)', () => {
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

  // Guards the whole point of the feature: if failover silently does nothing, the
  // resolver returns the dead primary and this fails.
  it('recovers via an alternative when the primary endpoint is dead', async () => {
    const server = healthyServer()
    const deadPrimary = 'http://127.0.0.1:1/dead'
    try {
      const selection = await resolveEndpoint({
        envUrl: deadPrimary,
        mongoRpcs: [{ url: server.url.href, priority: 5 }],
        timeoutMs: 500,
      })

      expect(selection).not.toBeNull()
      expect(selection?.url).not.toBe(deadPrimary)
      expect(selection?.url).toBe(server.url.href)
      expect(selection?.source).toBe('mongo')
    } finally {
      server.stop(true)
    }
  })

  // The celo case end-to-end: the primary is live but cannot serve eth_feeHistory.
  it('switches away from a live endpoint that lacks a capability an alternative has', async () => {
    const good = healthyServer()
    const noFeeHistory = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { method: string; id: number }
        if (body.method === 'eth_feeHistory')
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'method not found' },
          })
        const result =
          body.method === 'eth_getBlockByNumber'
            ? { baseFeePerGas: '0x1', mixHash: '0x0', number: '0x1' }
            : '0x1'
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      },
    })
    try {
      const selection = await resolveEndpoint({
        envUrl: noFeeHistory.url.href,
        mongoRpcs: [{ url: good.url.href, priority: 1 }],
        timeoutMs: 1_000,
      })

      expect(selection?.url).toBe(good.url.href)
      expect(selection?.chainCapabilities.feeHistory).toBe(true)
    } finally {
      good.stop(true)
      noFeeHistory.stop(true)
    }
  })

  it('returns null rather than a broken URL when every candidate is dead', async () => {
    const selection = await resolveEndpoint({
      envUrl: 'http://127.0.0.1:1/dead-a',
      mongoRpcs: [{ url: 'http://127.0.0.1:2/dead-b', priority: 1 }],
      timeoutMs: 300,
    })

    expect(selection).toBeNull()
  })

  it('returns null when there are no candidates at all', async () => {
    expect(await resolveEndpoint({})).toBeNull()
  })

  it('does not return an endpoint that was excluded, even if it is the only live one', async () => {
    const server = healthyServer()
    try {
      const selection = await resolveEndpoint({
        envUrl: server.url.href,
        exclude: [server.url.href],
        timeoutMs: 500,
      })

      expect(selection).toBeNull()
    } finally {
      server.stop(true)
    }
  })
})
