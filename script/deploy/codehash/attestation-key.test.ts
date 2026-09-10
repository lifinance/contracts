/**
 * What the attestation key has to identify, and what it must never merge.
 *
 * The gate looks a build up by this key, so any input the key omits lets two
 * different builds share one entry — and the set-membership compare then
 * answers about a build the deployed code is not. Each test here names one
 * input and shows the key separates on it.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildSettingsFromMetadata,
  findAttestationConflicts,
  serialiseAttestationKey,
  sourceClosureHash,
  type IAttestationKey,
  type IMintedAttestation,
} from './attestation-key'

const EVM: IAttestationKey = {
  contractName: 'CBridgeFacet',
  version: '1.2.0',
  profile: 'default',
  evmVersion: 'cancun',
  viaIR: true,
  optimizerRuns: 1000000,
  solcVersion: '0.8.29',
}

/** Named separately so the tests below can vary one version without a cast. */
const ZK_TOOLCHAIN = {
  zksolcVersion: '1.5.15',
  solcForkVersion: '0.8.29',
  llvmVersion: '1.0.2',
}

const ZK: IAttestationKey = { ...EVM, zk: ZK_TOOLCHAIN }

const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const CLOSURE_A = `0x${'11'.repeat(32)}`
const CLOSURE_B = `0x${'22'.repeat(32)}`

const minted = (
  key: IAttestationKey,
  maskedHash: string,
  closure = CLOSURE_A
): IMintedAttestation => ({ key, maskedHash, sourceClosureHash: closure })

describe('serialiseAttestationKey', () => {
  it('separates on every input that can change the bytecode', () => {
    const base = serialiseAttestationKey(EVM)
    const { optimizerRuns: _dropped, ...noOptimizer } = EVM
    const differing: [string, IAttestationKey][] = [
      ['contract name', { ...EVM, contractName: 'CBridgeFacetV2' }],
      ['version', { ...EVM, version: '1.2.1' }],
      ['profile', { ...EVM, profile: 'ci' }],
      ['evm version', { ...EVM, evmVersion: 'prague' }],
      ['pipeline', { ...EVM, viaIR: false }],
      ['optimizer runs', { ...EVM, optimizerRuns: 200 }],
      ['optimizer off', noOptimizer],
      ['solc version', { ...EVM, solcVersion: '0.8.30' }],
      ['zk toolchain', ZK],
    ]

    for (const [what, key] of differing)
      expect(serialiseAttestationKey(key), what).not.toBe(base)
  })

  it('separates two zk builds that differ only below zksolc', () => {
    // F14: the solc fork and LLVM version float independently of the zksolc
    // release, so naming zksolc alone does not identify the build.
    const forkMoved = serialiseAttestationKey({
      ...ZK,
      zk: { ...ZK_TOOLCHAIN, solcForkVersion: '0.8.30' },
    })
    const llvmMoved = serialiseAttestationKey({
      ...ZK,
      zk: { ...ZK_TOOLCHAIN, llvmVersion: '1.0.3' },
    })

    expect(forkMoved).not.toBe(serialiseAttestationKey(ZK))
    expect(llvmMoved).not.toBe(serialiseAttestationKey(ZK))
    expect(forkMoved).not.toBe(llvmMoved)
  })

  it('gives an EVM build a key a zk build cannot reach', () => {
    // The absent zk section is written as a marker, not skipped: a key that
    // shortens when a field is missing is a key two builds can share.
    expect(serialiseAttestationKey(EVM)).toContain('3:evm')
    expect(serialiseAttestationKey(ZK)).not.toContain('3:evm')
  })

  it('writes a marker for an absent optimizer rather than shortening', () => {
    const { optimizerRuns: _dropped, ...noOptimizer } = EVM

    expect(serialiseAttestationKey(noOptimizer)).toContain('5:noopt')
    expect(serialiseAttestationKey(EVM)).not.toContain('5:noopt')
  })

  it('fixes the field order itself rather than taking the object literal order', () => {
    // A serialiser reading the object's own key order would give one build two
    // keys, depending on how the caller happened to construct it.
    const reordered: IAttestationKey = {
      solcVersion: EVM.solcVersion,
      optimizerRuns: EVM.optimizerRuns,
      viaIR: EVM.viaIR,
      evmVersion: EVM.evmVersion,
      profile: EVM.profile,
      version: EVM.version,
      contractName: EVM.contractName,
    }

    expect(serialiseAttestationKey(reordered)).toBe(
      serialiseAttestationKey(EVM)
    )
  })
})

