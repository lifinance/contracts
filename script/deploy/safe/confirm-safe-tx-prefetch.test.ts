/**
 * Tests for ConfirmSafeTxPrefetchQueue (EXSC-712).
 *
 * The queue is exercised through an injected `prepare` function — the real
 * `prepareConfirmSafeTxNetwork` needs a live RPC/Mongo environment, and the
 * queue's own behavior (dedup, consume-on-take, error wrapping, nonce
 * re-validation) is independent of it.
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
  type PrepareConfirmSafeTxNetworkResult,
} from './confirm-safe-tx-prefetch'

type PrepareFn = (
  params: IPrepareConfirmSafeTxNetworkParams
) => Promise<PrepareConfirmSafeTxNetworkResult>

const DUMMY_PARAMS = {
  pendingTxs: [],
  pendingTransactions: undefined,
  startupReconciledKeys: new Set<string>(),
} as unknown as Omit<IPrepareConfirmSafeTxNetworkParams, 'network'>

/**
 * A `ready` result whose context reports `nonce` from `safe.getNonce()`. Later
 * re-reads can be made to differ from `onChainNonce` to exercise re-validation.
 */
function readyResult(
  network: string,
  onChainNonce = 1n,
  nonceReads: bigint[] = [onChainNonce]
): PrepareConfirmSafeTxNetworkResult {
  let call = 0
  const safe = {
    getNonce: async () => nonceReads[Math.min(call++, nonceReads.length - 1)],
  }
  return {
    kind: 'ready',
    context: {
      network,
      onChainNonce,
      safe,
    } as unknown as IConfirmSafeTxNetworkContext,
  }
}

