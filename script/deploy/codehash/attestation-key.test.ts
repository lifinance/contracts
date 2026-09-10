/**
 * What the attestation key has to identify, and what it must never merge.
 *
 * The gate looks a build up by this key, so any input the key omits lets two
 * different builds share one entry — and the set-membership compare then
 * answers about a build the deployed code is not. Each test here names one
 * input and shows the key separates on it. The mirror matters as much: an input
 * that cannot change the bytecode must NOT separate, or one build is filed
 * under two keys and a lookup misses a build we made.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildSettingsHash,
  configuredSettingsHash,
  findAttestationConflicts,
  identityFromArtifactMetadata,
  serialiseAttestationKey,
  sourceClosureHash,
  type IAttestationKey,
  type IMintedAttestation,
} from './attestation-key'

/**
 * Verbatim `metadata.settings` of a real `out/` artifact. All 193 in a real
 * tree carry exactly this shape — note there is no `viaIR` key: solc emits it
 * only when the IR pipeline ran. `jq '{viaIR}'` renders that absence as
 * `null`, which is why the `null` reading is easy to reach and wrong.
 */
const ARTIFACT_SETTINGS: Record<string, unknown> = {
  remappings: ['ds-test/=lib/forge-std/lib/ds-test/src/'],
  optimizer: { enabled: true, runs: 1000000 },
  metadata: { bytecodeHash: 'ipfs' },
  compilationTarget: { 'src/Facets/CBridgeFacet.sol': 'CBridgeFacet' },
  evmVersion: 'cancun',
  libraries: {},
}

