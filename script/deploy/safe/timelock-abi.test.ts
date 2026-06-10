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
})
