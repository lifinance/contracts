/**
 * The A0.6 bar on the Tron path: with estimation unusable, the send is provably
 * never reached. Asserted with a spy on the broadcast rather than only on the
 * thrown error — an error proves something failed, not that nothing was sent.
 */

import type { TronWalletClient } from '@lifi/tron-devkit'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Address, Hex } from 'viem'

import type { IChainExecutionParams } from '../../../common/types'

import { TronChainCaller } from './tron-caller'
import { TronChainExecutor } from './tron-executor'

/** Obviously fake, and built rather than written so it is not a key-shaped literal. */
const FAKE_KEY = `0x${'11'.repeat(32)}`

const TO = '0x1111111111111111111111111111111111111111' as Address
const SAFE = '0x2222222222222222222222222222222222222222' as Address
const DATA = '0xdeadbeef' as Hex

/** 100 SUN per energy, so 500_000 energy is exactly the 50 TRX default limit. */
const costInSun = async (energy: bigint): Promise<bigint> => energy * 100n

const failingEstimate = async (): Promise<bigint> => {
  throw new Error('triggerconstantcontract failed: 503 Service Unavailable')
}

interface ISpy {
  broadcasts: number
  executions: number
}

const execution: IChainExecutionParams = {
  safeAddress: SAFE,
  to: TO,
  value: 0n,
  data: DATA,
  operation: 0,
  signatures: '0x' as Hex,
}

let spy: ISpy
let originalAllow: string | undefined
let originalLimit: string | undefined

beforeEach(() => {
  spy = { broadcasts: 0, executions: 0 }
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  originalLimit = process.env.TRON_SAFE_EXEC_FEE_LIMIT_SUN
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  // Pinned, not read: the repo's .env is symlinked into every worktree and bun
  // loads it into the test process, so an inherited value would move the
  // threshold these cases are built around.
  process.env.TRON_SAFE_EXEC_FEE_LIMIT_SUN = '50000000'
})

afterEach(() => {
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
  if (originalLimit === undefined)
    delete process.env.TRON_SAFE_EXEC_FEE_LIMIT_SUN
  else process.env.TRON_SAFE_EXEC_FEE_LIMIT_SUN = originalLimit
})

const callerWith = (estimateEnergy: () => Promise<bigint>): TronChainCaller =>
  new TronChainCaller('tron', FAKE_KEY, {
    broadcast: async () => {
      spy.broadcasts += 1
      return { txId: 'deadbeef', hash: '0xdeadbeef' as Hex }
    },
    estimateEnergy,
    costInSun,
  })

const executorWith = (
  estimateEnergy: () => Promise<bigint>
): TronChainExecutor => {
  const client = {
    executeSafeExecTransaction: async () => {
      spy.executions += 1
      return { txId: 'deadbeef', hash: '0xdeadbeef' as Hex }
    },
    getTronWeb: () => {
      throw new Error('getTronWeb must not be reached in these cases')
    },
  } as unknown as TronWalletClient

  return new TronChainExecutor(client, 'tron', { estimateEnergy, costInSun })
}

describe('TronChainCaller.call', () => {
  it('never broadcasts when the estimate fails', async () => {
    const error = await callerWith(failingEstimate)
      .call({ to: TO, data: DATA, value: 0n })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      )

    expect(error?.message).toMatch(/refusing to broadcast/)

    expect(spy.broadcasts).toBe(0)
  })

  it('never broadcasts when the estimate exceeds the fee limit', async () => {
    // 600k energy is 60 TRX against a 50 TRX cap. This is the case that
    // previously broadcast, ran out of energy part-way and was retried forever.
    const error = await callerWith(async () => 600_000n)
      .call({ to: TO, data: DATA, value: 0n })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      )

    expect(error?.message).toMatch(/exceeds the fee limit/)

    expect(spy.broadcasts).toBe(0)
  })

  it('broadcasts when the estimate fits', async () => {
    await callerWith(async () => 400_000n).call({
      to: TO,
      data: DATA,
      value: 0n,
    })

    expect(spy.broadcasts).toBe(1)
  })

  it('broadcasts on a failed estimate only when the hatch names this network', async () => {
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    await callerWith(failingEstimate).call({ to: TO, data: DATA, value: 0n })

    expect(spy.broadcasts).toBe(1)
  })
})

describe('TronChainExecutor.executeTransaction', () => {
  it('never executes when the estimate fails', async () => {
    const error = await executorWith(failingEstimate)
      .executeTransaction(execution)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      )

    expect(error?.message).toMatch(/refusing to broadcast/)

    expect(spy.executions).toBe(0)
  })

  it('never executes when the estimate exceeds the fee limit', async () => {
    const error = await executorWith(async () => 600_000n)
      .executeTransaction(execution)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      )

    expect(error?.message).toMatch(/exceeds the fee limit/)

    expect(spy.executions).toBe(0)
  })

  it('prices the execTransaction calldata, not the inner call', async () => {
    // The estimate has to be of the Safe wrapper the devkit actually sends. If
    // it priced params.data instead, a batch whose wrapper is the expensive part
    // would pass the guard and still abort part-way.
    let seen: Hex | undefined
    const client = {
      executeSafeExecTransaction: async () => {
        spy.executions += 1
        return { txId: 'deadbeef', hash: '0xdeadbeef' as Hex }
      },
      getTronWeb: () => {
        throw new Error('not reached')
      },
    } as unknown as TronWalletClient

    const error = await new TronChainExecutor(client, 'tron', {
      estimateEnergy: async (calldata) => {
        seen = calldata
        return 600_000n
      },
      costInSun,
    })
      .executeTransaction(execution)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      )

    expect(error?.message).toMatch(/exceeds the fee limit/)

    expect(seen).not.toBe(DATA)
    // execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)
    expect(seen?.startsWith('0x6a761202')).toBe(true)
  })
})

describe('the executor still executes when the estimate fits', () => {
  it('broadcasts, so a guard that refused everything would fail here', async () => {
    // Without this, an executor that refuses every transaction passes the whole
    // suite: `spy.executions` was only ever asserted to be 0. That is the
    // direction that would block production execution on every Tron network,
    // so it is the one most worth pinning.
    const client = {
      executeSafeExecTransaction: async () => {
        spy.executions += 1
        return { txId: 'deadbeef', hash: '0xdeadbeef' as Hex }
      },
      getTronWeb: () => ({
        trx: {
          getTransactionInfo: async () => ({
            id: 'deadbeef',
            receipt: { result: 'SUCCESS' },
          }),
        },
      }),
    } as unknown as TronWalletClient

    const result = await new TronChainExecutor(client, 'tron', {
      estimateEnergy: async () => 400_000n,
      costInSun,
    }).executeTransaction(execution)

    expect(spy.executions).toBe(1)
    expect(result.status).toBe('success')
  })
})