const EVM: IAttestationKey = {
  contractName: 'CBridgeFacet',
  sourceId: 'src/Facets/CBridgeFacet.sol',
  repo: 'contracts',
  version: '1.2.0',
  settingsHash: buildSettingsHash('artifact', ARTIFACT_SETTINGS),
  settingsSource: 'artifact',
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

const BUILD = { profile: 'default', settings: ARTIFACT_SETTINGS }

const minted = (
  key: IAttestationKey,
  maskedHash: string,
  closure = CLOSURE_A
): IMintedAttestation => ({
  key,
  build: BUILD,
  maskedHash,
  sourceClosureHash: closure,
})

/** The artifact settings with one field changed, as a producer would see it. */
const settingsWith = (patch: Record<string, unknown>): string =>
  buildSettingsHash('artifact', { ...ARTIFACT_SETTINGS, ...patch })

describe('serialiseAttestationKey', () => {
  it('separates on every input that can change the bytecode', () => {
    const base = serialiseAttestationKey(EVM)
    const differing: [string, IAttestationKey][] = [
      ['contract name', { ...EVM, contractName: 'CBridgeFacetV2' }],
      ['source id', { ...EVM, sourceId: 'src/Periphery/CBridgeFacet.sol' }],
      ['repo', { ...EVM, repo: 'contracts-tron' }],
      ['version', { ...EVM, version: '1.2.1' }],
      ['solc version', { ...EVM, solcVersion: '0.8.30' }],
      [
        'settings',
        { ...EVM, settingsHash: settingsWith({ evmVersion: 'prague' }) },
      ],
      ['settings source', { ...EVM, settingsSource: 'config' }],
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

  it('files one build under one key when the settings hash drifts in case', () => {
    expect(
      serialiseAttestationKey({
        ...EVM,
        settingsHash: EVM.settingsHash.toUpperCase(),
      })
    ).toBe(serialiseAttestationKey(EVM))
  })

  it('fixes the field order itself rather than taking the object literal order', () => {
    // A serialiser reading the object's own key order would give one build two
    // keys, depending on how the caller happened to construct it.
    const reordered: IAttestationKey = {
      solcVersion: EVM.solcVersion,
      settingsSource: EVM.settingsSource,
      settingsHash: EVM.settingsHash,
      version: EVM.version,
      repo: EVM.repo,
      sourceId: EVM.sourceId,
      contractName: EVM.contractName,
    }

    expect(serialiseAttestationKey(reordered)).toBe(
      serialiseAttestationKey(EVM)
    )
  })
})

describe('buildSettingsHash', () => {
  it('covers a setting no field list names', () => {
    // The whole reason for hashing rather than enumerating: these three change
    // the bytecode and no key field mentions any of them.
    for (const patch of [
      { optimizer: { runs: 1000000, details: { yul: false } } },
      { metadata: { bytecodeHash: 'none' } },
      { metadata: { bytecodeHash: 'ipfs', appendCBOR: false } },
      {
        libraries: {
          'src/L.sol': { L: '0x0000000000000000000000000000000000000001' },
        },
      },
    ])
      expect(settingsWith(patch), JSON.stringify(patch)).not.toBe(
        EVM.settingsHash
      )
  })

  it('does not separate on the order the compiler emitted the settings', () => {
    // Key order is an artefact of the emitter, so a hash that depended on it
    // would file one build under two keys.
    const reversed = Object.fromEntries(
      Object.entries(ARTIFACT_SETTINGS).reverse()
    )

    expect(buildSettingsHash('artifact', reversed)).toBe(EVM.settingsHash)
  })

  it('reads an absent setting and an explicitly null one as the same build', () => {
    // solc omits `viaIR` for a legacy build; a JSON reader that fills absent
    // keys hands over null. Both describe one build.
    expect(settingsWith({ viaIR: null })).toBe(EVM.settingsHash)
  })

  it('separates a build whose pipeline actually ran', () => {
    expect(settingsWith({ viaIR: true })).not.toBe(EVM.settingsHash)
  })

  it('ignores the fields that describe the source rather than the settings', () => {
    // `compilationTarget` is the source identity and is carried as `sourceId`;
    // remappings decide what an import resolves to, and the resolved sources
    // are covered by the closure hash. Hashing either would split the key for
    // identical bytecode.
    expect(
      settingsWith({
        compilationTarget: { 'src/Other.sol': 'Other' },
        remappings: ['totally/=different/'],
      })
    ).toBe(EVM.settingsHash)
  })

  it('separates configured settings from self-reported ones', () => {
    // A zk build's settings are a claim about what we asked for, so they must
    // not answer a lookup for a build that reported its own.
    expect(configuredSettingsHash(ARTIFACT_SETTINGS)).not.toBe(EVM.settingsHash)
  })

  it('refuses settings that identify no build', () => {
    expect(() => buildSettingsHash('artifact', {})).toThrow('empty')
    // Everything present was stripped, so there is nothing left to identify.
    expect(() =>
      buildSettingsHash('artifact', { compilationTarget: {}, remappings: [] })
    ).toThrow('empty')
  })
})

describe('identityFromArtifactMetadata', () => {
  it('reads the source id and settings hash off a real artifact shape', () => {
    expect(identityFromArtifactMetadata(ARTIFACT_SETTINGS)).toEqual({
      sourceId: 'src/Facets/CBridgeFacet.sol',
      settingsHash: EVM.settingsHash,
      settingsSource: 'artifact',
      settings: {
        optimizer: { enabled: true, runs: 1000000 },
        metadata: { bytecodeHash: 'ipfs' },
        evmVersion: 'cancun',
        libraries: {},
      },
    })
  })

  it('separates two contracts that share a name', () => {
    // Real: two unrelated IPool contracts live in src/Periphery/, with the
    // same name, version and settings and different code.
    const aggregator = identityFromArtifactMetadata({
      ...ARTIFACT_SETTINGS,
      compilationTarget: { 'src/Periphery/LiFiDEXAggregator.sol': 'IPool' },
    })
    const receiver = identityFromArtifactMetadata({
      ...ARTIFACT_SETTINGS,
      compilationTarget: { 'src/Periphery/ReceiverStargateV2.sol': 'IPool' },
    })

    expect(aggregator.sourceId).not.toBe(receiver.sourceId)
  })

  it('refuses an artifact that does not name exactly one compilation target', () => {
    for (const compilationTarget of [
      undefined,
      {},
      { 'src/A.sol': 'A', 'src/B.sol': 'B' },
    ])
      expect(
        () =>
          identityFromArtifactMetadata({
            ...ARTIFACT_SETTINGS,
            compilationTarget,
          }),
        JSON.stringify(compilationTarget)
      ).toThrow('compilation target')
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

  it('refuses a source hash that is not a keccak digest', () => {
    // Without this an unset or garbled hash hashes into the closure without
    // complaint, and the audit bridge points at a plausible-looking digest of
    // nonsense. The wrong-length cases are the realistic ones — a sliced hash,
    // or an address in a hash slot — and a framing check alone accepts them.
    for (const keccak of [
      '',
      '0x',
      'nope',
      `${HASH_A}a`,
      '0xdeadbeef',
      `0x${'11'.repeat(20)}`,
      `0x${'aa'.repeat(33)}`,
    ])
      expect(
        () => sourceClosureHash([{ path: 'src/Facets/A.sol', keccak }]),
        keccak
      ).toThrow('source hash for src/Facets/A.sol')
  })

  it('refuses an entry that names no path', () => {
    // The path is the other half of the pair, and a nameless entry silently
    // becomes a closure member no audit can be traced back to.
    expect(() => sourceClosureHash([{ path: '', keccak: HASH_A }])).toThrow(
      'no path'
    )
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

  it('reports the hashes in the order found, not sorted', () => {
    // The field is documented as first-seen order, and every other fixture
    // here happens to feed ascending hashes, where a sort is indistinguishable.
    const conflicts = findAttestationConflicts([
      minted(EVM, HASH_B),
      minted(EVM, HASH_A),
    ])

    expect(conflicts[0]?.maskedHashes).toEqual([HASH_B, HASH_A])
  })

  it('names the build readably, not only as a digest', () => {
    // A signer has to refuse on this, so the refusal has to say which settings
    // without a human reversing a hash.
    const [conflict] = findAttestationConflicts([
      minted(EVM, HASH_A),
      minted(EVM, HASH_B),
    ])

    expect(conflict?.key).toEqual(EVM)
    expect(conflict?.serialisedKey).toBe(serialiseAttestationKey(EVM))
    expect(conflict?.build.profile).toBe('default')
    expect(conflict?.build.settings).toEqual(ARTIFACT_SETTINGS)
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

  it('does not report one build attested under two Foundry profiles', () => {
    // `[profile.ci]` inherits `[profile.default]` and differs only in fuzz
    // settings, so the two compile to the same bytes. The profile is carried as
    // provenance and not hashed into the key, so this is one entry.
    const underCi: IMintedAttestation = {
      ...minted(EVM, HASH_A),
      build: { profile: 'ci', settings: ARTIFACT_SETTINGS },
    }

    expect(findAttestationConflicts([minted(EVM, HASH_A), underCi])).toEqual([])
  })

  it('does not report two builds that differ only in their key', () => {
    // The zk build and the EVM build legitimately have different bytecode;
    // they are separate entries, not a contradiction.
    expect(
      findAttestationConflicts([minted(EVM, HASH_A), minted(ZK, HASH_B)])
    ).toEqual([])
  })

  it('refuses an attestation whose hashes are not keccak digests', () => {
    expect(() => findAttestationConflicts([minted(EVM, 'nope')])).toThrow(
      'masked hash is not hex in the attestation for CBridgeFacet'
    )
    expect(() => findAttestationConflicts([minted(EVM, HASH_A, '0x')])).toThrow(
      'source closure hash is empty'
    )
    expect(() => findAttestationConflicts([minted(EVM, '0xdeadbeef')])).toThrow(
      'masked hash is not 32 bytes'
    )
  })
})
