/**
 * `troncast send`, run through its real `run` body against a fake TronWeb, so
 * what is under test is where the guard sits in the live path rather than a
 * copy of the decision. Every case is a spy over `sendRawTransaction` /
 * `.send()`, since a thrown error alone does not show the broadcast was
 * skipped.
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
import { runCommand } from 'citty'
import { consola } from 'consola'
import { Contract, TronWeb } from 'tronweb'

import * as troncastTronWeb from '../utils/tronweb'

/**
 * Obviously fake, and built rather than written so it is not a key-shaped
 * literal. Not all digits: citty coerces a digits-only value to a number, and
 * the command's own key handling expects a string.
 */
const FAKE_KEY = 'ab'.repeat(32)
const SENDER = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'
const CONTRACT = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
/** The same contract in the `41…` form `isValidAddress` also accepts. */
const CONTRACT_HEX = `41${'9'.repeat(40)}`
/** `.invalid` never resolves, so a stray request cannot reach a real node. */
const RPC_URL = 'https://tron.invalid'

/** 100 SUN per energy: 1e9 SUN (the 1000 TRX default) buys 10,000,000 energy. */
const SUN_PER_ENERGY = 100
const ENERGY_PRICES = `1:${SUN_PER_ENERGY}`

/** Every node interaction the command performs, in order. */
let hits: string[] = []
/** `contract_address` as the calldata estimate posted it. */
let estimatedContract: string | undefined
/** The selector and arguments the signature-path estimate priced. */
let estimatedSelector: string | undefined
let estimatedParameters: { type: string; value: unknown }[] | undefined
/** The selector the broadcast is bound to, and the arguments it was handed. */
let broadcastSelector: string | undefined
let broadcastArgs: unknown[] | undefined
/** `null` makes the node answer as it does for a call that would revert. */
let energyUsed: number | null = 20_000
let energyPrices = ENERGY_PRICES
/** The endpoint the run resolves to; `--rpcUrl` sets it. */
let rpcHost = RPC_URL

/** An ABI function entry, as a Tron node or a forge artifact carries one. */
const abiFunction = (
  name: string,
  inputs: string[]
): Record<string, unknown> => ({
  type: 'function',
  name,
  inputs: inputs.map((type) => ({ type })),
  outputs: [],
  stateMutability: 'nonpayable',
})

/** What `contract().at()` resolves to. Reset per test. */
let contractAbi: Record<string, unknown>[] = [abiFunction('pause', [])]

/**
 * A real TronWeb contract wrapper over `contractAbi`, with each method's
 * `.send()` replaced by a spy.
 *
 * Real rather than hand-rolled because the selector the estimate must agree
 * with is the one TronWeb's own `Method` formats — through ethers, which
 * canonicalises the ABI's type spellings. A fake wrapper would be asserting a
 * second copy of exactly that canonicalisation. Nothing here reaches a node:
 * the wrapper is constructed, and the only callable path is the spy.
 */
const abiTronWeb = new TronWeb({ fullHost: RPC_URL })

const fakeContract = (): unknown => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapper = new Contract(abiTronWeb as any, contractAbi as any, CONTRACT)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const entry of Object.values(wrapper.methodInstances) as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wrapper as any)[entry.name] = (...args: unknown[]) => ({
      send: async (): Promise<string> => {
        hits.push('broadcast')
        broadcastSelector = entry.functionSelector
        broadcastArgs = args
        return 'deadbeef'
      },
    })
  }

  return wrapper
}

const fakeTransaction = { txID: 'aa', raw_data: {} }

class FakeTronWeb {
  public fullNode = {
    host: rpcHost,
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
    toHex: (value: string): string =>
      value === CONTRACT_HEX ? CONTRACT_HEX : `41${value}`,
    fromHex: (value: string): string =>
      value === CONTRACT_HEX ? CONTRACT : value.replace(/^41/, ''),
  }

  public transactionBuilder = {
    sendTrx: async (): Promise<unknown> => fakeTransaction,
    triggerConstantContract: async (
      _contractAddress: string,
      functionSelector: string,
      _options: Record<string, unknown>,
      parameters: { type: string; value: unknown }[]
    ): Promise<unknown> => {
      hits.push('estimate-selector')
      estimatedSelector = functionSelector
      estimatedParameters = parameters
      return energyUsed === null
        ? { result: { result: false, message: 'REVERT' } }
        : { result: { result: true }, energy_used: energyUsed }
    },
  }

