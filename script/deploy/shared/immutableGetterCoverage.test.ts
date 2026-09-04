import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  collectAnnotatedGetterKeys,
  collectPublicImmutableGetters,
  parsePublicImmutableGetters,
  UNANNOTATED_IMMUTABLE_GETTERS,
} from './immutableGetterCoverage'

describe('parsePublicImmutableGetters', () => {
  it('extracts an address-typed public immutable', () => {
    expect(
      parsePublicImmutableGetters('    address public immutable SPOKEPOOL;')
    ).toEqual([{ getter: 'SPOKEPOOL', solidityType: 'address' }])
  })

  it('extracts an interface-typed public immutable', () => {
    expect(
      parsePublicImmutableGetters('    IDlnSource public immutable DLN_SOURCE;')
    ).toEqual([{ getter: 'DLN_SOURCE', solidityType: 'IDlnSource' }])
  })

  it('extracts an address payable public immutable', () => {
    // PolymerCCTPFacet declares its fee receiver this way; a single-word type pattern misses it.
    expect(
      parsePublicImmutableGetters(
        '    address payable public immutable POLYMER_FEE_RECEIVER;'
      )
    ).toEqual([
      { getter: 'POLYMER_FEE_RECEIVER', solidityType: 'address payable' },
    ])
  })

  it('extracts a declaration with the specifiers in either order', () => {
    // Solidity accepts both orders, so a getter written the second way must not slip past.
    expect(
      parsePublicImmutableGetters('    address immutable public LATE_PUBLIC;')
    ).toEqual([{ getter: 'LATE_PUBLIC', solidityType: 'address' }])
  })

  it('extracts a declaration wrapped across lines', () => {
    expect(
      parsePublicImmutableGetters(
        '    IWrapped\n        public\n        immutable\n        WRAPPED;'
      )
    ).toEqual([{ getter: 'WRAPPED', solidityType: 'IWrapped' }])
  })

  it('extracts a declaration carrying an inline initializer', () => {
    // Solidity allows assigning at the declaration, which still generates the same getter.
    expect(
      parsePublicImmutableGetters(
        '    address public immutable ROUTER = SOME_CONSTANT;'
      )
    ).toEqual([{ getter: 'ROUTER', solidityType: 'address' }])
  })

  it('skips value-typed immutables, which cannot hold a counterparty address', () => {
    expect(
      parsePublicImmutableGetters(`
        bytes32 public immutable NAMESPACE;
        uint256 public immutable RECOVER_GAS;
        uint8 public immutable DECIMALS;
        bool public immutable IS_NATIVE;
      `)
    ).toEqual([])
  })

  it('skips immutables with no public getter to read', () => {
    expect(
      parsePublicImmutableGetters(`
        address private immutable spokePool;
        IExecutor internal immutable executor;
      `)
    ).toEqual([])
  })

  it('skips constants and mutable state variables', () => {
    expect(
      parsePublicImmutableGetters(`
        address public constant NATIVE = address(0);
        address public owner;
      `)
    ).toEqual([])
  })
})

describe('collectPublicImmutableGetters', () => {
  const declared = collectPublicImmutableGetters()
  const keys = declared.map((d) => `${d.contractName}.${d.getter}`)

  it('finds every getter the invariant already annotates', () => {
    // Calibration: the scan must re-derive all shipped annotations, so that a Solidity style the
    // regex cannot read fails here instead of silently shrinking the gate's reach.
    const annotated = [...collectAnnotatedGetterKeys()].sort()
    expect(annotated.length).toBeGreaterThan(0)
    expect(keys).toEqual(expect.arrayContaining(annotated))
  })

  it('finds getters that no annotation covers yet', () => {
    expect(keys).toContain('AcrossFacetV4.SPOKEPOOL')
    expect(keys).toContain('PolymerCCTPFacet.POLYMER_FEE_RECEIVER')
  })

  it('ignores immutables that expose no public getter', () => {
    expect(keys).not.toContain('AcrossFacet.spokePool')
    expect(keys).not.toContain('SquidFacet.squidRouter')
  })

  it('reports the source file each getter was found in', () => {
    const spokepool = declared.find(
      (d) => `${d.contractName}.${d.getter}` === 'ReceiverAcrossV4.SPOKEPOOL'
    )
    expect(spokepool?.sourceFile).toBe('src/Periphery/ReceiverAcrossV4.sol')
  })
})

describe('immutable getter coverage gate', () => {
  const declared = collectPublicImmutableGetters()
  const annotated = collectAnnotatedGetterKeys()

  it('leaves no public immutable address getter unaccounted for', () => {
    // Every getter is either checked by `immutable-bindings-match-config` or carries a recorded
    // reason why it is not. A new contract lands in neither set, so this fails until its author
    // annotates the binding or states why it cannot be.
    const exempt = new Set(Object.keys(UNANNOTATED_IMMUTABLE_GETTERS))
    const unaccounted = declared
      .map((d) => `${d.contractName}.${d.getter}`)
      .filter((key) => !annotated.has(key) && !exempt.has(key))
    expect(unaccounted).toEqual([])
  })

  it('holds no exemption for a getter that is now annotated', () => {
    const superseded = Object.keys(UNANNOTATED_IMMUTABLE_GETTERS).filter(
      (key) => annotated.has(key)
    )
    expect(superseded).toEqual([])
  })

  it('holds no exemption for a getter that no longer exists', () => {
    // Keeps the list shrinking: a renamed or deleted getter must be dropped from it, so the list
    // never accumulates dead entries that hide how much is actually unverified.
    const declaredKeys = new Set(
      declared.map((d) => `${d.contractName}.${d.getter}`)
    )
    const stale = Object.keys(UNANNOTATED_IMMUTABLE_GETTERS).filter(
      (key) => !declaredKeys.has(key)
    )
    expect(stale).toEqual([])
  })

  it('gives every exemption a non-empty reason', () => {
    const blank = Object.entries(UNANNOTATED_IMMUTABLE_GETTERS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([key]) => key)
    expect(blank).toEqual([])
  })
})

describe('collectPublicImmutableGetters directory handling', () => {
  it('recurses into subdirectories and names contracts after their file', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'immutable-getters-'))
    try {
      mkdirSync(join(root, 'nested'))
      writeFileSync(
        join(root, 'nested', 'NestedFacet.sol'),
        'contract NestedFacet {\n    INested public immutable NESTED;\n}\n'
      )
      expect(collectPublicImmutableGetters([root])).toEqual([
        {
          contractName: 'NestedFacet',
          getter: 'NESTED',
          solidityType: 'INested',
          sourceFile: join(root, 'nested', 'NestedFacet.sol'),
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('yields nothing for a directory that does not exist', () => {
    expect(collectPublicImmutableGetters(['src/DoesNotExist'])).toEqual([])
  })
})
