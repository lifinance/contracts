import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, parseAbi, type Hex } from 'viem'

import {
  extractRegisteredAddresses,
  registrationsFromQueueDoc,
} from './pending-registrations'

const DIAMOND = '0x1111111111111111111111111111111111111111'
const FACET = '0x2222222222222222222222222222222222222222'
const OTHER_FACET = '0x3333333333333333333333333333333333333333'
const PERIPHERY = '0x4444444444444444444444444444444444444444'
const OPERATION_ID = `0x${'ab'.repeat(32)}` as Hex

const ABI_DIAMOND_CUT = parseAbi([
  'function diamondCut((address,uint8,bytes4[])[],address,bytes)',
])
const ABI_REGISTER_PERIPHERY = parseAbi([
  'function registerPeripheryContract(string,address)',
])
const ABI_UNRELATED = parseAbi(['function grantRole(bytes32,address)'])

/** Encodes a `diamondCut` with one cut per `(address, action)` pair. */
function diamondCut(cuts: Array<[string, number]>): Hex {
  return encodeFunctionData({
    abi: ABI_DIAMOND_CUT,
    args: [
      cuts.map(([address, action]) => [
        address as `0x${string}`,
        action,
        ['0x12345678' as Hex],
      ]) as never,
      '0x0000000000000000000000000000000000000000',
      '0x',
    ],
  })
}

describe('extractRegisteredAddresses', () => {
  it('returns the facet address for an Add cut', () => {
    expect(extractRegisteredAddresses(diamondCut([[FACET, 0]]))).toEqual([
      FACET.toLowerCase(),
    ])
  })

  it('returns the facet address for a Replace cut', () => {
    expect(extractRegisteredAddresses(diamondCut([[FACET, 1]]))).toEqual([
      FACET.toLowerCase(),
    ])
  })

  it('ignores a Remove cut — it leaves nothing routed', () => {
    expect(extractRegisteredAddresses(diamondCut([[FACET, 2]]))).toEqual([])
  })

  it('keeps only the routing cuts from a mixed batch', () => {
    expect(
      extractRegisteredAddresses(
        diamondCut([
          [FACET, 0],
          [OTHER_FACET, 2],
        ])
      )
    ).toEqual([FACET.toLowerCase()])
  })

  it('returns the periphery address for registerPeripheryContract', () => {
    const data = encodeFunctionData({
      abi: ABI_REGISTER_PERIPHERY,
      args: ['Executor', PERIPHERY],
    })
    expect(extractRegisteredAddresses(data)).toEqual([PERIPHERY.toLowerCase()])
  })

  it('returns nothing for a call that registers nothing', () => {
    const data = encodeFunctionData({
      abi: ABI_UNRELATED,
      args: [`0x${'00'.repeat(32)}` as Hex, PERIPHERY],
    })
    expect(extractRegisteredAddresses(data)).toEqual([])
  })

  it.each([
    ['empty', ''],
    ['selector-only stub', '0x1234'],
    ['undecodable payload', `0xdeadbeef${'00'.repeat(64)}`],
  ])('returns nothing for an %s payload', (_label, payload) => {
    expect(extractRegisteredAddresses(payload)).toEqual([])
  })

  it('returns nothing for a non-string payload', () => {
    expect(extractRegisteredAddresses(undefined as unknown as Hex)).toEqual([])
  })
})

describe('registrationsFromQueueDoc', () => {
  it('pairs each payload with the target at the same index', () => {
    const registrations = registrationsFromQueueDoc({
      operationId: OPERATION_ID,
      targets: [DIAMOND as `0x${string}`, OTHER_FACET as `0x${string}`],
      payloads: [
        diamondCut([[FACET, 0]]),
        encodeFunctionData({
          abi: ABI_REGISTER_PERIPHERY,
          args: ['Executor', PERIPHERY],
        }),
      ],
    })
    expect(registrations.get(FACET.toLowerCase())).toEqual({
      operationId: OPERATION_ID,
      target: DIAMOND.toLowerCase(),
    })
    // The second call targets something other than the diamond; the target must be
    // carried through so the caller can reject it, not silently attributed.
    expect(registrations.get(PERIPHERY.toLowerCase())?.target).toBe(
      OTHER_FACET.toLowerCase()
    )
  })

  it('skips a payload with no matching target', () => {
    const registrations = registrationsFromQueueDoc({
      operationId: OPERATION_ID,
      targets: [],
      payloads: [diamondCut([[FACET, 0]])],
    })
    expect(registrations.size).toBe(0)
  })

  it('returns an empty map for a row that registers nothing', () => {
    const registrations = registrationsFromQueueDoc({
      operationId: OPERATION_ID,
      targets: [DIAMOND as `0x${string}`],
      payloads: [
        encodeFunctionData({
          abi: ABI_UNRELATED,
          args: [`0x${'00'.repeat(32)}` as Hex, PERIPHERY],
        }),
      ],
    })
    expect(registrations.size).toBe(0)
  })
})
