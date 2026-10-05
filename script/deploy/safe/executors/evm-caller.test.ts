/**
 * Tests that `EvmChainCaller.call` keeps the signed bytes of what it broadcast
 * for a local account, so the timelock executor can re-send that exact
 * transaction when the primary RPC drops it.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Account, Address, Hex, PublicClient, WalletClient } from 'viem'

import { EvmChainCaller } from './evm-caller'

const TARGET: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const SIGNED: Hex = '0x02f8aa0102030405'
const HASH: Hex =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

interface ISpy {
  sendTransaction: number
  sendRawTransaction: Hex[]
  signedNonce?: number
}

function buildClients(
  spy: ISpy,
  receipt: () => Promise<unknown>
): { publicClient: PublicClient; walletClient: WalletClient } {
  return {
    publicClient: {
      estimateGas: async () => 100_000n,
      waitForTransactionReceipt: receipt,
    } as unknown as PublicClient,
    walletClient: {
      chain: null,
      prepareTransactionRequest: async (request: Record<string, unknown>) => ({
        ...request,
        nonce: 7,
      }),
      signTransaction: async (request: { nonce: number }) => {
        spy.signedNonce = request.nonce
        return SIGNED
      },
      sendRawTransaction: async (args: { serializedTransaction: Hex }) => {
        spy.sendRawTransaction.push(args.serializedTransaction)
        return HASH
      },
      sendTransaction: async () => {
        spy.sendTransaction += 1
        return HASH
      },
    } as unknown as WalletClient,
  }
}

const LOCAL = { address: TARGET, type: 'local' } as unknown as Account
const JSON_RPC = { address: TARGET, type: 'json-rpc' } as unknown as Account

describe('EvmChainCaller.call', () => {
  it('signs locally and returns the raw bytes it broadcast', async () => {
    const spy: ISpy = { sendTransaction: 0, sendRawTransaction: [] }
    const { publicClient, walletClient } = buildClients(spy, async () => ({
      status: 'success',
      gasUsed: 21_000n,
    }))

    const result = await new EvmChainCaller(
      walletClient,
      publicClient,
      LOCAL
    ).call({ to: TARGET, data: '0x' })

    expect(result.hash).toBe(HASH)
    expect(result.rawTransaction).toBe(SIGNED)
    expect(spy.sendRawTransaction).toEqual([SIGNED])
    expect(spy.signedNonce).toBe(7)
    expect(spy.sendTransaction).toBe(0)
  })

  it('still returns the raw bytes when the receipt wait times out', async () => {
    const spy: ISpy = { sendTransaction: 0, sendRawTransaction: [] }
    const { publicClient, walletClient } = buildClients(spy, async () => {
      throw new Error('Confirmation timeout')
    })

    const result = await new EvmChainCaller(
      walletClient,
      publicClient,
      LOCAL
    ).call({ to: TARGET, data: '0x' })

    expect(result.receipt).toBeUndefined()
    expect(result.rawTransaction).toBe(SIGNED)
  })

  it('leaves a non-local account on sendTransaction, with no raw bytes', async () => {
    const spy: ISpy = { sendTransaction: 0, sendRawTransaction: [] }
    const { publicClient, walletClient } = buildClients(spy, async () => ({
      status: 'success',
      gasUsed: 21_000n,
    }))

    const result = await new EvmChainCaller(
      walletClient,
      publicClient,
      JSON_RPC
    ).call({ to: TARGET, data: '0x' })

    expect(spy.sendTransaction).toBe(1)
    expect(spy.sendRawTransaction).toEqual([])
    expect(result.rawTransaction).toBeUndefined()
  })
})
