import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { decodeFunctionData, type Address, type Hex } from 'viem'

import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_SCHEDULE_BATCH_SELECTOR,
  classifyTimelockOperation,
  deriveTimelockSalt,
  encodeTimelockScheduleBatch,
} from './timelock-abi'

const ZERO_BYTES32 =
  // pre-commit-checker: not a secret — zero bytes32 sentinel used as test fixture
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address
const OTHER_TARGET = '0x0000000000000000000000000000000000000001' as Address
const SALT =
  // pre-commit-checker: not a secret — fixed salt fixture
  '0x0000000000000000000000000000000000000000000000000000000000000abc' as Hex
const REMOVE_CALLDATA = '0xdead0001' as Hex
const ADD_CALLDATA = '0xbeef0002' as Hex

function decode(calldata: Hex) {
  return decodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    data: calldata,
  })
}

describe('encodeTimelockScheduleBatch', () => {
  it('encodes a single call as batch-of-one', () => {
    const calldata = encodeTimelockScheduleBatch(
      [DIAMOND],
      [ADD_CALLDATA],
      SALT,
      3600n
    )

    expect(calldata.slice(0, 10)).toBe(TIMELOCK_SCHEDULE_BATCH_SELECTOR)

    const { functionName, args } = decode(calldata)
    expect(functionName).toBe('scheduleBatch')
    const [targets, values, payloads, predecessor, salt, delay] = args
    expect(targets).toEqual([DIAMOND])
    expect(values).toEqual([0n])
    expect(payloads).toEqual([ADD_CALLDATA])
    expect(predecessor).toBe(ZERO_BYTES32)
    expect(salt).toBe(SALT)
    expect(delay).toBe(3600n)
  })

  it('encodes multiple calls in order (removal before addition)', () => {
    const calldata = encodeTimelockScheduleBatch(
      [DIAMOND, DIAMOND],
      [REMOVE_CALLDATA, ADD_CALLDATA],
      SALT,
      7200n
    )

    const { args } = decode(calldata)
    const [targets, values, payloads] = args
    expect(targets).toEqual([DIAMOND, DIAMOND])
    expect(values).toEqual([0n, 0n])
    // Execution ordering inside the timelock batch follows array order:
    // the removal payload must come before the addition payload
    expect(payloads).toEqual([REMOVE_CALLDATA, ADD_CALLDATA])
  })

  it('supports distinct targets per inner call', () => {
    const calldata = encodeTimelockScheduleBatch(
      [DIAMOND, OTHER_TARGET],
      [REMOVE_CALLDATA, ADD_CALLDATA],
      SALT,
      3600n
    )

    const { args } = decode(calldata)
    expect(args[0]).toEqual([DIAMOND, OTHER_TARGET])
  })

  it('throws when no calls are provided', () => {
    expect(() => encodeTimelockScheduleBatch([], [], SALT, 3600n)).toThrow(
      'requires at least one call'
    )
  })

  it('throws when targets and payloads lengths differ', () => {
    expect(() =>
      encodeTimelockScheduleBatch(
        [DIAMOND, DIAMOND],
        [REMOVE_CALLDATA],
        SALT,
        3600n
      )
    ).toThrow('must have the same length')
  })

  it('throws on a non-hex payload instead of letting viem zero-pad it', () => {
    expect(() =>
      encodeTimelockScheduleBatch([DIAMOND], ['deadbeef' as never], SALT, 3600n)
    ).toThrow('not well-formed hex')
  })

  it('throws on an invalid target address', () => {
    expect(() =>
      encodeTimelockScheduleBatch(
        ['0xnot-an-address' as never],
        [REMOVE_CALLDATA],
        SALT,
        3600n
      )
    ).toThrow('not a valid address')
  })
})

describe('deriveTimelockSalt', () => {
  const action = {
    chainId: 1,
    timelockAddress: '0x1111111111111111111111111111111111111111' as Address,
    targets: ['0x2222222222222222222222222222222222222222'] as Address[],
    payloads: ['0xdeadbeef'] as Hex[],
  }

  it('is a bytes32 hex value', () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).toMatch(
      /^0x[0-9a-f]{64}$/
    )
  })

  it('is deterministic — the same action gives the same salt', () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).toBe(
      deriveTimelockSalt({ ...action, attempt: 0 })
    )
  })

  it('differs per attempt, so a legitimate repeat can get a fresh operation id', () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).not.toBe(
      deriveTimelockSalt({ ...action, attempt: 1 })
    )
  })

  it("differs across chains, so one chain cannot predict another's operation id", () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).not.toBe(
      deriveTimelockSalt({ ...action, chainId: 10, attempt: 0 })
    )
  })

  it('differs across timelocks', () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).not.toBe(
      deriveTimelockSalt({
        ...action,
        timelockAddress: '0x3333333333333333333333333333333333333333',
        attempt: 0,
      })
    )
  })

  it('differs when a payload changes', () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).not.toBe(
      deriveTimelockSalt({ ...action, payloads: ['0xdeadbeee'], attempt: 0 })
    )
  })

  it('differs when a target changes', () => {
    expect(deriveTimelockSalt({ ...action, attempt: 0 })).not.toBe(
      deriveTimelockSalt({
        ...action,
        targets: ['0x4444444444444444444444444444444444444444'],
        attempt: 0,
      })
    )
  })

  it('rejects a malformed address instead of deferring the failure to scheduleBatch', () => {
    expect(() =>
      deriveTimelockSalt({
        ...action,
        targets: ['0xnot-an-address' as Address],
        attempt: 0,
      })
    ).toThrow()
  })

  it('does not collide when call order changes — inner calls execute in array order', () => {
    const first = '0x2222222222222222222222222222222222222222' as Address
    const second = '0x4444444444444444444444444444444444444444' as Address

    expect(
      deriveTimelockSalt({
        ...action,
        targets: [first, second],
        payloads: ['0xaa', '0xbb'],
        attempt: 0,
      })
    ).not.toBe(
      deriveTimelockSalt({
        ...action,
        targets: [second, first],
        payloads: ['0xbb', '0xaa'],
        attempt: 0,
      })
    )
  })
})

describe('classifyTimelockOperation', () => {
  it('reads 0 as unknown — nothing scheduled', () => {
    expect(classifyTimelockOperation(0n)).toBe('unknown')
  })

  it('reads 1 as done — OZ writes _DONE_TIMESTAMP on execute', () => {
    expect(classifyTimelockOperation(1n)).toBe('done')
  })

  it('reads anything above 1 as pending', () => {
    expect(classifyTimelockOperation(2n)).toBe('pending')
    expect(classifyTimelockOperation(1_800_000_000n)).toBe('pending')
  })
})
