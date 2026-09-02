import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, parseAbi, type Hex } from 'viem'

import {
  extractRegistrations,
  groupRegistrationsByNetwork,
  registrationsFromQueueDoc,
  STALE_QUEUE_GRACE_MS,
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
const ABI_SET_WHITELIST = parseAbi([
  'function setContractSelectorWhitelist(address,bytes4,bool)',
])
const ABI_BATCH_SET_WHITELIST = parseAbi([
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const DEX = '0x5555555555555555555555555555555555555555'
const OTHER_DEX = '0x6666666666666666666666666666666666666666'
const SELECTOR = '0xf8989325' as Hex
const OTHER_SELECTOR = '0x2646478b' as Hex

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

describe('extractRegistrations', () => {
  it('returns the facet address for an Add cut', () => {
    expect(extractRegistrations(diamondCut([[FACET, 0]]))).toEqual([
      { kind: 'facet-cut', address: FACET.toLowerCase() },
    ])
  })

  it('returns the facet address for a Replace cut', () => {
    expect(extractRegistrations(diamondCut([[FACET, 1]]))).toEqual([
      { kind: 'facet-cut', address: FACET.toLowerCase() },
    ])
  })

  it('ignores a Remove cut — it leaves nothing routed', () => {
    expect(extractRegistrations(diamondCut([[FACET, 2]]))).toEqual([])
  })

  it('keeps only the routing cuts from a mixed batch', () => {
    expect(
      extractRegistrations(
        diamondCut([
          [FACET, 0],
          [OTHER_FACET, 2],
        ])
      )
    ).toEqual([{ kind: 'facet-cut', address: FACET.toLowerCase() }])
  })

  it('returns the periphery address and the name it is bound to', () => {
    const data = encodeFunctionData({
      abi: ABI_REGISTER_PERIPHERY,
      args: ['Executor', PERIPHERY],
    })
    expect(extractRegistrations(data)).toEqual([
      {
        kind: 'periphery',
        address: PERIPHERY.toLowerCase(),
        peripheryName: 'Executor',
      },
    ])
  })

  it('returns nothing for a call that registers nothing', () => {
    const data = encodeFunctionData({
      abi: ABI_UNRELATED,
      args: [`0x${'00'.repeat(32)}` as Hex, PERIPHERY],
    })
    expect(extractRegistrations(data)).toEqual([])
  })

  it.each([
    ['empty', ''],
    ['selector-only stub', '0x1234'],
    ['undecodable payload', `0xdeadbeef${'00'.repeat(64)}`],
  ])('returns nothing for an %s payload', (_label, payload) => {
    expect(extractRegistrations(payload)).toEqual([])
  })

  it('returns nothing for a non-string payload', () => {
    expect(extractRegistrations(undefined as unknown as Hex)).toEqual([])
  })

  it('returns the pair a single whitelist setter grants', () => {
    const data = encodeFunctionData({
      abi: ABI_SET_WHITELIST,
      args: [DEX, SELECTOR, true],
    })
    expect(extractRegistrations(data)).toEqual([
      { kind: 'whitelist', address: DEX.toLowerCase(), selector: SELECTOR },
    ])
  })

  it('ignores a whitelist setter that revokes the pair', () => {
    const data = encodeFunctionData({
      abi: ABI_SET_WHITELIST,
      args: [DEX, SELECTOR, false],
    })
    expect(extractRegistrations(data)).toEqual([])
  })

  it('pairs a whitelist batch positionally', () => {
    const data = encodeFunctionData({
      abi: ABI_BATCH_SET_WHITELIST,
      args: [[DEX, OTHER_DEX], [SELECTOR, OTHER_SELECTOR], true],
    })
    expect(extractRegistrations(data)).toEqual([
      { kind: 'whitelist', address: DEX.toLowerCase(), selector: SELECTOR },
      {
        kind: 'whitelist',
        address: OTHER_DEX.toLowerCase(),
        selector: OTHER_SELECTOR,
      },
    ])
  })

  it('ignores a whitelist batch that revokes its pairs', () => {
    const data = encodeFunctionData({
      abi: ABI_BATCH_SET_WHITELIST,
      args: [[DEX], [SELECTOR], false],
    })
    expect(extractRegistrations(data)).toEqual([])
  })

  it('ignores a length-mismatched batch — the facet reverts, so nothing lands', () => {
    const data = encodeFunctionData({
      abi: ABI_BATCH_SET_WHITELIST,
      args: [[DEX, OTHER_DEX], [SELECTOR], true],
    })
    expect(extractRegistrations(data)).toEqual([])
  })

  it('lowercases the selector so a mixed-case payload still matches config', () => {
    const data = encodeFunctionData({
      abi: ABI_SET_WHITELIST,
      args: [DEX, '0xF8989325' as Hex, true],
    })
    expect(extractRegistrations(data)[0]?.selector).toBe(SELECTOR)
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
    expect(registrations.get(FACET.toLowerCase())).toEqual([
      {
        kind: 'facet-cut',
        address: FACET.toLowerCase(),
        operationId: OPERATION_ID,
        target: DIAMOND.toLowerCase(),
      },
    ])
    // The second call targets something other than the diamond; the target must be
    // carried through so the caller can reject it, not silently attributed.
    expect(registrations.get(PERIPHERY.toLowerCase())?.[0]?.target).toBe(
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

describe('groupRegistrationsByNetwork', () => {
  const NOW = Date.UTC(2026, 7, 25, 12, 0, 0)
  const DELAY_SECONDS = '10800' // 3 h, the delay every real queue row carries
  const DELAY_MS = Number(DELAY_SECONDS) * 1000
  const HOUR_MS = 60 * 60 * 1000

  const row = (
    network: string,
    cuts: Array<[string, number]>,
    opId: string,
    createdAt: Date = new Date(NOW - 60_000)
  ) => ({
    network,
    operationId: opId as Hex,
    targets: cuts.map(() => DIAMOND as `0x${string}`),
    payloads: cuts.map((c) => diamondCut([c])),
    createdAt,
    delay: DELAY_SECONDS,
  })

  it('groups by lowercased network name', () => {
    const grouped = groupRegistrationsByNetwork(
      [row('Mainnet', [[FACET, 0]], OPERATION_ID)],
      NOW
    )
    expect([...grouped.keys()]).toEqual(['mainnet'])
    expect(grouped.get('mainnet')?.get(FACET.toLowerCase())?.[0]?.target).toBe(
      DIAMOND.toLowerCase()
    )
  })

  it('keeps networks separate', () => {
    const grouped = groupRegistrationsByNetwork(
      [
        row('mainnet', [[FACET, 0]], OPERATION_ID),
        row('base', [[OTHER_FACET, 0]], `0x${'11'.repeat(32)}`),
      ],
      NOW
    )
    expect(grouped.get('mainnet')?.has(OTHER_FACET.toLowerCase())).toBe(false)
    expect(grouped.get('base')?.has(FACET.toLowerCase())).toBe(false)
  })

  it('merges multiple rows for the same network', () => {
    const grouped = groupRegistrationsByNetwork(
      [
        row('mainnet', [[FACET, 0]], OPERATION_ID),
        row('mainnet', [[OTHER_FACET, 0]], `0x${'22'.repeat(32)}`),
      ],
      NOW
    )
    expect(grouped.get('mainnet')?.size).toBe(2)
  })

  it('omits a network whose rows register nothing', () => {
    const grouped = groupRegistrationsByNetwork(
      [row('mainnet', [[FACET, 2]], OPERATION_ID)],
      NOW
    )
    expect(grouped.size).toBe(0)
  })

  it('returns an empty map for no rows', () => {
    expect(groupRegistrationsByNetwork([], NOW).size).toBe(0)
  })

  // A never-scheduled or directly-cancelled operation is reported and skipped by the
  // execution runner without a status change, so it stays `queued` forever. Honouring
  // it indefinitely would mask exactly the never-landed cut this gate exists to catch.
  it('drops a row stuck past its delay plus the grace window', () => {
    const stuck = new Date(NOW - (STALE_QUEUE_GRACE_MS + DELAY_MS + HOUR_MS))
    const grouped = groupRegistrationsByNetwork(
      [row('mainnet', [[FACET, 0]], OPERATION_ID, stuck)],
      NOW
    )
    expect(grouped.size).toBe(0)
  })

  it('still honours the slowest rollout observed in the live queue (~70.7 h)', () => {
    const slow = new Date(NOW - 70.7 * HOUR_MS)
    const grouped = groupRegistrationsByNetwork(
      [row('mainnet', [[FACET, 0]], OPERATION_ID, slow)],
      NOW
    )
    expect(grouped.get('mainnet')?.size).toBe(1)
  })

  it('drops a row whose createdAt is unusable rather than trusting it', () => {
    const grouped = groupRegistrationsByNetwork(
      [row('mainnet', [[FACET, 0]], OPERATION_ID, new Date('not-a-date'))],
      NOW
    )
    expect(grouped.size).toBe(0)
  })
})

describe('real-payload shapes the live queue actually carries', () => {
  // 101 of 615 real diamondCut payloads pass a non-zero _init address, which is
  // delegatecalled during the cut but never becomes a routed facet. Counting it as
  // registered would downgrade an unrelated missing facet.
  it('never treats a non-zero _init address as registered', () => {
    const INIT = '0x9999999999999999999999999999999999999999'
    const data = encodeFunctionData({
      abi: ABI_DIAMOND_CUT,
      args: [
        [[FACET as `0x${string}`, 0, ['0x12345678' as Hex]]] as never,
        INIT,
        '0xdeadbeef',
      ],
    })
    const registrations = extractRegistrations(data)
    expect(registrations).toEqual([
      { kind: 'facet-cut', address: FACET.toLowerCase() },
    ])
    expect(registrations.map((r) => r.address)).not.toContain(
      INIT.toLowerCase()
    )
  })

  it('treats registering the zero address as a removal, not a registration', () => {
    const data = encodeFunctionData({
      abi: ABI_REGISTER_PERIPHERY,
      args: ['Executor', '0x0000000000000000000000000000000000000000'],
    })
    expect(extractRegistrations(data)).toEqual([])
  })

  // registerPeripheryContract binds an address to ONE registry name. Keeping only the
  // address let a queued registration under any name downgrade a different name that
  // getPeripheryContract would still return unset — a false green on an error gate.
  it('binds a periphery registration to the name it actually registers', () => {
    const registrations = registrationsFromQueueDoc({
      operationId: OPERATION_ID,
      targets: [DIAMOND as `0x${string}`],
      payloads: [
        encodeFunctionData({
          abi: ABI_REGISTER_PERIPHERY,
          args: ['Other', PERIPHERY],
        }),
      ],
    })
    expect(registrations.get(PERIPHERY.toLowerCase())).toEqual([
      {
        kind: 'periphery',
        address: PERIPHERY.toLowerCase(),
        peripheryName: 'Other',
        operationId: OPERATION_ID,
        target: DIAMOND.toLowerCase(),
      },
    ])
  })

  // Keying by address alone dropped one of two registrations for the same address, so a
  // later non-diamond target could erase real coverage recorded by an earlier call.
  it('keeps every record for one address instead of letting the last call win', () => {
    const registrations = registrationsFromQueueDoc({
      operationId: OPERATION_ID,
      targets: [DIAMOND as `0x${string}`, OTHER_FACET as `0x${string}`],
      payloads: [diamondCut([[FACET, 0]]), diamondCut([[FACET, 0]])],
    })
    expect(
      registrations.get(FACET.toLowerCase())?.map((r) => r.target)
    ).toEqual([DIAMOND.toLowerCase(), OTHER_FACET.toLowerCase()])
  })

  it('handles a multi-call row mixing an Add, a Remove and a periphery registration', () => {
    const registrations = registrationsFromQueueDoc({
      operationId: OPERATION_ID,
      targets: [
        DIAMOND as `0x${string}`,
        DIAMOND as `0x${string}`,
        DIAMOND as `0x${string}`,
      ],
      payloads: [
        diamondCut([[FACET, 0]]),
        diamondCut([[OTHER_FACET, 2]]),
        encodeFunctionData({
          abi: ABI_REGISTER_PERIPHERY,
          args: ['OutputValidator', PERIPHERY],
        }),
      ],
    })
    expect([...registrations.keys()].sort()).toEqual(
      [FACET.toLowerCase(), PERIPHERY.toLowerCase()].sort()
    )
  })
})
