/**
 * The A0.6 bar on `troncast send`: with energy estimation unusable, the
 * broadcast is provably never reached. Asserted on a spy over
 * `sendRawTransaction` / `.send()` rather than only on the thrown error, and
 * paired with a positive case per path — a guard that refuses everything also
 * makes every negative assertion pass.
 *
 * Runs the command's real `run` body against a fake TronWeb, so what is under
 * test is where the guard sits in the live path, not a copy of the decision.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'

import * as troncastTronWeb from '../utils/tronweb'

/** Obviously fake, and built rather than written so it is not a key-shaped literal. */
const FAKE_KEY = '11'.repeat(32)
const SENDER = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'
const CONTRACT = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
/** `.invalid` never resolves, so a stray request cannot reach a real node. */
const RPC_URL = 'https://tron.invalid'

/** 100 SUN per energy: 1e9 SUN (the 1000 TRX default) buys 10,000,000 energy. */
const SUN_PER_ENERGY = 100
const ENERGY_PRICES = `1:${SUN_PER_ENERGY}`

/** Every node interaction the command performs, in order. */
let hits: string[] = []
/** `null` makes the node answer as it does for a call that would revert. */
let energyUsed: number | null = 20_000
let energyPrices = ENERGY_PRICES

const fakeTransaction = { txID: 'aa', raw_data: {} }

class FakeTronWeb {
  public fullNode = {
    host: RPC_URL,
    request: async (path: string): Promise<unknown> => {
      hits.push(path)
      return { result: { result: true }, transaction: fakeTransaction }
    },
  }

  public trx = {
    sign: async (transaction: unknown): Promise<unknown> => transaction,
    sendRawTransaction: async (): Promise<unknown> => {
      hits.push('broadcast')
      return { result: true, txid: 'deadbeef' }
    },
    getEnergyPrices: async (): Promise<string> => energyPrices,
    getTransactionInfo: async (): Promise<unknown> => ({ id: 'deadbeef' }),
  }

  public address = {
    fromPrivateKey: (): string => SENDER,
    toHex: (value: string): string => `41${value}`,
  }

  public transactionBuilder = {
    sendTrx: async (): Promise<unknown> => fakeTransaction,
    triggerConstantContract: async (): Promise<unknown> => {
      hits.push('estimate-selector')
      return energyUsed === null
        ? { result: { result: false, message: 'REVERT' } }
        : { result: { result: true }, energy_used: energyUsed }
    },
  }

  public toSun = (trx: number): string => String(Math.round(trx * 1_000_000))

  public contract = (): unknown => ({
    at: async (): Promise<unknown> => ({
      pause: () => ({
        send: async (): Promise<string> => {
          hits.push('broadcast')
          return 'deadbeef'
        },
      }),
    }),
  })

  public setAddress = (): void => undefined
}

// Only the client factory is replaced, and only for this specifier. Mocking the
// `tronweb` package instead reaches the whole registry — a fake class without
// the address codec then breaks unrelated Tron suites in the same run. Nothing
// else in `script/` that a test loads calls `initTronWeb`; if that changes, this
// file needs the same treatment `healthCheckInvariants.tron.test.ts` documents.
mock.module('../utils/tronweb', () => ({
  ...troncastTronWeb,
  initTronWeb: (): unknown => new FakeTronWeb(),
}))

const { sendCommand } = await import('./send')

/** Answers the raw-calldata estimate; every other URL is a test bug. */
const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url)
  if (!target.includes('/wallet/triggerconstantcontract'))
    throw new Error(`unexpected fetch to ${target}`)

  hits.push('estimate-calldata')
  return new Response(
    JSON.stringify(
      energyUsed === null
        ? { result: { result: false, message: 'REVERT' } }
        : { result: { result: true }, energy_used: energyUsed }
    ),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

const baseArgs = {
  address: CONTRACT,
  env: 'mainnet',
  privateKey: FAKE_KEY,
  feeLimit: '1000',
  confirm: false,
  dryRun: false,
  json: false,
  rpcUrl: RPC_URL,
}

interface IRun {
  exitCode: number | undefined
  errors: string[]
}

/** Runs the command and collects what an operator would see. */
const run = async (args: Record<string, unknown>): Promise<IRun> => {
  const errors: string[] = []
  let exitCode: number | undefined

  const exit = spyOn(process, 'exit').mockImplementation(((
    code?: number
  ): never => {
    exitCode = code
    return undefined as never
  }) as never)
  const error = spyOn(consola, 'error').mockImplementation(((
    ...parts: unknown[]
  ): void => {
    errors.push(parts.map(String).join(' '))
  }) as unknown as typeof consola.error)

  try {
    // citty's own arg defaults are bypassed on purpose: the object here is the
    // full arg set, so nothing under test depends on a default being applied.
    await sendCommand.run?.({
      args: { ...baseArgs, ...args },
      rawArgs: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  } finally {
    exit.mockRestore()
    error.mockRestore()
  }

  return { exitCode, errors }
}

let originalFetch: typeof globalThis.fetch
let originalAllow: string | undefined

beforeEach(() => {
  hits = []
  energyUsed = 20_000
  energyPrices = ENERGY_PRICES
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
})

describe('the raw-calldata path', () => {
  it('broadcasts when the estimate fits the fee limit', async () => {
    const { exitCode } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('estimate-calldata')
    expect(hits).toContain('broadcast')
  })

  it('never reaches the broadcast when estimation fails', async () => {
    energyUsed = null

    const { exitCode, errors } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBe(1)
    expect(hits).toContain('estimate-calldata')
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('refusing to broadcast')
    expect(errors.join('\n')).toContain('on tron')
    expect(errors.join('\n')).toContain('raw calldata')
  })

  it('never reaches the broadcast when the estimate exceeds the fee limit', async () => {
    // 1 TRX buys 10,000 energy at 100 SUN each; the margin puts this over it.
    const { exitCode, errors } = await run({
      calldata: '0xdeadbeef',
      feeLimit: '1',
    })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('exceeds the fee limit')
    expect(errors.join('\n')).toContain('--feeLimit')
  })

  it('never reaches the broadcast when the energy price is unreadable', async () => {
    energyPrices = ''

    const { exitCode, errors } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('Could not price')
  })

  it('broadcasts on a failed estimate when the escape hatch names the network', async () => {
    energyUsed = null
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    const { exitCode } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('broadcast')
  })
})

describe('the function-signature path', () => {
  it('broadcasts when the estimate fits the fee limit', async () => {
    const { exitCode } = await run({ signature: 'pause()' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('estimate-selector')
    expect(hits).toContain('broadcast')
  })

  it('never reaches the broadcast when estimation fails', async () => {
    energyUsed = null

    const { exitCode, errors } = await run({ signature: 'pause()' })

    expect(exitCode).toBe(1)
    expect(hits).toContain('estimate-selector')
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('refusing to broadcast')
    expect(errors.join('\n')).toContain('pause()')
  })

  it('never reaches the broadcast when the estimate exceeds the fee limit', async () => {
    const { exitCode, errors } = await run({
      signature: 'pause()',
      feeLimit: '1',
    })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('exceeds the fee limit')
  })
})

describe('a native TRX transfer', () => {
  it('broadcasts without an energy estimate, because it consumes none', async () => {
    const { exitCode } = await run({ value: '1tron' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('broadcast')
    expect(hits).not.toContain('estimate-calldata')
    expect(hits).not.toContain('estimate-selector')
  })
})
