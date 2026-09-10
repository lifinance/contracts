/**
 * Covers the two halves separately, because they fail for different reasons:
 * `observeEvmImmutables` turns an artifact into named values and refuses when
 * its two inputs are from different compilations, while `priceImmutables` grades
 * those values against the registry and answers per slot.
 *
 * The fixture shape follows `immutable-offsets.test.ts`: `immutableReferences`
 * as Foundry emits it, over runtime code holding non-zero bytes at the
 * referenced offsets — a real deployment's slots hold the values, and all-zero
 * filler cannot tell a match from a mask.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IImmutableDeclaration } from '../immutables/immutable-ast'
import type { DeployRequirements } from '../immutables/registry-schema'
import realRequirements from '../resources/deployRequirements.json'
import realRegistry from '../resources/immutableRegistry.json'

import type { IObservedImmutable } from './immutable-expectations'
import { observeEvmImmutables, priceImmutables } from './immutable-expectations'

const SPOKE_POOL = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A'
const WRAPPED_NATIVE = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'

/** A 20-byte address as a 32-byte immutable slot holds it. */
const slot = (address: string): string =>
  `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`

/**
 * 128 bytes: filler, then the spoke pool twice, then the wrapped native. Two
 * copies of one immutable is the shape that can disagree with itself.
 */
const CODE = `0x${'ab'.repeat(32)}${slot(SPOKE_POOL).slice(2)}${slot(
  SPOKE_POOL
).slice(2)}${slot(WRAPPED_NATIVE).slice(2)}`

const REFS = {
  '101': [
    { start: 32, length: 32 },
    { start: 64, length: 32 },
  ],
  '102': [{ start: 96, length: 32 }],
}

const DECLARATIONS: IImmutableDeclaration[] = [
  {
    file: 'src/Facets/AcrossFacet.sol',
    contract: 'AcrossFacet',
    line: 23,
    astId: 101,
    type: 'contract IAcrossSpokePool',
    visibility: 'private',
    name: 'spokePool',
  },
  {
    file: 'src/Facets/AcrossFacet.sol',
    contract: 'AcrossFacet',
    line: 27,
    astId: 102,
    type: 'address',
    visibility: 'private',
    name: 'wrappedNative',
  },
]

const REQUIREMENTS: DeployRequirements = {
  AcrossFacet: {
    configData: {
      _spokePool: {
        configFileName: 'across.json',
        keyInConfigFile: '.<NETWORK>.acrossSpokePool',
      },
      _wrappedNativeAddress: {
        configFileName: 'networks.json',
        keyInConfigFile: '.<NETWORK>.wrappedNativeAddress',
      },
    },
    immutables: {
      spokePool: { source: 'config', configData: '_spokePool' },
      wrappedNative: {
        source: 'config',
        configData: '_wrappedNativeAddress',
      },
    },
  },
}

const CONFIG: Record<string, unknown> = {
  'across.json': { arbitrum: { acrossSpokePool: SPOKE_POOL } },
  'networks.json': { arbitrum: { wrappedNativeAddress: WRAPPED_NATIVE } },
}

const loader = (fileName: string): unknown => CONFIG[fileName] ?? null

const price = (
  observed: readonly IObservedImmutable[],
  requirements: DeployRequirements = REQUIREMENTS,
  network = 'arbitrum'
): ReturnType<typeof priceImmutables> =>
  priceImmutables(
    {
      contractName: 'AcrossFacet',
      observed,
      network,
      environment: 'production',
    },
    requirements,
    loader
  )

const observe = (
  declarations: readonly IImmutableDeclaration[] = DECLARATIONS,
  code = CODE
): ReturnType<typeof observeEvmImmutables> =>
  observeEvmImmutables(code, REFS, declarations)

