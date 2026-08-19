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

/**
 * Returns a loopback URL whose port is guaranteed closed: the server is bound (so the
 * OS picked a free port) and then stopped. Hard-coding a "surely dead" port instead
 * would make these tests depend on what happens to be listening on the machine.
 */
const closedUrl = async (path = ''): Promise<string> => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `${server.url.origin}${path}`
  server.stop(true)
  return url
}

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
      gasPrice: true,
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
    const result = await probeRpcEndpoint(await closedUrl('/'), 500)
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
    const result = await probeRpcEndpoint(await closedUrl('/secret-key'), 300)

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
    const deadPrimary = await closedUrl('/dead')
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
      envUrl: await closedUrl('/dead-a'),
      mongoRpcs: [{ url: await closedUrl('/dead-b'), priority: 1 }],
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

describe('regressions found in adversarial review', () => {
  it.each([
    ['geth known transaction', 'known transaction: 0xabc'],
    ['besu uppercase code', 'TRANSACTION_ALREADY_KNOWN'],
    ['nonce too high', 'server returned an error response: nonce too high'],
    ['parity old nonce', 'OldNonce'],
    ['already in the pool', 'transaction already in the pool'],
    ['bare underpriced', 'transaction underpriced'],
  ])('recognises %s as post-broadcast', (_label, output) => {
    expect(classifyForgeFailure(output)).toBe('postBroadcast')
  })

  it('lets a mempool signature outrank a transport signature in mixed output', () => {
    expect(
      classifyForgeFailure(
        'error sending request for url (...)\nknown transaction: 0xabc'
      )
    ).toBe('postBroadcast')
  })

  it('still allows failover for a fee-estimation failure with no broadcast evidence', () => {
    expect(
      classifyForgeFailure(
        'Error: Failed to get EIP-1559 fees; deserialization error: missing field `mixHash`'
      )
    ).toBe('preBroadcast')
  })

  // A rate limiter answering HTTP 200 with a JSON body that has neither result nor
  // error would otherwise probe as fully capable and outrank healthy endpoints.
  it('treats a 200 response with no result as a failed call', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ message: 'Too Many Requests' }),
    })
    try {
      const result = await probeRpcEndpoint(server.url.href, 1_000)
      expect(result.live).toBe(false)
      expect(result.feeHistory).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it('treats a null result as a failed call', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: null })
      },
    })
    try {
      const result = await probeRpcEndpoint(server.url.href, 1_000)
      expect(result.live).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  // Present-but-null fails forge's deserialization exactly like a missing field.
  it('does not count a null mixHash as EIP-1559 support', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { method: string; id: number }
        const result =
          body.method === 'eth_getBlockByNumber'
            ? { baseFeePerGas: '0x1', mixHash: null, number: '0x1' }
            : '0x1'
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      },
    })
    try {
      const result = await probeRpcEndpoint(server.url.href, 1_000)
      expect(result.live).toBe(true)
      expect(result.eip1559Block).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  // chainCapabilities is a union and may describe an endpoint that was not selected,
  // so a caller deciding how to transact must read the winner's own capabilities.
  it('reports the selected endpoint capabilities separately from the union', () => {
    const candidates: IRpcCandidate[] = [
      { url: 'https://a.example.com', source: 'env', priority: 0 },
      { url: 'https://b.example.com', source: 'mongo', priority: 5 },
    ]
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { eip1559Block: false, gasPrice: true }),
      probe('https://b.example.com', { eip1559Block: true, gasPrice: false }),
    ])

    // Both score 2, so trust selects the env endpoint...
    expect(best?.url).toBe('https://a.example.com')
    // ...whose own block is not 1559-capable, even though the chain supports it.
    expect(best?.capabilities.eip1559Block).toBe(false)
    expect(best?.chainCapabilities.eip1559Block).toBe(true)
  })

  it('lets a lost gasPrice probe change the ranking outcome', () => {
    const candidates: IRpcCandidate[] = [
      { url: 'https://a.example.com', source: 'env', priority: 0 },
      { url: 'https://b.example.com', source: 'mongo', priority: 5 },
    ]
    const best = selectBestCandidate(candidates, [
      probe('https://a.example.com', { gasPrice: false }),
      probe('https://b.example.com'),
    ])

    expect(best?.url).toBe('https://b.example.com')
  })

  // An authenticated and an anonymous URL for the same host are different endpoints;
  // collapsing them drops the only candidate that can authenticate.
  it('does not collapse a credentialed URL into an anonymous one', () => {
    const result = collectCandidates({
      envUrl: 'https://rpc.example.com/v1',
      mongoRpcs: [{ url: 'https://user:key@rpc.example.com/v1', priority: 5 }],
    })

    expect(result).toHaveLength(2)
  })

  it('excludes an endpoint written with a different query-parameter order', () => {
    const result = collectCandidates({
      envUrl: 'https://rpc.example.com/r?b=2&a=1',
      exclude: ['https://rpc.example.com/r?a=1&b=2'],
    })

    expect(result).toEqual([])
  })
})

