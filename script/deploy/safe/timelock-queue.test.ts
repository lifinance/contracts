import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { TIMELOCK_SCHEDULE_BATCH_ABI } from './timelock-abi'
import {
  computeOperationIdBatch,
  decodeScheduleBatch,
  deserializeScheduleParams,
  isScheduleBatchCalldata,
  serializeScheduleParams,
  type IScheduleBatchParams,
} from './timelock-queue'

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

const SAMPLE_TARGET = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address
const SAMPLE_PAYLOAD = '0xdeadbeef' as Hex

function buildScheduleBatchCalldata(params: IScheduleBatchParams): Hex {
  return encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      params.targets as Address[],
      params.values as bigint[],
      params.payloads as Hex[],
      params.predecessor,
      params.salt,
      params.delay,
    ],
  })
}

describe('isScheduleBatchCalldata', () => {
  it('returns true for known scheduleBatch selector', () => {
    const data = buildScheduleBatchCalldata({
      targets: [SAMPLE_TARGET],
      values: [0n],
      payloads: [SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: ZERO_BYTES32,
      delay: 3600n,
    })
    expect(isScheduleBatchCalldata(data)).toBe(true)
  })

  it('is case-insensitive on the selector', () => {
    const data = buildScheduleBatchCalldata({
      targets: [SAMPLE_TARGET],
      values: [0n],
      payloads: [SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: ZERO_BYTES32,
      delay: 3600n,
    })
    const upper = (data.slice(0, 2) +
      data.slice(2).toUpperCase()) as unknown as Hex
    expect(isScheduleBatchCalldata(upper)).toBe(true)
  })

  it('returns false for non-scheduleBatch selector', () => {
    expect(isScheduleBatchCalldata('0xdeadbeef')).toBe(false)
  })

  it('returns false for short or missing input', () => {
    expect(isScheduleBatchCalldata(undefined)).toBe(false)
    expect(isScheduleBatchCalldata('')).toBe(false)
    expect(isScheduleBatchCalldata('0x12')).toBe(false)
  })
})

describe('decodeScheduleBatch', () => {
  it('round-trips encoded scheduleBatch params', () => {
    const expected: IScheduleBatchParams = {
      targets: [SAMPLE_TARGET, '0x000000000000000000000000000000000000bEEF'],
      values: [0n, 1n],
      payloads: ['0x' as Hex, SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: `0x${'1'.repeat(64)}` as Hex,
      delay: 86_400n,
    }
    const data = buildScheduleBatchCalldata(expected)
    const decoded = decodeScheduleBatch(data)
    expect(decoded.targets).toEqual(expected.targets)
    expect(decoded.values).toEqual(expected.values)
    expect(decoded.payloads).toEqual(expected.payloads)
    expect(decoded.predecessor).toBe(expected.predecessor)
    expect(decoded.salt).toBe(expected.salt)
    expect(decoded.delay).toBe(expected.delay)
  })

  it('throws for non-scheduleBatch calldata', () => {
    expect(() => decodeScheduleBatch('0xdeadbeef' as Hex)).toThrow()
  })
})

describe('computeOperationIdBatch', () => {
  it('is deterministic for identical inputs', () => {
    const id1 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    const id2 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    expect(id1).toBe(id2)
  })

  it('changes when salt changes', () => {
    const id1 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    const id2 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      `0x${'a'.repeat(64)}` as Hex
    )
    expect(id1).not.toBe(id2)
  })

  it('changes when payload bytes change', () => {
    const id1 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      ['0x01' as Hex],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    const id2 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      ['0x02' as Hex],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    expect(id1).not.toBe(id2)
  })

  it('returns a 32-byte hex string', () => {
    const id = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    expect(id).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })
})

describe('serialize/deserialize round-trip', () => {
  const maxUint256 = 2n ** 256n - 1n

  it('preserves max uint256 values across serialize/deserialize', () => {
    const params: IScheduleBatchParams = {
      targets: [SAMPLE_TARGET],
      values: [maxUint256],
      payloads: [SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: ZERO_BYTES32,
      delay: maxUint256,
    }
    const serialized = serializeScheduleParams(params)
    expect(serialized.values).toEqual([maxUint256.toString()])
    expect(serialized.delay).toBe(maxUint256.toString())

    const restored = deserializeScheduleParams(serialized)
    expect(restored.values).toEqual([maxUint256])
    expect(restored.delay).toBe(maxUint256)
  })

  it('round-trips multiple values and preserves array order', () => {
    const params: IScheduleBatchParams = {
      targets: [
        SAMPLE_TARGET,
        '0x000000000000000000000000000000000000bEEF' as Address,
      ],
      values: [0n, 12345n],
      payloads: ['0x' as Hex, SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: `0x${'9'.repeat(64)}` as Hex,
      delay: 86_400n,
    }
    const restored = deserializeScheduleParams(serializeScheduleParams(params))
    expect(restored.targets).toEqual(params.targets)
    expect(restored.values).toEqual(params.values)
    expect(restored.payloads).toEqual(params.payloads)
    expect(restored.predecessor).toBe(params.predecessor)
    expect(restored.salt).toBe(params.salt)
    expect(restored.delay).toBe(params.delay)
  })
})