describe('observeEvmImmutables', () => {
  it('names each immutable and counts every copy it occupies', () => {
    const result = observe()
    if (!('ok' in result)) throw new Error(result.reason)

    expect(result.observed).toEqual([
      {
        name: 'spokePool',
        value: slot(SPOKE_POOL),
        slotByteCount: 32,
        byteCount: 64,
      },
      {
        name: 'wrappedNative',
        value: slot(WRAPPED_NATIVE),
        slotByteCount: 32,
        byteCount: 32,
      },
    ])
  })

  it('refuses when an astId has no declaration, rather than pricing the rest', () => {
    // The failure mode this guards: AST ids are only meaningful within the
    // compilation that assigned them, so one unmatched id means every matched
    // id may name the wrong slot too.
    const result = observe([DECLARATIONS[0] as IImmutableDeclaration])

    expect('ok' in result).toBe(false)
    if ('ok' in result) return
    expect(result.reason).toContain('astId 102')
    expect(result.reason).toContain('different compilations')
  })

  it('refuses when two contracts claim one astId', () => {
    // Ids are unique within a compilation, but a repo-wide declaration set spans
    // one solc invocation per pragma, and two of them can reuse an id.
    const colliding: IImmutableDeclaration[] = [
      ...DECLARATIONS,
      {
        file: 'src/Periphery/Other.sol',
        contract: 'Other',
        line: 9,
        astId: 102,
        type: 'address',
        name: 'somethingElse',
      },
    ]
    const result = observe(colliding)

    expect('ok' in result).toBe(false)
    if ('ok' in result) return
    expect(result.reason).toContain('claimed by both')
    expect(result.reason).toContain('Other.somethingElse')
  })

  it('accepts one astId declared twice under the same name, as an inherited immutable is', () => {
    const inherited: IImmutableDeclaration[] = [
      ...DECLARATIONS,
      {
        file: 'src/Helpers/Base.sol',
        contract: 'Base',
        line: 9,
        astId: 102,
        type: 'address',
        name: 'wrappedNative',
      },
    ]
    const result = observe(inherited)

    expect('ok' in result).toBe(true)
  })

  it('refuses when a declaration carries no astId at all', () => {
    const withoutId = DECLARATIONS.map(({ astId: _astId, ...rest }) => rest)
    const result = observe(withoutId)

    expect('ok' in result).toBe(false)
  })

  it('refuses when the copies of one immutable disagree', () => {
    const tampered = `${CODE.slice(0, 2 + 64 * 2)}${'cd'.repeat(
      32
    )}${CODE.slice(2 + 96 * 2)}`
    const result = observe(DECLARATIONS, tampered)

    expect('ok' in result).toBe(false)
    if ('ok' in result) return
    expect(result.reason).toContain('disagree')
  })

  it('reports nothing for a contract with no immutables', () => {
    const result = observeEvmImmutables(`0x${'ab'.repeat(32)}`, undefined, [])
    if (!('ok' in result)) throw new Error(result.reason)

    expect(result.observed).toEqual([])
  })
})

