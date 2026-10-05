/**
 * Covers how `EvmChainCaller.call` broadcasts: a local signer's bytes are kept, and re-sent to
 * every configured endpoint when the primary never produces a receipt.
 */

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
import type {
  Account,
  Address,
  Hash,
  Hex,
  PublicClient,
  WalletClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { EvmChainCaller } from './evm-caller'

const TARGET: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const SIGNED: Hex = '0x02f8aa01'
const HASH: Hash = `0x${'ab'.repeat(32)}`
const FALLBACK_URL = 'https://fallback.example/'

interface ISpy {
  rawSent: Hex[]
  sendTransactionCalls: number
}

const receiptJson = (status: '0x1' | '0x0') => ({
  blockHash: `0x${'11'.repeat(32)}`,
  blockNumber: '0x10',
  contractAddress: null,
  cumulativeGasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  from: `0x${'22'.repeat(20)}`,
  gasUsed: '0x5208',
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  status,
  to: TARGET,
  transactionHash: HASH,
  transactionIndex: '0x0',
  type: '0x2',
})

const buildCaller = (
  spy: ISpy,
  opts: { account: Account; primaryReceipt: boolean }
): EvmChainCaller => {
  const publicClient = {
    estimateGas: async () => 21_000n,
    waitForTransactionReceipt: async () => {
      if (opts.primaryReceipt) return { status: 'success', gasUsed: 21_000n }
      throw new Error('Confirmation timeout')
    },
  } as unknown as PublicClient
  const walletClient = {
    chain: { id: 1868, rpcUrls: { default: { http: [FALLBACK_URL] } } },
    prepareTransactionRequest: async (request: object) => ({
      ...request,
      nonce: 7,
    }),
    signTransaction: async () => SIGNED,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex
    }) => {
      spy.rawSent.push(serializedTransaction)
      return HASH
    },
    sendTransaction: async () => {
      spy.sendTransactionCalls += 1
      return HASH
    },
  } as unknown as WalletClient
  return new EvmChainCaller(walletClient, publicClient, opts.account)
}

describe('EvmChainCaller.call', () => {
  const originalFetch = globalThis.fetch
  const localAccount = privateKeyToAccount(generatePrivateKey())
  const jsonRpcAccount = {
    address: TARGET,
    type: 'json-rpc',
  } as unknown as Account
  let spy: ISpy
  let fallbackSends: Hex[]
  let fallbackStatus: '0x1' | '0x0'
  let silenced: ReturnType<typeof spyOn>[]

  beforeEach(() => {
    spy = { rawSent: [], sendTransactionCalls: 0 }
    fallbackSends = []
    fallbackStatus = '0x1'
    silenced = [
      spyOn(consola, 'info').mockImplementation(
        (() => undefined) as unknown as typeof consola.info
      ),
      spyOn(consola, 'warn').mockImplementation(
        (() => undefined) as unknown as typeof consola.warn
      ),
    ]
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number
        method: string
        params: unknown[]
      }
      if (body.method === 'eth_sendRawTransaction')
        fallbackSends.push(body.params[0] as Hex)
      const results: Record<string, unknown> = {
        eth_sendRawTransaction: HASH,
        eth_blockNumber: '0x10',
        eth_getTransactionReceipt: receiptJson(fallbackStatus),
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
    for (const s of silenced) s.mockRestore()
  })

  it('signs locally and sends the raw bytes when the account is local', async () => {
    const caller = buildCaller(spy, {
      account: localAccount,
      primaryReceipt: true,
    })

    const result = await caller.call({ to: TARGET, data: '0x' })

    expect(result.hash).toBe(HASH)
    expect(result.receipt?.status).toBe('success')
    expect(spy.rawSent).toEqual([SIGNED])
    expect(spy.sendTransactionCalls).toBe(0)
    expect(fallbackSends).toEqual([])
  })

  it('re-sends the same bytes to the configured endpoints when the primary gives no receipt', async () => {
    const caller = buildCaller(spy, {
      account: localAccount,
      primaryReceipt: false,
    })

    const result = await caller.call({ to: TARGET, data: '0x' })

    expect(fallbackSends).toEqual([SIGNED])
    expect(result.receipt?.status).toBe('success')
    expect(result.gasUsed).toBe(21_000n)
  })

  it('reports a revert seen only by a fallback endpoint', async () => {
    fallbackStatus = '0x0'
    const caller = buildCaller(spy, {
      account: localAccount,
      primaryReceipt: false,
    })

    let message = ''
    try {
      await caller.call({ to: TARGET, data: '0x' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('Transaction failed with status: reverted')
  })

  it('keeps the remote-signer path and returns the hash alone on timeout', async () => {
    const caller = buildCaller(spy, {
      account: jsonRpcAccount,
      primaryReceipt: false,
    })

    const result = await caller.call({ to: TARGET, data: '0x' })

    expect(spy.sendTransactionCalls).toBe(1)
    expect(spy.rawSent).toEqual([])
    expect(fallbackSends).toEqual([])
    expect(result).toEqual({ hash: HASH, explorerUrl: undefined })
  })
})