/**
 * Verbatim `forge script --broadcast --slow --json` output (forge 1.7.1) captured
 * against a mock node driven into each failure mode. Hand-written approximations were
 * how an earlier version of this suite came to "cover" a guard that could never fire:
 * under --json forge suppresses the progress lines those fixtures relied on.
 */
const REAL_FORGE_OUTPUT = {
  // Endpoint answers everything except eth_feeHistory (the celo production symptom).
  noFeeHistory:
    'Error: Failed to get EIP-1559 fees; server returned an error response: error code -32601: the method eth_feeHistory does not exist/is not available',

  // Block has no mixHash, or mixHash: null (the moonbeam / fuse / moonriver symptom).
  noMixHash:
    'Error: Failed to deploy script:\nEVM error; header validation error: `prevrandao` not set\n',

  // Node accepted eth_sendRawTransaction, then died before replying.
  killedDuringSend:
    'Error: Failed to send transaction after 4 attempts Err(error sending request for url (http://127.0.0.1:8599/)\n\nContext:\n- Error #0: client error (SendRequest)\n- Error #1: connection closed before message completed)\n\nContext:\n- Error #0: client error (Connect)\n- Error #1: tcp connect error\n- Error #2: Connection refused (os error 61)\n',

  // Node died while forge polled for the receipt of an accepted transaction.
  killedDuringPoll:
    'ERROR alloy_rpc_client::poller: failed to poll err=error sending request for url (http://127.0.0.1:8599/)\nWarning: Some transactions were discarded by the RPC node. Use `--resume` to retry these transactions.\n',

  // Successful broadcast: the artifact path has no dry-run segment.
  broadcastArtifact:
    '{"status":"success","transactions":"/tmp/fp/broadcast/D.s.sol/42220/run-latest.json","sensitive":"/tmp/fp/cache/D.s.sol/42220/run-latest.json"}',

  // Simulation only: same file name, under dry-run/. Nothing was submitted.
  dryRunArtifact:
    'SIMULATION COMPLETE. To broadcast these transactions, add --broadcast and wallet configuration(s) to the previous command.\n\nTransactions saved to: /tmp/fp/broadcast/D.s.sol/42220/dry-run/run-latest.json\n',
}

describe('classifyForgeFailure against real forge output', () => {
  it('allows failover when the endpoint lacks eth_feeHistory', () => {
    expect(classifyForgeFailure(REAL_FORGE_OUTPUT.noFeeHistory)).toBe(
      'preBroadcast'
    )
  })

  it('allows failover when the chain has no mixHash', () => {
    expect(classifyForgeFailure(REAL_FORGE_OUTPUT.noMixHash)).toBe(
      'preBroadcast'
    )
  })

  // These two are the dangerous direction: the transaction may be in the mempool.
  it('refuses failover when the node died mid-send', () => {
    expect(classifyForgeFailure(REAL_FORGE_OUTPUT.killedDuringSend)).toBe(
      'postBroadcast'
    )
  })

  it('refuses failover when the node died while polling for a receipt', () => {
    expect(classifyForgeFailure(REAL_FORGE_OUTPUT.killedDuringPoll)).toBe(
      'postBroadcast'
    )
  })

  it('refuses failover once a broadcast artifact has been written', () => {
    expect(
      classifyForgeFailure(
        `${REAL_FORGE_OUTPUT.broadcastArtifact}\nerror sending request`
      )
    ).toBe('postBroadcast')
  })

  // A dry run writes the same file name under dry-run/ and submits nothing, so it must
  // not pin the endpoint.
  it('still allows failover after a simulation-only run', () => {
    expect(
      classifyForgeFailure(
        `${REAL_FORGE_OUTPUT.dryRunArtifact}\nError: error sending request for url (x)`
      )
    ).toBe('preBroadcast')
  })

  it('treats a bare transport error with no broadcast marker as pre-broadcast', () => {
    expect(
      classifyForgeFailure(
        'Error: error sending request for url (x)\n\nContext:\n- Error #2: Connection refused (os error 61)'
      )
    ).toBe('preBroadcast')
  })
})

describe('URL normalization keeps distinct API keys distinct', () => {
  it('does not collapse a plus-encoded key into a percent-encoded one', () => {
    const result = collectCandidates({
      envUrl: 'https://h.io/r?dkey=AB+CD',
      mongoRpcs: [{ url: 'https://h.io/r?dkey=AB%20CD', priority: 1 }],
    })

    expect(result).toHaveLength(2)
  })

  it('does not exclude one encoding when the other was excluded', () => {
    const result = collectCandidates({
      envUrl: 'https://h.io/r?dkey=AB+CD',
      exclude: ['https://h.io/r?dkey=AB%20CD'],
    })

    expect(result).toHaveLength(1)
  })

  it('still treats a reordered query as the same endpoint', () => {
    const result = collectCandidates({
      envUrl: 'https://h.io/r?b=2&a=1',
      exclude: ['https://h.io/r?a=1&b=2'],
    })

    expect(result).toEqual([])
  })
})