describe('priceImmutables', () => {
  it('verifies every slot the registry declares, leaving nothing unpriced', () => {
    const result = price([
      {
        name: 'spokePool',
        value: slot(SPOKE_POOL),
        slotByteCount: 32,
        byteCount: 64,
      },
      {
        name: 'wrappedNative',
        value: slot(WRAPPED_NATIVE),
        slotByteCount: 32,
        byteCount: 32,
      },
    ])
    if (!result.decided) throw new Error(result.reason)

    expect(result.disagreements).toEqual([])
    expect(result.pricedByteCount).toBe(96)
    expect(result.unpricedByteCount).toBe(0)
    expect(result.slots.map((one) => one.status)).toEqual([
      'verified',
      'verified',
    ])
    expect(result.slots[0]?.origin).toBe(
      'config/across.json.arbitrum.acrossSpokePool'
    )
  })

  it('flags the slot that holds an address config does not declare', () => {
    const attacker = '0x000000000000000000000000000000000000dEaD'
    const result = price([
      {
        name: 'spokePool',
        value: slot(attacker),
        slotByteCount: 32,
        byteCount: 64,
      },
      {
        name: 'wrappedNative',
        value: slot(WRAPPED_NATIVE),
        slotByteCount: 32,
        byteCount: 32,
      },
    ])
    if (!result.decided) throw new Error(result.reason)

    expect(result.disagreements.map((one) => one.name)).toEqual(['spokePool'])
    expect(result.disagreements[0]?.expected).toBe(slot(SPOKE_POOL))
    expect(result.disagreements[0]?.observed).toBe(slot(attacker))
    // The honest slot still counts: a disagreement is per slot, not per contract.
    expect(result.pricedByteCount).toBe(32)
    expect(result.disagreeingByteCount).toBe(64)
    // The three buckets account for every byte layer 1 masked.
    expect(
      result.pricedByteCount +
        result.unpricedByteCount +
        result.disagreeingByteCount
    ).toBe(96)
  })

  it('gives partial credit when one immutable of several is undeclared', () => {
    const result = price(
      [
        {
          name: 'spokePool',
          value: slot(SPOKE_POOL),
          slotByteCount: 32,
          byteCount: 64,
        },
        {
          name: 'wrappedNative',
          value: slot(WRAPPED_NATIVE),
          slotByteCount: 32,
          byteCount: 32,
        },
      ],
      {
        AcrossFacet: {
          configData: REQUIREMENTS.AcrossFacet?.configData,
          immutables: {
            spokePool: { source: 'config', configData: '_spokePool' },
          },
        },
      }
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.pricedByteCount).toBe(64)
    expect(result.unpricedByteCount).toBe(32)
    expect(result.slots[1]?.status).toBe('undeclared')
    expect(result.slots[1]?.detail).toContain('no registry entry')
  })

  it('prices a derived immutable as unaccounted for, never as a pass', () => {
    const result = price(
      [
        {
          name: 'wrappedNative',
          value: slot(WRAPPED_NATIVE),
          slotByteCount: 32,
          byteCount: 32,
        },
      ],
      {
        AcrossFacet: {
          immutables: {
            wrappedNative: {
              source: 'derived',
              rule: 'block.chainid == ARBITRUM_CHAIN_ID',
            },
          },
        },
      }
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('block.chainid')
    expect(result.pricedByteCount).toBe(0)
    expect(result.unpricedByteCount).toBe(32)
  })

  it('prices an explicitly exempted immutable with the reason it was exempted', () => {
    const result = price(
      [
        {
          name: 'wrappedNative',
          value: slot(WRAPPED_NATIVE),
          slotByteCount: 32,
          byteCount: 32,
        },
      ],
      {
        AcrossFacet: {
          immutables: {
            wrappedNative: {
              source: 'unchecked',
              reason: 'holds no authority and config declares no value',
            },
          },
        },
      }
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('holds no authority')
    expect(result.unpricedByteCount).toBe(32)
  })

  it('does not pass a config-sourced slot config has no value for', () => {
    const result = price(
      [
        {
          name: 'spokePool',
          value: slot(SPOKE_POOL),
          slotByteCount: 32,
          byteCount: 64,
        },
      ],
      REQUIREMENTS,
      'aurora'
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('has no value for aurora')
    expect(result.unpricedByteCount).toBe(64)
  })

  it('does not pass a config label the contract does not carry', () => {
    const result = price(
      [
        {
          name: 'spokePool',
          value: slot(SPOKE_POOL),
          slotByteCount: 32,
          byteCount: 64,
        },
      ],
      {
        AcrossFacet: {
          configData: REQUIREMENTS.AcrossFacet?.configData,
          immutables: {
            spokePool: { source: 'config', configData: '_notAnArg' },
          },
        },
      }
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('_notAnArg')
    expect(result.unpricedByteCount).toBe(64)
  })

  it('verifies a bytes32 slot holding a left-padded address, with no type rule', () => {
    // AcrossFacetV4 declares `bytes32 WRAPPED_NATIVE` and its deploy script
    // passes bytes32(uint256(uint160(addr))). The slot is the same width, so the
    // comparison is the same comparison.
    const result = priceImmutables(
      {
        contractName: 'AcrossFacetV4',
        observed: [
          {
            name: 'WRAPPED_NATIVE',
            value: slot(WRAPPED_NATIVE),
            slotByteCount: 32,
            byteCount: 32,
          },
        ],
        network: 'arbitrum',
        environment: 'production',
      },
      {
        AcrossFacetV4: {
          configData: {
            _wrappedNative: {
              configFileName: 'networks.json',
              keyInConfigFile: '.<NETWORK>.wrappedNativeAddress',
            },
          },
          immutables: {
            WRAPPED_NATIVE: { source: 'config', configData: '_wrappedNative' },
          },
        },
      },
      loader
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('verified')
    expect(result.unpricedByteCount).toBe(0)
  })

  it('does not pass a slot too narrow for the value config declares', () => {
    const result = price([
      {
        name: 'wrappedNative',
        value: '0xabcd',
        slotByteCount: 2,
        byteCount: 2,
      },
    ])
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('does not fit')
  })

  it('refuses an observation whose value is not one slot wide', () => {
    // A reader that hands over a value of some other width has disagreed with
    // the artifact, and then no slot is known to be the one being compared.
    const result = price([
      {
        name: 'spokePool',
        value: '0xdead',
        slotByteCount: 32,
        byteCount: 64,
      },
    ])

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('2 bytes')
    expect(result.reason).toContain('32-byte slot')
  })

  it('does not read a Tron base58 config value as a disagreement', () => {
    // config/networks.json gives .tron.wrappedNativeAddress in base58. Padding
    // it yields a value no slot can hold, and calling that a mismatch would
    // block a correctly deployed contract on every Tron chain.
    const result = priceImmutables(
      {
        contractName: 'AcrossFacet',
        observed: [
          {
            name: 'wrappedNative',
            value: slot(WRAPPED_NATIVE),
            slotByteCount: 32,
            byteCount: 32,
          },
        ],
        network: 'tron',
        environment: 'production',
      },
      REQUIREMENTS,
      () => ({
        tron: { wrappedNativeAddress: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR' },
      })
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('not hex')
    expect(result.disagreements).toEqual([])
    expect(result.unpricedByteCount).toBe(32)
  })

  it('grades one slot unpriceable rather than throwing on a malformed configData entry', () => {
    // resolveExpectedAddress reads keyInConfigFile.startsWith before testing it,
    // and validateImmutableRegistry checks only that the label exists.
    const result = price(
      [
        {
          name: 'spokePool',
          value: slot(SPOKE_POOL),
          slotByteCount: 32,
          byteCount: 64,
        },
      ],
      {
        AcrossFacet: {
          configData: {
            _spokePool: {
              configFileName: 'across.json',
            } as never,
          },
          immutables: {
            spokePool: { source: 'config', configData: '_spokePool' },
          },
        },
      }
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('unpriceable')
    expect(result.slots[0]?.detail).toContain('names no key within')
    expect(result.unpricedByteCount).toBe(64)
  })

  it('resolves the entry the shipped registry actually authors', () => {
    // The fixtures above stand in for the real files; this one reads them, so a
    // registry label that stops resolving cannot pass the suite.
    const observed = [
      {
        name: 'spokePool',
        value: slot(SPOKE_POOL),
        slotByteCount: 32,
        byteCount: 96,
      },
    ]
    const merged: DeployRequirements = {
      AcrossFacet: {
        ...(realRequirements as DeployRequirements).AcrossFacet,
        immutables: realRegistry.AcrossFacet,
      },
    }

    const result = priceImmutables(
      {
        contractName: 'AcrossFacet',
        observed,
        network: 'arbitrum',
        environment: 'production',
      },
      merged
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('verified')
    expect(result.slots[0]?.origin).toBe(
      'config/across.json.arbitrum.acrossSpokePool'
    )
  })

  it('treats a contract with no registry section as wholly undeclared', () => {
    const result = price(
      [
        {
          name: 'spokePool',
          value: slot(SPOKE_POOL),
          slotByteCount: 32,
          byteCount: 64,
        },
      ],
      {}
    )
    if (!result.decided) throw new Error(result.reason)

    expect(result.slots[0]?.status).toBe('undeclared')
    expect(result.unpricedByteCount).toBe(64)
  })
})