  public toSun = (trx: number): string => String(Math.round(trx * 1_000_000))

  public contract = (): unknown => ({
    at: async (): Promise<unknown> => fakeContract(),
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
  initTronWeb: (_env: unknown, _key: unknown, rpcUrl?: string): unknown => {
    // The real factory resolves `--rpcUrl` into `fullNode.host`, which is the
    // endpoint the calldata estimate is pointed at.
    rpcHost = rpcUrl !== undefined && rpcUrl !== '' ? rpcUrl : RPC_URL
    return new FakeTronWeb()
  },
}))

const { sendCommand } = await import('./send')

/** Answers the raw-calldata estimate; every other URL is a test bug. */
const fakeFetch = async (
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const target = String(url)
  if (!target.includes('/wallet/triggerconstantcontract'))
    throw new Error(`unexpected fetch to ${target}`)

  hits.push('estimate-calldata')
  estimatedContract = (
    JSON.parse(String(init?.body ?? '{}')) as { contract_address?: string }
  ).contract_address
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

/** Runs an invocation and collects what an operator would see. */
const collect = async (invoke: () => Promise<unknown>): Promise<IRun> => {
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
    await invoke()
  } finally {
    exit.mockRestore()
    error.mockRestore()
  }

  return { exitCode, errors }
}

