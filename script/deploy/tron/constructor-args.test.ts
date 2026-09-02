/**
 * ABI fixtures are trimmed copies of real artifact shapes: `ERC20Proxy` and
 * `ReceiverStargateV2` as they appear in `out/<name>.sol/<name>.json`, and a
 * facet with no constructor. They are EMBEDDED because CI has no build
 * artifacts, so a test that reads `out/` either fails there or passes vacuously.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  assertRecordedArgsMatchAbi,
  constructorInputTypes,
  encodeConstructorArgs,
} from './constructor-args'

/** Two addresses, the shape recorded as `'0x'` on every Tron deployment. */
const ERC20_PROXY_ABI = [
  {
    type: 'constructor',
    inputs: [
      { name: '_owner', type: 'address', internalType: 'address' },
      { name: '_executor', type: 'address', internalType: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'owner', inputs: [], outputs: [] },
]

/** Four addresses and a uint256 — the case type-guessing gets wrong. */
const RECEIVER_STARGATE_V2_ABI = [
  {
    type: 'constructor',
    inputs: [
      { name: '_owner', type: 'address', internalType: 'address' },
      { name: '_executor', type: 'address', internalType: 'address' },
      { name: '_tokenMessaging', type: 'address', internalType: 'address' },
      { name: '_endpointV2', type: 'address', internalType: 'address' },
      { name: '_recoverGas', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
]

/** A facet: no constructor entry at all, which is not the same as an empty one. */
const FACET_ABI = [{ type: 'function', name: 'doSomething', inputs: [] }]

const ADDRESS = '0x1111111111111111111111111111111111111111'

describe('constructorInputTypes', () => {
  it('reads the declared types rather than inferring them from values', () => {
    expect(constructorInputTypes(ERC20_PROXY_ABI)).toEqual([
      'address',
      'address',
    ])
    expect(constructorInputTypes(RECEIVER_STARGATE_V2_ABI)).toEqual([
      'address',
      'address',
      'address',
      'address',
      'uint256',
    ])
  })

  it('returns nothing for a contract with no constructor', () => {
    expect(constructorInputTypes(FACET_ABI)).toEqual([])
  })

  it('expands a tuple into its canonical form', () => {
    // A guessed type can never produce this, so it is the clearest signal that
    // types come from the ABI.
    const abi = [
      {
        type: 'constructor',
        inputs: [
          {
            name: '_config',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint128' },
            ],
          },
          { name: '_ids', type: 'uint32[]' },
        ],
      },
    ]

    expect(constructorInputTypes(abi)).toEqual([
      '(address,uint128)',
      'uint32[]',
    ])
  })

  it('refuses an ABI it cannot read instead of assuming no arguments', () => {
    // Returning [] here would let a malformed artifact record "no constructor
    // args" for a contract that has them — the exact defect being fixed.
    for (const bad of [undefined, null, {}, 'abi', 42])
      expect(() => constructorInputTypes(bad)).toThrow(/no readable ABI/i)
  })

  it('refuses a constructor whose inputs are not a list', () => {
    expect(() =>
      constructorInputTypes([{ type: 'constructor', inputs: 'address' }])
    ).toThrow(/inputs/i)
  })

  it('refuses an input with no type', () => {
    expect(() =>
      constructorInputTypes([
        { type: 'constructor', inputs: [{ name: '_owner' }] },
      ])
    ).toThrow(/type/i)
  })
})

describe('assertRecordedArgsMatchAbi', () => {
  it.each(['0x', '', '0X'])(
    'refuses %p as the record for a contract that takes arguments',
    (recorded) => {
      // The live defect: seven Tron periphery contracts are deployed with real
      // arguments and recorded with this literal, so a verifier rebuilding from
      // the record computes creation code for a different deployment.
      expect(() =>
        assertRecordedArgsMatchAbi('ERC20Proxy', recorded, [
          'address',
          'address',
        ])
      ).toThrow(/ERC20Proxy takes 2 constructor arguments/)
    }
  )

  it('accepts a record that carries encoded arguments', () => {
    expect(() =>
      assertRecordedArgsMatchAbi('ERC20Proxy', `0x${'11'.repeat(64)}`, [
        'address',
        'address',
      ])
    ).not.toThrow()
  })

  it.each(['0x', ''])(
    'accepts %p for a contract that takes none',
    (recorded) => {
      expect(() =>
        assertRecordedArgsMatchAbi('AccessManagerFacet', recorded, [])
      ).not.toThrow()
    }
  )

  it('refuses a record carrying arguments a contract cannot take', () => {
    // The mirror case: a record that claims more than the contract's ABI allows
    // is equally unverifiable, and it means someone recorded the wrong contract.
    expect(() =>
      assertRecordedArgsMatchAbi(
        'AccessManagerFacet',
        `0x${'11'.repeat(32)}`,
        []
      )
    ).toThrow(/takes no constructor arguments/)
  })
})

describe('encodeConstructorArgs', () => {
  /** Stands in for TronWeb's encoder; records what types it was handed. */
  const spyEncoder = () => {
    const seen: { types: string[]; values: readonly unknown[] }[] = []
    const encode = (types: string[], values: readonly unknown[]): string => {
      seen.push({ types, values })
      return `0x${'ab'.repeat(32)}`
    }
    return { seen, encode }
  }

  it('hands the encoder the declared types, not guessed ones', () => {
    const { seen, encode } = spyEncoder()
    // A gas value read from config arrives as a string. Guessing from the value
    // types it `string`, which ABI-encodes as dynamic bytes at a wholly
    // different offset; the ABI says `uint256`.
    encodeConstructorArgs(
      encode,
      [ADDRESS, ADDRESS, ADDRESS, ADDRESS, '100000'],
      constructorInputTypes(RECEIVER_STARGATE_V2_ABI),
      'ReceiverStargateV2'
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.types).toEqual([
      'address',
      'address',
      'address',
      'address',
      'uint256',
    ])
  })

  it('returns 0x without calling the encoder when there are no arguments', () => {
    const { seen, encode } = spyEncoder()

    expect(encodeConstructorArgs(encode, [], [], 'AccessManagerFacet')).toBe(
      '0x'
    )
    expect(seen).toHaveLength(0)
  })

  it('refuses when the argument count does not match the ABI', () => {
    const { encode } = spyEncoder()

    expect(() =>
      encodeConstructorArgs(
        encode,
        [ADDRESS],
        ['address', 'address'],
        'ERC20Proxy'
      )
    ).toThrow(/ERC20Proxy expects 2 constructor arguments, got 1/)
  })

  it('propagates an encoder failure instead of substituting its own bytes', () => {
    // The previous implementation caught this and concatenated raw hex and UTF-8
    // bytes, which is not ABI encoding — and wrote it to the record as if it
    // were. A failed deploy is recoverable; a wrong record is not.
    const failing = () => {
      throw new Error('unsupported type')
    }

    expect(() =>
      encodeConstructorArgs(failing, [ADDRESS], ['address'], 'ERC20Proxy')
    ).toThrow(/ERC20Proxy.*unsupported type/)
  })

  it('refuses an encoder result that is not hex', () => {
    // Whatever the encoder returns goes straight onto the record, so a
    // non-answer must not be stored as one.
    const bogus = () => 'not-hex'

    expect(() =>
      encodeConstructorArgs(bogus, [ADDRESS], ['address'], 'ERC20Proxy')
    ).toThrow(/did not return hex/i)
  })
})
