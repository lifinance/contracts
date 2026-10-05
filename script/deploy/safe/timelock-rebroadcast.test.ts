/**
 * Tests for the timelock executor's re-broadcast of a dropped `executeBatch`
 * tx and its "not on-chain" classification. RPC endpoints are stubbed (or
 * `fetch` is, for the endpoint builders), so nothing leaves the process.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'
import { defineChain, type Chain, type Hex } from 'viem'

import {
  buildChainEndpoints,
  confirmWithRebroadcast,
  createExecutorRpc,
  type IRpcEndpoint,
} from './timelock-rebroadcast'

const RAW: Hex = '0x02f8aa0102030405'
const HASH: Hex =
  '0x2222222222222222222222222222222222222222222222222222222222222222' // [pre-commit-checker: not a secret]
const FAST_POLL = { attempts: 3, delayMs: 1 }

const PRIMARY_URL = 'https://primary.example/v2/primary-key'
const FALLBACK_URL = 'https://fallback.example/v2/fallback-key'

/** isOperationDone stub that answers false `falseCalls` times, then true forever. */
function doneAfter(falseCalls: number): {
  isOperationDone: () => Promise<boolean>
  calls: () => number
} {
  let count = 0
  return {
    isOperationDone: async () => count++ >= falseCalls,
    calls: () => count,
  }
}

const neverDone = (): ReturnType<typeof doneAfter> =>
  doneAfter(Number.POSITIVE_INFINITY)

interface IEndpointSpy {
  endpoint: IRpcEndpoint
  sent: Hex[]
  receiptLookups: number
}

function endpointSpy(opts: {
  send?: (raw: Hex) => Promise<Hex>
  hasReceipt?: () => Promise<boolean>
}): IEndpointSpy {
  const spy: IEndpointSpy = {
    sent: [],
    receiptLookups: 0,
    endpoint: {
      sendRawTransaction: async (raw) => {
        spy.sent.push(raw)
        return opts.send ? opts.send(raw) : HASH
      },
      hasReceipt: async () => {
        spy.receiptLookups++
        return opts.hasReceipt ? opts.hasReceipt() : false
      },
    },
  }
  return spy
}

let logged: string[] = []
const originalWarn = consola.warn
const originalInfo = consola.info

beforeEach(() => {
  logged = []
  const capture = (...args: unknown[]): void => {
    logged.push(args.map(String).join(' '))
  }
  consola.warn = capture as typeof consola.warn
  consola.info = capture as typeof consola.info
})

afterEach(() => {
  consola.warn = originalWarn
  consola.info = originalInfo
})