function makePrepare(impl?: PrepareFn) {
  const calls: string[] = []
  const prepare: PrepareFn = async (params) => {
    calls.push(params.network)
    if (impl) return impl(params)
    return readyResult(params.network)
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

    const result = await queue.take('arbitrum', DUMMY_PARAMS)
    expect(result.kind).toBe('ready')
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

    const result = await queue.take('mainnet', DUMMY_PARAMS)
    expect(result.kind).toBe('ready')
    expect(calls).toEqual(['mainnet'])
  })

  it('a scheduled preparation throw surfaces as a prepare-error result, not a rejection', async () => {
    const { prepare } = makePrepare(async () => {
      throw new Error('RPC exploded')
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('optimism', DUMMY_PARAMS)
    const result = await queue.take('optimism', DUMMY_PARAMS)
    expect(result.kind).toBe('prepare-error')
    if (result.kind === 'prepare-error')
      expect(result.error).toBe('RPC exploded')
  })

  it('take() retries a transiently failed prefetch inline and returns the fresh result', async () => {
    // Prefetch-time prepare fails (transient RPC blip); the inline retry at
    // take() succeeds — the caller must see `ready`, not the stale error.
    const { prepare, calls } = makePrepare(async (params) => {
      if (calls.length === 1) throw new Error('transient RPC blip')
      return readyResult(params.network)
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('optimism', DUMMY_PARAMS)
    const result = await queue.take('optimism', DUMMY_PARAMS)

    expect(result.kind).toBe('ready')
    expect(calls).toEqual(['optimism', 'optimism'])
  })

  it('take() retries prefetched read-failed and owner-check-failed results inline', async () => {
    for (const kind of ['read-failed', 'owner-check-failed'] as const) {
      const { prepare, calls } = makePrepare(async (params) => {
        if (calls.length === 1) return { kind, error: 'stale failure' }
        return readyResult(params.network)
      })
      const queue = new ConfirmSafeTxPrefetchQueue(prepare)

      queue.schedule('base', DUMMY_PARAMS)
      const result = await queue.take('base', DUMMY_PARAMS)

      expect(result.kind).toBe('ready')
      expect(calls).toEqual(['base', 'base'])
    }
  })

  it('take() surfaces a persistent failure after the inline retry', async () => {
    const { prepare, calls } = makePrepare(async () => {
      throw new Error('RPC still down')
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('optimism', DUMMY_PARAMS)
    const result = await queue.take('optimism', DUMMY_PARAMS)

    expect(result.kind).toBe('prepare-error')
    if (result.kind === 'prepare-error')
      expect(result.error).toBe('RPC still down')
    expect(calls).toEqual(['optimism', 'optimism'])
  })

  it('take() passes through prefetched not-owner without a retry — ownership is stable', async () => {
    const { prepare, calls } = makePrepare(async () => ({
      kind: 'not-owner',
      signerAddress: '0x0000000000000000000000000000000000000001',
      owners: [],
    }))
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('base', DUMMY_PARAMS)
    const result = await queue.take('base', DUMMY_PARAMS)

    expect(result.kind).toBe('not-owner')
    expect(calls).toEqual(['base'])
  })

  it('a direct take() preparation throw surfaces as a prepare-error result', async () => {
    const { prepare } = makePrepare(async () => {
      throw new Error('Mongo exploded')
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    const result = await queue.take('polygon', DUMMY_PARAMS)
    expect(result.kind).toBe('prepare-error')
  })

  it('take() passes through a nothing-actionable result unchanged', async () => {
    const { prepare } = makePrepare(async () => ({
      kind: 'nothing-actionable',
    }))
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('bsc', DUMMY_PARAMS)
    expect((await queue.take('bsc', DUMMY_PARAMS)).kind).toBe(
      'nothing-actionable'
    )
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
    expect(a.kind).toBe('ready')
    expect(b.kind).toBe('ready')
    expect(calls.sort()).toEqual(['arbitrum', 'base'])
  })

  it('take() keeps a prefetched ready result when the nonce is unchanged', async () => {
    // getNonce is read at prepare (1n) and re-read at take (1n) — no re-prepare.
    const { prepare, calls } = makePrepare(async (params) =>
      readyResult(params.network, 1n, [1n])
    )
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('mainnet', DUMMY_PARAMS)
    const result = await queue.take('mainnet', DUMMY_PARAMS)

    expect(result.kind).toBe('ready')
    expect(calls).toEqual(['mainnet']) // no re-prepare
  })

  it('take() re-prepares a prefetched context whose nonce advanced since prefetch', async () => {
    // First prepare: onChainNonce 1n, but the take()-time re-read returns 2n
    // (another signer executed) → discard and re-prepare inline.
    const { prepare, calls } = makePrepare(async (params) => {
      if (calls.length === 1) return readyResult(params.network, 1n, [2n])
      return readyResult(params.network, 2n, [2n])
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('mainnet', DUMMY_PARAMS)
    const result = await queue.take('mainnet', DUMMY_PARAMS)

    expect(result.kind).toBe('ready')
    if (result.kind === 'ready') expect(result.context.onChainNonce).toBe(2n)
    expect(calls).toEqual(['mainnet', 'mainnet']) // re-prepared once
  })

  it('take() re-prepares when the nonce re-read fails — never trusts an unvalidated context', async () => {
    const { prepare, calls } = makePrepare(async (params) => {
      if (calls.length > 1) return readyResult(params.network, 1n)
      const result = readyResult(params.network, 1n)
      ;(result as { context: IConfirmSafeTxNetworkContext }).context.safe = {
        getNonce: async () => {
          throw new Error('nonce read failed')
        },
      } as unknown as IConfirmSafeTxNetworkContext['safe']
      return result
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    queue.schedule('mainnet', DUMMY_PARAMS)
    const result = await queue.take('mainnet', DUMMY_PARAMS)

    expect(result.kind).toBe('ready')
    expect(calls).toEqual(['mainnet', 'mainnet']) // re-prepared once
  })

  it('a nonce-advance re-prepare clears the startup reconcile coverage', async () => {
    // The advance proves another signer executed on this Safe — the re-prepare
    // must reconcile and refetch even for Safes the startup sweep covered.
    const seenCoverage: number[] = []
    const { prepare, calls } = makePrepare(async (params) => {
      seenCoverage.push(params.startupReconciledKeys.size)
      if (calls.length === 1) return readyResult(params.network, 1n, [2n])
      return readyResult(params.network, 2n, [2n])
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    const params = {
      ...DUMMY_PARAMS,
      startupReconciledKeys: new Set(['mainnet:1:0xsafe']),
    }
    queue.schedule('mainnet', params)
    const result = await queue.take('mainnet', params)

    expect(result.kind).toBe('ready')
    expect(seenCoverage).toEqual([1, 0]) // prefetch saw coverage, re-prepare did not
  })

  it('take() does not re-read the nonce on the inline (non-prefetch) path', async () => {
    let nonceReads = 0
    const { prepare } = makePrepare(async (params) => {
      const safe = {
        getNonce: async () => {
          nonceReads++
          return 1n
        },
      }
      return {
        kind: 'ready',
        context: {
          network: params.network,
          onChainNonce: 1n,
          safe,
        } as unknown as IConfirmSafeTxNetworkContext,
      }
    })
    const queue = new ConfirmSafeTxPrefetchQueue(prepare)

    await queue.take('mainnet', DUMMY_PARAMS) // no prior schedule
    expect(nonceReads).toBe(0)
  })
})