describe('buildSettingsFromMetadata', () => {
  const SETTINGS = {
    evmVersion: 'cancun',
    viaIR: null,
    optimizer: { enabled: true, runs: 1000000 },
  }

  it('reads solc null viaIR as a legacy build', () => {
    // What a real artifact carries: solc writes null, not false, for a pipeline
    // that did not run. Two producers each mapping that themselves is the bug
    // this helper exists to hold in one place.
    expect(buildSettingsFromMetadata(SETTINGS)).toEqual({
      evmVersion: 'cancun',
      viaIR: false,
      optimizerRuns: 1000000,
    })
  })

  it('reads an IR build as viaIR', () => {
    expect(buildSettingsFromMetadata({ ...SETTINGS, viaIR: true }).viaIR).toBe(
      true
    )
  })

  it('omits the run count when the optimizer did not run', () => {
    // A run count cannot move bytecode the optimizer never touched, so naming
    // it would file two identical builds under different keys.
    expect(
      buildSettingsFromMetadata({
        ...SETTINGS,
        optimizer: { enabled: false, runs: 200 },
      })
    ).toEqual({ evmVersion: 'cancun', viaIR: false })
  })

  it('refuses an artifact that does not state its evm version', () => {
    // Assuming solc's default files the build under a key naming a setting the
    // build may not have used.
    expect(() =>
      buildSettingsFromMetadata({ ...SETTINGS, evmVersion: undefined })
    ).toThrow('evmVersion')
  })

  it('refuses an artifact that does not state its optimizer settings', () => {
    expect(() =>
      buildSettingsFromMetadata({ ...SETTINGS, optimizer: undefined })
    ).toThrow('optimizer settings')
  })

  it('refuses an enabled optimizer with no run count', () => {
    expect(() =>
      buildSettingsFromMetadata({
        ...SETTINGS,
        optimizer: { enabled: true, runs: null },
      })
    ).toThrow('run count')
  })
})