/** Runs the command body against an already-resolved arg set. */
const run = (args: Record<string, unknown>): Promise<IRun> =>
  collect(() =>
    Promise.resolve(
      // citty's own arg defaults are bypassed here on purpose: the object is
      // the full arg set, so nothing under test depends on a default being
      // applied. The suite below covers citty's own resolution separately.
      sendCommand.run?.({
        args: { ...baseArgs, ...args },
        rawArgs: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    )
  )

/** Runs the command through citty, so flag resolution is under test too. */
const runViaCitty = (rawArgs: string[]): Promise<IRun> =>
  collect(() =>
    runCommand(sendCommand, {
      rawArgs: [
        CONTRACT,
        '--private-key',
        FAKE_KEY,
        '--rpc-url',
        RPC_URL,
        '--no-confirm',
        ...rawArgs,
      ],
    })
  )

let originalFetch: typeof globalThis.fetch
let originalAllow: string | undefined

beforeEach(() => {
  hits = []
  estimatedContract = undefined
  estimatedSelector = undefined
  estimatedParameters = undefined
  broadcastSelector = undefined
  broadcastArgs = undefined
  contractAbi = [abiFunction('pause', [])]
  rpcHost = RPC_URL
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
    expect(errors.join('\n')).toContain('--fee-limit')
  })

  it('never reaches the broadcast when the energy price is unreadable', async () => {
    energyPrices = ''

    const { exitCode, errors } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('Could not price')
  })

  it('estimates against the base58 form of a 41-prefixed address', async () => {
    // The estimate posts `visible: true`, so it needs base58; `isValidAddress`
    // also accepts this form and the broadcast normalises it.
    const { exitCode } = await run({
      address: CONTRACT_HEX,
      calldata: '0xdeadbeef',
    })

    expect(exitCode).toBeUndefined()
    expect(estimatedContract).toBe(CONTRACT)
    expect(hits).toContain('broadcast')
  })

  it('estimates a base58 address unchanged', async () => {
    const { exitCode } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBeUndefined()
    expect(estimatedContract).toBe(CONTRACT)
  })

  it('broadcasts on a failed estimate when the escape hatch names the network', async () => {
    energyUsed = null
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    const { exitCode } = await run({ calldata: '0xdeadbeef' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('broadcast')
  })

  /**
   * The signature branch of this same command estimates through TronWeb's own
   * provider, which has no transport check, so refusing loopback here made the
   * two branches of one invocation disagree about a local dev node.
   */
  it.each(['http://localhost:8090', 'http://127.0.0.1:8090'])(
    'estimates against the plaintext loopback node %s',
    async (rpcUrl) => {
      const { exitCode } = await run({ calldata: '0xdeadbeef', rpcUrl })

      expect(exitCode).toBeUndefined()
      expect(hits).toContain('estimate-calldata')
      expect(hits).toContain('broadcast')
    }
  )

  it('never reaches the broadcast over plaintext HTTP to a non-loopback host', async () => {
    const { exitCode, errors } = await run({
      calldata: '0xdeadbeef',
      rpcUrl: 'http://tron.invalid',
    })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('estimate-calldata')
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toMatch(/non-HTTPS/i)
    expect(errors.join('\n')).toMatch(/except loopback/i)
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

  it('refuses a --value that is not a whole SUN amount', async () => {
    const { exitCode, errors } = await run({
      signature: 'pause()',
      value: 'abc',
    })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('Invalid --value')
  })

  it('estimates a --value the node can simulate', async () => {
    const { exitCode } = await run({ signature: 'pause()', value: '1tron' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('estimate-selector')
    expect(hits).toContain('broadcast')
  })

  it('never reaches the broadcast for a --value finer than one SUN', async () => {
    // 0.4 SUN. Rounding it to zero would broadcast a zero-value call for a
    // nonzero --value.
    const { exitCode, errors } = await run({
      signature: 'pause()',
      value: '0.0000004tron',
    })

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('finer than one SUN')
  })

  /**
   * Every other case on this path calls `pause()`, where the typed spelling and
   * the canonical selector are the same string and the argument list is empty —
   * so the selector the estimate prices was never actually observed.
   */
  describe('the selector the estimate prices', () => {
    const RECIPIENT = SENDER
    /** What `transfer(address,uint)` canonicalises to: 0xa9059cbb. */
    const CANONICAL = 'transfer(address,uint256)'

    beforeEach(() => {
      contractAbi = [abiFunction('transfer', ['address', 'uint256'])]
    })

    it('is the canonical one, not the spelling the operator typed', async () => {
      // `uint` is a valid way to write `uint256`, and hashes to a different
      // selector (0x6cb927d8 against 0xa9059cbb). Priced from the typed string,
      // the estimate simulated a function the contract does not have — the
      // simulation reverted and the guard refused a send that had worked.
      const { exitCode } = await run({
        signature: 'transfer(address,uint)',
        params: `${RECIPIENT},1000`,
      })

      expect(exitCode).toBeUndefined()
      expect(estimatedSelector).toBe(CANONICAL)
      expect(estimatedSelector).not.toBe('transfer(address,uint)')
      expect(hits).toContain('broadcast')
    })

    it('is the same one the broadcast is bound to, arguments included', async () => {
      const { exitCode } = await run({
        signature: 'transfer(address,uint)',
        params: `${RECIPIENT},1000`,
      })

      // Both pinned to the literal rather than to each other, so a run where
      // neither was recorded cannot pass on `undefined === undefined`.
      expect(exitCode).toBeUndefined()
      expect(estimatedSelector).toBe(CANONICAL)
      expect(broadcastSelector).toBe(CANONICAL)
      expect(broadcastArgs).toEqual([RECIPIENT, '1000'])
      expect(estimatedParameters).toEqual([
        { type: 'address', value: RECIPIENT },
        { type: 'uint256', value: '1000' },
      ])
    })

    it('is priced as typed when the ABI itself carries the loose spelling', async () => {
      // Paired with the case above so neither assertion is passing on the
      // canonicalisation alone: TronWeb formats the selector through ethers, so
      // it is canonical even when the ABI entry says `uint`.
      contractAbi = [abiFunction('transfer', ['address', 'uint'])]

      const { exitCode } = await run({
        signature: 'transfer(address,uint)',
        params: `${RECIPIENT},1000`,
      })

      expect(exitCode).toBeUndefined()
      expect(estimatedSelector).toBe(CANONICAL)
      expect(broadcastSelector).toBe(CANONICAL)
      // The ABI's own spellings, which is what the broadcast encodes with.
      expect(estimatedParameters?.map((p) => p.type)).toEqual([
        'address',
        'uint',
      ])
    })

    it('never reaches the estimate for a function the ABI does not declare', async () => {
      const { exitCode, errors } = await run({
        signature: 'burn(uint256)',
        params: '1000',
      })

      expect(exitCode).toBe(1)
      expect(hits).not.toContain('estimate-selector')
      expect(hits).not.toContain('broadcast')
      expect(errors.join('\n')).toContain('declares no function named "burn"')
    })

    it('never reaches the estimate for an overload the bare name cannot reach', async () => {
      contractAbi = [
        abiFunction('withdraw', ['uint256']),
        abiFunction('withdraw', ['address']),
      ]

      const { exitCode, errors } = await run({
        signature: 'withdraw(uint256)',
        params: '1000',
      })

      expect(exitCode).toBe(1)
      expect(hits).not.toContain('estimate-selector')
      expect(hits).not.toContain('broadcast')
      expect(errors.join('\n')).toContain('Refusing to guess')
      expect(errors.join('\n')).toContain(
        'withdraw(uint256), withdraw(address)'
      )
    })
  })

  it('estimates a decimal TRX --value that multiplies untidily', async () => {
    // 4.1 * 1e6 is 4099999.9999999995 in floating point. Left unrounded it is
    // not a SUN amount, and TronWeb's own integer validator refuses it at the
    // broadcast — so the guard would have passed a call that could not be sent.
    const { exitCode } = await run({ signature: 'pause()', value: '4.1tron' })

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('broadcast')
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

/**
 * The refusal tells the operator to re-run with a higher `--feeLimit`, so the
 * flag has to reach the guard whichever spelling they type. citty resolves the
 * spelling a caller did not type to the argument's `default`, which would make
 * that advice do nothing on the kebab form — on the break-glass path, an
 * operator looping on a refusal during an incident.
 */
describe('the fee limit as citty resolves it', () => {
  it('honours --fee-limit on the way up, so the refusal hint works', async () => {
    const { exitCode } = await runViaCitty([
      '--calldata',
      '0xdeadbeef',
      '--fee-limit',
      '1000',
    ])

    expect(exitCode).toBeUndefined()
    expect(hits).toContain('broadcast')
  })

  it('honours --fee-limit on the way down, so the guard sees the real cap', async () => {
    const { exitCode, errors } = await runViaCitty([
      '--calldata',
      '0xdeadbeef',
      '--fee-limit',
      '1',
    ])

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('exceeds the fee limit')
  })

  it('rejects a valueless --fee-limit rather than capping at 1 TRX', async () => {
    const { exitCode, errors } = await runViaCitty([
      '--calldata',
      '0xdeadbeef',
      '--fee-limit',
    ])

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('Invalid --fee-limit')
  })

  it('refuses a valueless --feeLimit, which citty resolves to an empty string', async () => {
    const { exitCode, errors } = await runViaCitty([
      '--calldata',
      '0xdeadbeef',
      '--feeLimit',
    ])

    expect(exitCode).toBe(1)
    expect(hits).not.toContain('broadcast')
    expect(errors.join('\n')).toContain('Invalid --fee-limit')
  })

  it('honours a --dry-run that swallowed the next token as its value', async () => {
    // citty hands the following argv entry to a kebab boolean. Reading that as
    // "off" would broadcast a run the operator asked to simulate.
    const { exitCode } = await runViaCitty([
      '--calldata',
      '0xdeadbeef',
      '--dry-run',
      'false-ish',
    ])

    expect(exitCode).toBeUndefined()
    expect(hits).not.toContain('broadcast')
  })

  it('honours --dry-run, so a simulated run does not broadcast', async () => {
    const { exitCode } = await runViaCitty([
      '--calldata',
      '0xdeadbeef',
      '--dry-run',
    ])

    expect(exitCode).toBeUndefined()
    expect(hits).not.toContain('broadcast')
    expect(hits).not.toContain('estimate-calldata')
  })
})

/**
 * The pre-flight is wired in after each path's dry-run return, not in front of
 * it. Run rather than read, because a guard placed one statement too early
 * swallows the return it was meant to sit behind, and the suite stays green.
 */
describe('the dry-run return still precedes the pre-flight', () => {
  it('neither estimates nor broadcasts on the raw-calldata path', async () => {
    const { exitCode } = await run({ calldata: '0xdeadbeef', dryRun: true })

    expect(exitCode).toBeUndefined()
    expect(hits).not.toContain('estimate-calldata')
    expect(hits).not.toContain('broadcast')
  })

  it('neither estimates nor broadcasts on the function-signature path', async () => {
    const { exitCode } = await run({ signature: 'pause()', dryRun: true })

    expect(exitCode).toBeUndefined()
    expect(hits).not.toContain('estimate-selector')
    expect(hits).not.toContain('broadcast')
  })

  it('still dry-runs a signature the ABI cannot resolve', async () => {
    // The selector resolution refuses outright, so it sits behind the dry-run
    // return rather than in front of it: a dry run that used to print an
    // estimate must not start exiting 1.
    contractAbi = [abiFunction('pause', [])]

    const { exitCode } = await run({
      signature: 'burn(uint256)',
      params: '1000',
      dryRun: true,
    })

    expect(exitCode).toBeUndefined()
    expect(hits).not.toContain('estimate-selector')
    expect(hits).not.toContain('broadcast')
  })
})
