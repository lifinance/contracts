import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { decodeFunctionData } from 'viem'

import {
  ALLBRIDGE_INIT_ABI,
  ALLBRIDGE_INIT_SELECTOR,
  encodeAllBridgeInitCalldata,
  parseAllBridgeMappings,
} from './allBridgeInit'

// Tron (1885080386571452 -> 3) and Stellar (1201081091099710 -> 7) are the
// headline mappings of the v2.2.0 rollout. 9270000000000000 exceeds
// Number.MAX_SAFE_INTEGER and is the reason ids are revived from source text.
const TRON = '{ "chainId": 1885080386571452, "allBridgeChainId": 3 }'
const STELLAR = '{ "chainId": 1201081091099710, "allBridgeChainId": 7 }'
const OVERFLOWING = '{ "chainId": 9270000000000000, "allBridgeChainId": 13 }'

const config = (...entries: string[]): string =>
  `{ "mappings": [${entries.join(
    ','
  )}], "tron": { "allBridge": "TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2" } }`

describe('parseAllBridgeMappings', () => {
  it('normalizes entries to bigints in file order', () => {
    expect(parseAllBridgeMappings(config(TRON, STELLAR))).toEqual([
      { chainId: 1885080386571452n, allBridgeChainId: 3n },
      { chainId: 1201081091099710n, allBridgeChainId: 7n },
    ])
  })

  it('preserves ids beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const mappings = parseAllBridgeMappings(config(OVERFLOWING))
    expect(mappings).toHaveLength(1)
    // guards against a regression to JSON.parse's double, which cannot
    // represent every integer in this range
    expect(mappings[0]?.chainId).toBe(9270000000000000n)
    expect(mappings[0]?.chainId.toString()).toBe('9270000000000000')
  })

  it('rejects a missing or empty mappings array', () => {
    for (const input of ['{}', '{ "mappings": [] }', '{ "mappings": 5 }'])
      expect(() => parseAllBridgeMappings(input)).toThrow(/"mappings" array/)
  })

  it('rejects a zero id (the reserved unmapped sentinel)', () => {
    expect(() =>
      parseAllBridgeMappings(config('{ "chainId": 1, "allBridgeChainId": 0 }'))
    ).toThrow(/allBridgeChainId must be > 0/)
    expect(() =>
      parseAllBridgeMappings(config('{ "chainId": 0, "allBridgeChainId": 1 }'))
    ).toThrow(/chainId must be > 0/)
  })

  it('rejects a fractional id', () => {
    expect(() =>
      parseAllBridgeMappings(
        config('{ "chainId": 1.5, "allBridgeChainId": 1 }')
      )
    ).toThrow(/must be an integer/)
  })

  it('rejects a missing or non-numeric id', () => {
    expect(() =>
      parseAllBridgeMappings(config('{ "allBridgeChainId": 1 }'))
    ).toThrow(/chainId must be a JSON number/)
    expect(() =>
      parseAllBridgeMappings(
        config('{ "chainId": "1", "allBridgeChainId": 1 }')
      )
    ).toThrow(/chainId must be a JSON number/)
  })

  it('rejects a duplicated chainId', () => {
    expect(() => parseAllBridgeMappings(config(TRON, TRON))).toThrow(
      /is duplicated/
    )
  })
})

describe('encodeAllBridgeInitCalldata', () => {
  it('encodes initAllBridge and round-trips the configs', () => {
    const calldata = encodeAllBridgeInitCalldata(
      parseAllBridgeMappings(config(TRON, STELLAR))
    )

    expect(calldata.startsWith(ALLBRIDGE_INIT_SELECTOR)).toBe(true)

    const { functionName, args } = decodeFunctionData({
      abi: ALLBRIDGE_INIT_ABI,
      data: calldata,
    })
    expect(functionName).toBe('initAllBridge')
    expect(args[0]).toEqual([
      { chainId: 1885080386571452n, allBridgeChainId: 3n },
      { chainId: 1201081091099710n, allBridgeChainId: 7n },
    ])
  })

  it('refuses to encode an empty mapping set (initAllBridge reverts InvalidConfig)', () => {
    expect(() => encodeAllBridgeInitCalldata([])).toThrow(/zero mappings/)
  })
})