describe('confirmWithRebroadcast', () => {
  it('returns confirmed without re-sending when the first poll window confirms', async () => {
    const fallback = endpointSpy({})
    const stub = doneAfter(1)

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: {
        primary: endpointSpy({}).endpoint,
        fallbacks: [fallback.endpoint],
      },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('confirmed')
    expect(fallback.sent).toEqual([])
  })

  it('returns reverted for a reverted receipt without re-sending', async () => {
    const fallback = endpointSpy({})

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      receipt: { status: 'reverted' },
      endpoints: { fallbacks: [fallback.endpoint] },
      isOperationDone: neverDone().isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('reverted')
    expect(fallback.sent).toEqual([])
  })

  it('primary drops the tx: re-sends the same bytes to every fallback and confirms on the extra poll round', async () => {
    const primary = endpointSpy({})
    const first = endpointSpy({})
    const second = endpointSpy({})
    // The whole first window stays false; the op lands during the extra round.
    const stub = doneAfter(FAST_POLL.attempts + 1)

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: {
        primary: primary.endpoint,
        fallbacks: [first.endpoint, second.endpoint],
      },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('confirmed')
    expect(first.sent).toEqual([RAW])
    expect(second.sent).toEqual([RAW])
    // Re-sent only to the fallbacks: the primary already holds (or dropped) it.
    expect(primary.sent).toEqual([])
    expect(stub.calls()).toBe(FAST_POLL.attempts + 2)
  })

  it('keeps polling when a fallback rejects the re-send, and never logs its URL', async () => {
    const rejecting = endpointSpy({
      send: async () => {
        throw new Error(
          `already known\nURL: ${FALLBACK_URL}\nRequest body: {"method":"eth_sendRawTransaction"}`
        )
      },
    })
    const accepting = endpointSpy({})
    const stub = doneAfter(FAST_POLL.attempts + 1)

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: { fallbacks: [rejecting.endpoint, accepting.endpoint] },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('confirmed')
    expect(accepting.sent).toEqual([RAW])
    expect(logged.join('\n')).toContain('already known')
    expect(logged.join('\n')).not.toContain('fallback.example')
    expect(logged.join('\n')).not.toContain('fallback-key')
  })

  it('all endpoints drop the tx: reports not-on-chain after the extra round', async () => {
    const primary = endpointSpy({ hasReceipt: async () => false })
    const fallback = endpointSpy({ hasReceipt: async () => false })
    const stub = neverDone()

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: { primary: primary.endpoint, fallbacks: [fallback.endpoint] },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('not-on-chain')
    expect(fallback.sent).toEqual([RAW])
    expect(stub.calls()).toBe(FAST_POLL.attempts * 2)
    expect(primary.receiptLookups).toBe(1)
    expect(fallback.receiptLookups).toBe(1)
  })

  it('stays unconfirmed (not not-on-chain) when any endpoint has a receipt', async () => {
    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: {
        primary: endpointSpy({ hasReceipt: async () => false }).endpoint,
        fallbacks: [endpointSpy({ hasReceipt: async () => true }).endpoint],
      },
      isOperationDone: neverDone().isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('unconfirmed')
  })

  it('stays unconfirmed when a receipt lookup fails, since absence is unproven', async () => {
    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: {
        primary: endpointSpy({ hasReceipt: async () => false }).endpoint,
        fallbacks: [
          endpointSpy({
            hasReceipt: async () => {
              throw new Error('rpc down')
            },
          }).endpoint,
        ],
      },
      isOperationDone: neverDone().isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('unconfirmed')
  })

  it('no fallbacks configured: no re-send and no extra poll round', async () => {
    const primary = endpointSpy({ hasReceipt: async () => true })
    const stub = neverDone()

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: { primary: primary.endpoint, fallbacks: [] },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('unconfirmed')
    expect(primary.sent).toEqual([])
    expect(stub.calls()).toBe(FAST_POLL.attempts)
  })

  it('no fallbacks configured: still names a tx the primary never mined', async () => {
    const stub = neverDone()

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      endpoints: {
        primary: endpointSpy({ hasReceipt: async () => false }).endpoint,
        fallbacks: [],
      },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('not-on-chain')
    expect(stub.calls()).toBe(FAST_POLL.attempts)
  })

  it('without signed bytes (e.g. a non-local signer) skips the re-send and the extra round', async () => {
    const fallback = endpointSpy({})
    const stub = neverDone()

    await confirmWithRebroadcast({
      hash: HASH,
      endpoints: { fallbacks: [fallback.endpoint] },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(fallback.sent).toEqual([])
    expect(stub.calls()).toBe(FAST_POLL.attempts)
  })

  it('without endpoints (e.g. Tron) behaves exactly like confirmTimelockExecution', async () => {
    const stub = neverDone()

    const outcome = await confirmWithRebroadcast({
      hash: HASH,
      rawTransaction: RAW,
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(outcome).toBe('unconfirmed')
    expect(stub.calls()).toBe(FAST_POLL.attempts)
  })
})

function chainWith(urls: string[]): Chain {
  return defineChain({
    id: 1,
    name: 'testchain',
    nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
    rpcUrls: { default: { http: urls as [string, ...string[]] } },
  })
}

interface IRpcCall {
  url: string
  method: string
  params: unknown[]
}

describe('buildChainEndpoints', () => {
  const originalFetch = globalThis.fetch
  let calls: IRpcCall[] = []
  let respond: (call: IRpcCall) => unknown = () => null

  beforeEach(() => {
    calls = []
    respond = () => null
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number
        method: string
        params: unknown[]
      }
      const call = {
        url: String(input instanceof Request ? input.url : input),
        method: body.method,
        params: body.params,
      }
      calls.push(call)
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: respond(call),
      })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('splits the chain endpoints into the primary and the fallbacks', () => {
    const endpoints = buildChainEndpoints(
      chainWith([PRIMARY_URL, FALLBACK_URL])
    )

    expect(endpoints.primary).toBeDefined()
    expect(endpoints.fallbacks).toHaveLength(1)
  })

  it('has no fallbacks for a single-endpoint chain', () => {
    const endpoints = buildChainEndpoints(chainWith([PRIMARY_URL]))

    expect(endpoints.primary).toBeDefined()
    expect(endpoints.fallbacks).toEqual([])
  })

  it('skips an unusable fallback without promoting it to primary', () => {
    const endpoints = buildChainEndpoints(
      chainWith([
        PRIMARY_URL,
        'http://user:pass@insecure.example',
        FALLBACK_URL,
      ])
    )

    expect(endpoints.primary).toBeDefined()
    expect(endpoints.fallbacks).toHaveLength(1)
  })

  it('leaves the primary unset when the primary endpoint is unusable', () => {
    const endpoints = buildChainEndpoints(
      chainWith(['http://user:pass@insecure.example', FALLBACK_URL])
    )

    expect(endpoints.primary).toBeUndefined()
    expect(endpoints.fallbacks).toHaveLength(1)
  })

  it('sends the raw tx to that fallback endpoint alone', async () => {
    respond = () => HASH
    const { fallbacks } = buildChainEndpoints(
      chainWith([PRIMARY_URL, FALLBACK_URL])
    )

    const hash = await (fallbacks[0] as IRpcEndpoint).sendRawTransaction(RAW)

    expect(hash).toBe(HASH)
    expect(calls).toEqual([
      { url: FALLBACK_URL, method: 'eth_sendRawTransaction', params: [RAW] },
    ])
  })

  it('reads a null receipt as absent and a receipt as present', async () => {
    const { primary } = buildChainEndpoints(chainWith([PRIMARY_URL]))
    const endpoint = primary as IRpcEndpoint

    respond = () => null
    expect(await endpoint.hasReceipt(HASH)).toBe(false)

    respond = () => ({
      transactionHash: HASH,
      blockHash: HASH,
      blockNumber: '0x1',
      status: '0x1',
      logs: [],
    })
    expect(await endpoint.hasReceipt(HASH)).toBe(true)
    expect(calls.map((c) => c.method)).toEqual([
      'eth_getTransactionReceipt',
      'eth_getTransactionReceipt',
    ])
  })
})

describe('createExecutorRpc', () => {
  it('reads through the fallback transport when fallbacks are configured', () => {
    const { publicClient, endpoints } = createExecutorRpc(
      chainWith([PRIMARY_URL, FALLBACK_URL]),
      'mainnet'
    )

    expect(publicClient.transport.type).toBe('fallback')
    expect(endpoints.fallbacks).toHaveLength(1)
  })

  it('uses only the override endpoint when one is given', () => {
    const { publicClient, endpoints } = createExecutorRpc(
      chainWith([PRIMARY_URL, FALLBACK_URL]),
      'mainnet',
      'https://override.example/key'
    )

    expect(publicClient.transport.type).toBe('http')
    expect(endpoints.primary).toBeDefined()
    expect(endpoints.fallbacks).toEqual([])
  })

  it('reads through a plain http transport on a single-endpoint chain', () => {
    const { publicClient } = createExecutorRpc(
      chainWith([PRIMARY_URL]),
      'mainnet'
    )

    expect(publicClient.transport.type).toBe('http')
  })
})

// `execute-pending-timelock-tx.ts` calls `runMain` at module scope, so its use
// of this module is asserted on the source.
describe('executor wiring', () => {
  const executor = readFileSync(
    join(import.meta.dir, 'execute-pending-timelock-tx.ts'),
    'utf8'
  )

  it('reads through createExecutorRpc, not the primary-only setupEnvironment client', () => {
    expect(executor).toContain('createExecutorRpc(')
    expect(executor).not.toMatch(
      /const \{[^}]*publicClient[^}]*\} = await setupEnvironment\(/
    )
  })

  it('confirms executions through confirmWithRebroadcast, passing the signed bytes', () => {
    expect(executor).toContain('confirmWithRebroadcast({')
    expect(executor).toContain('rawTransaction: result.rawTransaction')
    expect(executor).not.toContain('confirmTimelockExecution(')
  })

  it('leaves a not-on-chain op queued: the branch returns before the executed write', () => {
    const branch = executor.indexOf("if (confirmation === 'not-on-chain')")
    expect(branch).toBeGreaterThan(-1)
    const body = executor.slice(
      branch,
      executor.indexOf("status: 'executed'", branch)
    )
    const ret = body.indexOf("return 'not-on-chain'")
    expect(ret).toBeGreaterThan(-1)
    expect(ret).toBeLessThan(
      body.indexOf("if (confirmation === 'unconfirmed')")
    )
    expect(body.slice(0, ret)).not.toContain('updateOne')
  })

  it('reports not-on-chain to the run summary as its own count', () => {
    expect(executor).toContain('operationsNotOnChain++')
    expect(executor).toMatch(/return \{[^}]*operationsNotOnChain,[^}]*\}/)
  })
})