describe('sourceClosureHash', () => {
  it('does not depend on the order solc emitted the sources', () => {
    const forward = sourceClosureHash([
      { path: 'src/Facets/A.sol', keccak: HASH_A },
      { path: 'src/Facets/B.sol', keccak: HASH_B },
    ])
    const reversed = sourceClosureHash([
      { path: 'src/Facets/B.sol', keccak: HASH_B },
      { path: 'src/Facets/A.sol', keccak: HASH_A },
    ])

    expect(forward).toBe(reversed)
  })

  it('separates a closure whose paths are the same but content is not', () => {
    const original = sourceClosureHash([
      { path: 'src/Facets/A.sol', keccak: HASH_A },
    ])
    const edited = sourceClosureHash([
      { path: 'src/Facets/A.sol', keccak: HASH_B },
    ])

    expect(edited).not.toBe(original)
  })

  it('separates two closures a delimiter-joined hash would merge', () => {
    // Fields are length-prefixed, not delimited, so a path cannot contain the
    // boundary and impersonate the next pair. Both of these flatten to the same
    // character sequence under any single-character delimiter, and to different
    // ones here. This is the property that does not rest on an assumption about
    // what a source path may contain.
    const split = sourceClosureHash([
      { path: 'A', keccak: HASH_A },
      { path: 'B', keccak: HASH_B },
    ])
    const smuggled = sourceClosureHash([
      { path: `A${HASH_A}B`, keccak: HASH_B },
    ])

    expect(smuggled).not.toBe(split)
  })

  it('refuses a closure that names one path twice with different hashes', () => {
    // Picking a winner would hash a closure that was never compiled, so the
    // audit bridge would vouch for source the build did not use.
    expect(() =>
      sourceClosureHash([
        { path: 'src/Facets/A.sol', keccak: HASH_A },
        { path: 'src/Facets/A.sol', keccak: HASH_B },
      ])
    ).toThrow('twice with different hashes')
  })

  it('accepts the same path twice when the hashes agree', () => {
    // Paired present: a duplicate entry is only fatal when it disagrees.
    expect(
      sourceClosureHash([
        { path: 'src/Facets/A.sol', keccak: HASH_A },
        { path: 'src/Facets/A.sol', keccak: HASH_A },
      ])
    ).toBe(sourceClosureHash([{ path: 'src/Facets/A.sol', keccak: HASH_A }]))
  })

  it('treats case-drifted identical hashes as the same source', () => {
    expect(
      sourceClosureHash([
        { path: 'src/Facets/A.sol', keccak: HASH_A },
        { path: 'src/Facets/A.sol', keccak: HASH_A.toUpperCase() },
      ])
    ).toBe(sourceClosureHash([{ path: 'src/Facets/A.sol', keccak: HASH_A }]))
  })

  it('refuses a source hash that is not framed hex', () => {
    // Without the frame check an unset or garbled hash hashes into the closure
    // without complaint, and the audit bridge points at a plausible-looking
    // digest of nonsense.
    for (const keccak of ['', '0x', 'nope', `${HASH_A}a`])
      expect(
        () => sourceClosureHash([{ path: 'src/Facets/A.sol', keccak }]),
        keccak
      ).toThrow('source hash for src/Facets/A.sol')
  })
})

describe('findAttestationConflicts', () => {
  it('reports one key claimed by two different bytecodes', () => {
    const conflicts = findAttestationConflicts([
      minted(EVM, HASH_A),
      minted(EVM, HASH_B),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.maskedHashes).toEqual([HASH_A, HASH_B])
  })

  it('names the conflicting build structurally, not only serialised', () => {
    // The caller has to refuse on this, so the refusal has to be legible
    // without a human parsing the length-prefixed form.
    const [conflict] = findAttestationConflicts([
      minted(EVM, HASH_A),
      minted(EVM, HASH_B),
    ])

    expect(conflict?.key).toEqual(EVM)
    expect(conflict?.serialisedKey).toBe(serialiseAttestationKey(EVM))
  })

  it('reports one bytecode attested from two different source closures', () => {
    // As disqualifying as the reverse: the audit bridge then points at two
    // different bodies of source for one build.
    const conflicts = findAttestationConflicts([
      minted(EVM, HASH_A, CLOSURE_A),
      minted(EVM, HASH_A, CLOSURE_B),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.sourceClosureHashes).toEqual([CLOSURE_A, CLOSURE_B])
  })

  it('does not report the same hash written in different case', () => {
    expect(
      findAttestationConflicts([
        minted(EVM, HASH_A),
        minted(EVM, HASH_A.toUpperCase()),
      ])
    ).toEqual([])
  })

  it('does not report the same build attested twice', () => {
    // Paired present: CI and a local rebuild filing identical results is the
    // expected state, not a conflict, so this is what stops the check from
    // simply refusing everything.
    expect(
      findAttestationConflicts([minted(EVM, HASH_A), minted(EVM, HASH_A)])
    ).toEqual([])
  })

  it('does not report two builds that differ only in their key', () => {
    // The zk build and the EVM build legitimately have different bytecode;
    // they are separate entries, not a contradiction.
    expect(
      findAttestationConflicts([minted(EVM, HASH_A), minted(ZK, HASH_B)])
    ).toEqual([])
  })

  it('refuses an attestation whose hashes are not framed hex', () => {
    expect(() => findAttestationConflicts([minted(EVM, 'nope')])).toThrow(
      'masked hash is not hex in the attestation for CBridgeFacet'
    )
    expect(() => findAttestationConflicts([minted(EVM, HASH_A, '0x')])).toThrow(
      'source closure hash is empty'
    )
  })
})
