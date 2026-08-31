/**
 * Proves the refuse-to-broadcast guard at the level that matters: with gas
 * estimation forced to fail, neither EVM path reaches its write method. The
 * unit tests in `gas-with-fallback.test.ts` cover the predicate; these cover
 * the consequence.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Account, Address, PublicClient, WalletClient } from 'viem'

import type { IChainExecutionParams } from '../../../common/types'

import { EvmChainCaller } from './evm-caller'
import { EvmChainExecutor } from './evm-executor'

const SAFE: Address = '0xa5A5A5a5a5a5A5a5A5A5a5a5A5A5a5a5a5A5A5a5'
const TARGET: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const ACCOUNT = { address: TARGET, type: 'json-rpc' } as unknown as Account

const ESTIMATE_FAILURE = 'execution reverted: GS013'

const EXEC_PARAMS: IChainExecutionParams = {
  safeAddress: SAFE,
  to: TARGET,
  value: 0n,
  data: '0x',
  operation: 0,
  signatures: '0x',
}

interface ISpy {
  writeContractCalls: number
  sendTransactionCalls: number
  lastGas?: bigint
}

const buildClients = (
  spy: ISpy
): { publicClient: PublicClient; walletClient: WalletClient } => ({
  publicClient: {
    estimateContractGas: async () => {
      throw new Error(ESTIMATE_FAILURE)
    },
    estimateGas: async () => {
      throw new Error(ESTIMATE_FAILURE)
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  } as unknown as PublicClient,
  walletClient: {
    writeContract: async (args: { gas?: bigint }) => {
      spy.writeContractCalls += 1
      spy.lastGas = args.gas
      return '0xdead' as const
    },
    sendTransaction: async (args: { gas?: bigint }) => {
      spy.sendTransactionCalls += 1
      spy.lastGas = args.gas
      return '0xdead' as const
    },
  } as unknown as WalletClient,
})

async function captureRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a refusal, but the call resolved')
}

describe('refuse to broadcast when gas estimation fails', () => {
  let originalAllow: string | undefined
  let spy: ISpy

  beforeEach(() => {
    originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    spy = { writeContractCalls: 0, sendTransactionCalls: 0 }
  })

  afterEach(() => {
    if (originalAllow === undefined)
      delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
  })

  it('EvmChainExecutor.executeTransaction never calls writeContract', async () => {
    const { publicClient, walletClient } = buildClients(spy)
    const executor = new EvmChainExecutor(
      walletClient,
      publicClient,
      ACCOUNT,
      'jovay'
    )

    const message = await captureRejection(
      executor.executeTransaction(EXEC_PARAMS)
    )

    expect(spy.writeContractCalls).toBe(0)
    expect(message).toMatch(/refusing to broadcast/i)
    expect(message).toMatch(/jovay/)
    expect(message).toMatch(/Safe execTransaction/)
    expect(message).toMatch(/GS013/)
  })

  it('EvmChainCaller.call never calls sendTransaction', async () => {
    const { publicClient, walletClient } = buildClients(spy)
    const caller = new EvmChainCaller(
      walletClient,
      publicClient,
      ACCOUNT,
      'jovay'
    )

    const message = await captureRejection(
      caller.call({ to: TARGET, data: '0x', value: 0n })
    )

    expect(spy.sendTransactionCalls).toBe(0)
    expect(message).toMatch(/refusing to broadcast/i)
    expect(message).toMatch(/contract call/)
  })

  it('EvmChainCaller.simulate still reports a figure — it broadcasts nothing', async () => {
    const { publicClient, walletClient } = buildClients(spy)
    const caller = new EvmChainCaller(
      walletClient,
      publicClient,
      ACCOUNT,
      'jovay'
    )

    const result = await caller.simulate({ to: TARGET, data: '0x', value: 0n })

    expect(result.estimatedResource).toBe(500_000n)
    expect(result.resourceLabel).toBe('gas')
    expect(spy.sendTransactionCalls).toBe(0)
    expect(spy.writeContractCalls).toBe(0)
  })

  it('the escape hatch lets the executor broadcast, deliberately', async () => {
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'true'
    const { publicClient, walletClient } = buildClients(spy)
    const executor = new EvmChainExecutor(
      walletClient,
      publicClient,
      ACCOUNT,
      'jovay'
    )

    await executor.executeTransaction(EXEC_PARAMS)

    expect(spy.writeContractCalls).toBe(1)
    // Asserting the value too: broadcasting with gas=undefined would make viem
    // re-estimate internally and throw, which is a different failure wearing
    // the same green test.
    expect(spy.lastGas).toBe(500_000n)
  })
})
