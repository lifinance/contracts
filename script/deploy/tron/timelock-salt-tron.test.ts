import { describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'

import {
  TIMELOCK_ZERO_PREDECESSOR,
  deriveTimelockSalt,
} from '../safe/timelock-abi'

import {
  createTronTimelockReader,
  pickTronTimelockSalt,
  type ITronTimelockContractSource,
} from './timelock-salt-tron'

const TIMELOCK_B58 = 'TBzBFjsCh3LJh9avAKy9oF3StZMn4hUBhu'
const TIMELOCK_EVM = '0x161f35951702e93ffee662ed16fb538c283462a5' as Address
const CHAIN_ID = 728126428

const action = {
  targets: [
    '0xc6594cd50c39ba5f23538fdc3b8492c95edb6fe1',
    '0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e',
  ] as Address[],
  payloads: ['0xdeadbeef', '0xfeedface'] as Hex[],
}

/** The id the real OZ timelock reports, over every field it hashes. */
const ozOperationId = (
  targets: readonly string[],
  values: readonly string[],
  payloads: readonly string[],
  predecessor: string,
  salt: string
): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'address[]' },
        { type: 'uint256[]' },
        { type: 'bytes[]' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        targets as Address[],
        values.map((value) => BigInt(value)),
        payloads as Hex[],
        predecessor as Hex,
        salt as Hex,
      ]
    )
  )

const saltFor = (attempt: number): Hex =>
  deriveTimelockSalt({
    chainId: CHAIN_ID,
    timelockAddress: TIMELOCK_EVM,
    targets: action.targets,
    payloads: action.payloads,
    attempt,
  })

const idFor = (attempt: number): Hex =>
  ozOperationId(
    action.targets,
    action.targets.map(() => '0'),
    action.payloads,
    TIMELOCK_ZERO_PREDECESSOR,
    saltFor(attempt)
  )

interface IFakeTronWeb extends ITronTimelockContractSource {
  contractsAskedFor: string[]
  hashArgs: unknown[][]
  probedIds: string[]
}

/**
 * A TronWeb whose timelock derives the operation id the way OZ does and
 * answers `getTimestamp` from a table, refusing any other address. A fake
 * that returned the salt as the id would let a probe of the wrong operation
 * pass, which is what hid three bugs on the EVM side.
 */
const fakeTronWeb = (
  timestampsByOperationId: Record<string, bigint>,
  options: {
    returnStyle?: 'prefixed' | 'bare'
    timestampStyle?: 'bigint' | 'string' | 'object'
  } = {}
): IFakeTronWeb => {
  const contractsAskedFor: string[] = []
  const hashArgs: unknown[][] = []
  const probedIds: string[] = []
  return {
    contractsAskedFor,
    hashArgs,
    probedIds,
    contract: (_abi, address) => {
      contractsAskedFor.push(address)
      if (address !== TIMELOCK_B58)
        throw new Error(`contract at ${address}, expected the timelock`)
      return {
        hashOperationBatch: (targets, values, payloads, predecessor, salt) => ({
          call: async () => {
            hashArgs.push([targets, values, payloads, predecessor, salt])
            const id = ozOperationId(
              targets,
              values,
              payloads,
              predecessor,
              salt
            )
            return options.returnStyle === 'bare' ? id.slice(2) : id
          },
        }),
        getTimestamp: (operationId) => ({
          call: async () => {
            probedIds.push(operationId)
            const ts = timestampsByOperationId[operationId] ?? 0n
            if (options.timestampStyle === 'string') return ts.toString()
            if (options.timestampStyle === 'object')
              return { toString: () => ts.toString() }
            return ts
          },
        }),
      }
    },
  }
}

/** Resolves to the rejection, so an assertion on it cannot pass vacuously. */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error
  )

const pick = (tronWeb: IFakeTronWeb): Promise<Hex> =>
  pickTronTimelockSalt({
    tronWeb,
    chainId: CHAIN_ID,
    timelockAddressBase58: TIMELOCK_B58,
    timelockAddressEvm: TIMELOCK_EVM,
    ...action,
  })

describe('pickTronTimelockSalt', () => {
  it('uses the first attempt when the timelock knows nothing about it', async () => {
    expect(await pick(fakeTronWeb({}))).toBe(saltFor(0))
  })

  it('is deterministic: the same batch twice yields the same salt', async () => {
    expect(await pick(fakeTronWeb({}))).toBe(await pick(fakeTronWeb({})))
  })

  it('probes the operation it will schedule: same targets and payloads, all-zero values as decimal strings, zero predecessor', async () => {
    const tronWeb = fakeTronWeb({})
    const salt = await pick(tronWeb)
    expect(tronWeb.hashArgs).toEqual([
      [
        action.targets,
        ['0', '0'],
        action.payloads,
        TIMELOCK_ZERO_PREDECESSOR,
        salt,
      ],
    ])
    expect(tronWeb.probedIds).toEqual([idFor(0)])
    expect(tronWeb.contractsAskedFor).toEqual([TIMELOCK_B58])
  })

  it('refuses when the same batch is still pending on the timelock', async () => {
    const tronWeb = fakeTronWeb({ [idFor(0)]: 1_800_000_000n })
    expect(String(await rejectionOf(pick(tronWeb)))).toMatch(
      /already scheduled/
    )
  })

  it('advances to the next attempt once the same batch has executed', async () => {
    const tronWeb = fakeTronWeb({ [idFor(0)]: 1n })
    expect(await pick(tronWeb)).toBe(saltFor(1))
    expect(tronWeb.probedIds).toEqual([idFor(0), idFor(1)])
  })

  it('refuses a pending repeat even behind executed ones', async () => {
    const tronWeb = fakeTronWeb({ [idFor(0)]: 1n, [idFor(1)]: 1_800_000_000n })
    expect(String(await rejectionOf(pick(tronWeb)))).toMatch(
      /already scheduled/
    )
  })

  it('reads a bare hex id and a stringified timestamp the way TronWeb returns them', async () => {
    const tronWeb = fakeTronWeb(
      { [idFor(0)]: 1n },
      { returnStyle: 'bare', timestampStyle: 'string' }
    )
    expect(await pick(tronWeb)).toBe(saltFor(1))
    const objectStyle = fakeTronWeb(
      { [idFor(0)]: 1n },
      { timestampStyle: 'object' }
    )
    expect(await pick(objectStyle)).toBe(saltFor(1))
  })

  it('does not accept an operation id it cannot read', async () => {
    const reader = createTronTimelockReader(
      {
        contract: () => ({
          hashOperationBatch: () => ({ call: async () => 'not-hex' }),
          getTimestamp: () => ({ call: async () => 0n }),
        }),
      },
      TIMELOCK_B58
    )
    expect(
      String(
        await rejectionOf(
          reader.hashOperationBatch(
            [],
            [],
            [],
            TIMELOCK_ZERO_PREDECESSOR,
            saltFor(0)
          )
        )
      )
    ).toMatch(/unreadable operation id/)
  })
})
