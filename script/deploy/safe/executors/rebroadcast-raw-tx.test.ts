import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'
import type { Hash, Hex, TransactionReceipt } from 'viem'

import {
  rebroadcastRawTransaction,
  type RebroadcastClient,
} from './rebroadcast-raw-tx'

const RAW: Hex = '0x02f8aa'
const HASH: Hash = `0x${'ab'.repeat(32)}`
const RECEIPT = { status: 'success' } as TransactionReceipt

interface IFakeEndpoint {
  sent: Hex[]
  sendError?: Error
  receipt?: TransactionReceipt
}

const fakeClient = (endpoint: IFakeEndpoint): RebroadcastClient =>
  ({
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex
    }) => {
      endpoint.sent.push(serializedTransaction)
      if (endpoint.sendError) throw endpoint.sendError
      return HASH
    },
    waitForTransactionReceipt: async () => {
      if (endpoint.receipt) return endpoint.receipt
      throw new Error('WaitForTransactionReceiptTimeoutError')
    },
  } as unknown as RebroadcastClient)

describe('rebroadcastRawTransaction', () => {
  let warn: ReturnType<typeof spyOn>
  let info: ReturnType<typeof spyOn>

  beforeEach(() => {
    warn = spyOn(consola, 'warn').mockImplementation(
      (() => undefined) as unknown as typeof consola.warn
    )
    info = spyOn(consola, 'info').mockImplementation(
      (() => undefined) as unknown as typeof consola.info
    )
  })

  afterEach(() => {
    warn.mockRestore()
    info.mockRestore()
  })

  it('re-sends the identical bytes to every distinct endpoint and returns the first receipt', async () => {
    const endpoints: Record<string, IFakeEndpoint> = {
      'https://primary.example': { sent: [] },
      'https://fallback-a.example': { sent: [], receipt: RECEIPT },
      'https://fallback-b.example': { sent: [] },
    }

    const result = await rebroadcastRawTransaction({
      serializedTransaction: RAW,
      hash: HASH,
      rpcUrls: [
        'https://primary.example',
        'https://fallback-a.example',
        'https://fallback-b.example',
        'https://primary.example',
      ],
      networkName: 'soneium',
      clientFor: (url) => fakeClient(endpoints[url] as IFakeEndpoint),
    })

    expect(result).toEqual({ accepted: 3, attempted: 3, receipt: RECEIPT })
    for (const endpoint of Object.values(endpoints))
      expect(endpoint.sent).toEqual([RAW])
  })

  it('counts rejected sends and never logs the endpoint that rejected', async () => {
    const leaky = 'https://rpc.example/v1/SECRETKEY'
    const endpoints: Record<string, IFakeEndpoint> = {
      [leaky]: {
        sent: [],
        sendError: new Error(`already known — request to ${leaky} failed`),
      },
      'https://fallback.example': { sent: [], receipt: RECEIPT },
    }

    const result = await rebroadcastRawTransaction({
      serializedTransaction: RAW,
      hash: HASH,
      rpcUrls: Object.keys(endpoints),
      clientFor: (url) => fakeClient(endpoints[url] as IFakeEndpoint),
    })

    expect(result.accepted).toBe(1)
    expect(result.attempted).toBe(2)
    expect(result.receipt).toBe(RECEIPT)
    const logged = [...warn.mock.calls, ...info.mock.calls].flat().join('\n')
    expect(logged).toContain('rejected the re-sent tx')
    expect(logged).not.toContain('SECRETKEY')
  })

  it('skips an endpoint no client can be built for', async () => {
    const good: IFakeEndpoint = { sent: [], receipt: RECEIPT }

    const result = await rebroadcastRawTransaction({
      serializedTransaction: RAW,
      hash: HASH,
      rpcUrls: [
        'http://user:SECRETPASS@insecure.example',
        'https://ok.example',
      ],
      clientFor: (url) => {
        if (url.startsWith('http://'))
          throw new Error(`cannot use ${url} without https`)
        return fakeClient(good)
      },
    })

    expect(result).toEqual({ accepted: 1, attempted: 1, receipt: RECEIPT })
    const logged = warn.mock.calls.flat().join('\n')
    expect(logged).toContain('skipping unusable RPC endpoint')
    expect(logged).not.toContain('SECRETPASS')
  })

  it('returns no receipt when no endpoint sees the transaction mined', async () => {
    const result = await rebroadcastRawTransaction({
      serializedTransaction: RAW,
      hash: HASH,
      rpcUrls: ['https://a.example', 'https://b.example'],
      clientFor: () => fakeClient({ sent: [] }),
    })

    expect(result).toEqual({ accepted: 2, attempted: 2 })
  })

  it('returns without waiting when no endpoint is usable', async () => {
    const result = await rebroadcastRawTransaction({
      serializedTransaction: RAW,
      hash: HASH,
      rpcUrls: ['https://a.example'],
      clientFor: () => {
        throw new Error('unusable')
      },
    })

    expect(result).toEqual({ accepted: 0, attempted: 0 })
  })

  describe('default client', () => {
    const originalFetch = globalThis.fetch
    let requests: { url: string; method: string; auth?: string }[]

    const receiptJson = {
      blockHash: `0x${'11'.repeat(32)}`,
      blockNumber: '0x10',
      contractAddress: null,
      cumulativeGasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      from: `0x${'22'.repeat(20)}`,
      gasUsed: '0x5208',
      logs: [],
      logsBloom: `0x${'00'.repeat(256)}`,
      status: '0x1',
      to: `0x${'33'.repeat(20)}`,
      transactionHash: HASH,
      transactionIndex: '0x0',
      type: '0x2',
    }

    beforeEach(() => {
      requests = []
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const url = String(input instanceof Request ? input.url : input)
        const body = JSON.parse(String(init?.body)) as {
          id: number
          method: string
        }
        const headers = new Headers(init?.headers)
        requests.push({
          url,
          method: body.method,
          auth: headers.get('authorization') ?? undefined,
        })
        const results: Record<string, unknown> = {
          eth_sendRawTransaction: HASH,
          eth_blockNumber: '0x10',
          eth_getTransactionReceipt: receiptJson,
          eth_getTransactionByHash: null,
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: results[body.method] ?? null,
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      }) as typeof fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('sends over http and moves embedded credentials into a header', async () => {
      const result = await rebroadcastRawTransaction({
        serializedTransaction: RAW,
        hash: HASH,
        rpcUrls: ['https://user:pass@rpc.example/'],
        timeoutMs: 5_000, // 5 seconds
      })

      expect(result.accepted).toBe(1)
      expect(result.receipt?.status).toBe('success')
      const send = requests.find((r) => r.method === 'eth_sendRawTransaction')
      expect(send?.url).toBe('https://rpc.example/')
      expect(send?.auth).toMatch(/^Basic /)
    })
  })
})
