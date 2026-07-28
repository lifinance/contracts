/**
 * Tests for ConfirmSafeTxPrefetchQueue (EXSC-712).
 *
 * The queue is exercised through an injected `prepare` function — the real
 * `prepareConfirmSafeTxNetwork` needs a live RPC/Mongo environment, and the
 * queue's own behavior (dedup, consume-on-take, fallback, error swallowing)
 * is independent of it.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  ConfirmSafeTxPrefetchQueue,
  type IConfirmSafeTxNetworkContext,
  type IPrepareConfirmSafeTxNetworkParams,
} from './confirm-safe-tx-prefetch'

type PrepareFn = (
  params: IPrepareConfirmSafeTxNetworkParams
) => Promise<IConfirmSafeTxNetworkContext | null>

const DUMMY_PARAMS = {
  pendingTxs: [],
  pendingTransactions: undefined,
  startupReconciledKeys: new Set<string>(),
} as unknown as Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>

function fakeContext(network: string): IConfirmSafeTxNetworkContext {
  return { network } as unknown as IConfirmSafeTxNetworkContext
}

function makePrepare(
  impl?: (
    params: IPrepareConfirmSafeTxNetworkParams
  ) => Promise<IConfirmSafeTxNetworkContext | null>
) {
  const calls: string[] = []
  const prepare: PrepareFn = async (params) => {
    calls.push(params.network)
    if (impl) return impl(params)
    return fakeContext(params.network)
  }
  return { prepare, calls }
}

describe('ConfirmSafeTxPrefetchQueue', () => {
  it('schedule() starts preparation once and dedups same-network schedules', async () => {
    const { prepare, calls } = makePrepare()
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('arbitrum', DUMMY_PARAMS)
    queue.schedule('arbitrum', DUMMY_PARAMS)
    queue.schedule('ARBITRUM', DUMMY_PARAMS) // case-insensitive key

    const ctx = await queue.take('arbitrum', DUMMY_PARAMS)
    expect(ctx?.network).toBe('arbitrum')
    expect(calls).toEqual(['arbitrum'])
  })

  it('take() consumes the in-flight entry — a second take prepares fresh', async () => {
    const { prepare, calls } = makePrepare()
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('base', DUMMY_PARAMS)
    await queue.take('base', DUMMY_PARAMS)
    await queue.take('base', DUMMY_PARAMS)

    expect(calls).toEqual(['base', 'base'])
  })

  it('take() without a prior schedule prepares directly', async () => {
    const { prepare, calls } = makePrepare()
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    const ctx = await queue.take('mainnet', DUMMY_PARAMS)
    expect(ctx?.network).toBe('mainnet')
    expect(calls).toEqual(['mainnet'])
  })

  it('a scheduled preparation error surfaces as null from take(), not a throw', async () => {
    const { prepare } = makePrepare(async () => {
      throw new Error('RPC exploded')
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('optimism', DUMMY_PARAMS)
    const ctx = await queue.take('optimism', DUMMY_PARAMS)
    expect(ctx).toBeNull()
  })

  it('a direct take() preparation error surfaces as null, not a throw', async () => {
    const { prepare } = makePrepare(async () => {
      throw new Error('Mongo exploded')
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    const ctx = await queue.take('polygon', DUMMY_PARAMS)
    expect(ctx).toBeNull()
  })

  it('take() passes through a null preparation result (nothing actionable)', async () => {
    const { prepare } = makePrepare(async () => null)
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('bsc', DUMMY_PARAMS)
    expect(await queue.take('bsc', DUMMY_PARAMS)).toBeNull()
  })

  it('parallel schedules for different networks run independently', async () => {
    const { prepare, calls } = makePrepare()
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('arbitrum', DUMMY_PARAMS)
    queue.schedule('base', DUMMY_PARAMS)

    const [a, b] = await Promise.all([
      queue.take('arbitrum', DUMMY_PARAMS),
      queue.take('base', DUMMY_PARAMS),
    ])
    expect(a?.network).toBe('arbitrum')
    expect(b?.network).toBe('base')
    expect(calls.sort()).toEqual(['arbitrum', 'base'])
  })
})
