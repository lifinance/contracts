/**
 * What the attestation key has to identify, and what it must never merge.
 *
 * Each test names one input and shows the key separates on it. The mirror
 * matters as much: an input that cannot change the bytecode must NOT separate,
 * or one build is filed under two keys and a lookup misses a build we made.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  artifactSettingsHash,
  configuredSettingsHash,
  findAttestationConflicts,
  identityFromArtifactMetadata,
  serialiseAttestationKey,
  sourceClosureHash,
  type IAttestationKey,
  type IMintedAttestation,
} from './attestation-key'

/**
 * A real artifact's `metadata.settings`, with the remappings list cut to one
 * entry. The hashed half is byte-for-byte what all 190 artifacts carrying
 * metadata in a real `out/` tree share — note there is no `viaIR` key: solc
 * emits it only when the IR pipeline ran, and `jq '{viaIR}'` renders that
 * absence as `null`, which is why the `null` reading is wrong.
 */
const ARTIFACT_SETTINGS: Record<string, unknown> = {
  remappings: ['ds-test/=lib/ds-test/src/'],
  optimizer: { enabled: true, runs: 1000000 },
  metadata: { bytecodeHash: 'ipfs' },
  compilationTarget: { 'src/Facets/AcrossFacetV4.sol': 'AcrossFacetV4' },
  evmVersion: 'cancun',
  libraries: {},
}

const HASHED_SETTINGS = {
  optimizer: { enabled: true, runs: 1000000 },
  metadata: { bytecodeHash: 'ipfs' },
  evmVersion: 'cancun',
  libraries: {},
}

const CLOSURE_A = sourceClosureHash([
  { path: 'src/Facets/AcrossFacetV4.sol', keccak: `0x${'11'.repeat(32)}` },
  { path: 'src/Helpers/SwapperV2.sol', keccak: `0x${'22'.repeat(32)}` },
])
/** The same closure with only the inherited helper changed. */
const CLOSURE_SWAPPER_BUMPED = sourceClosureHash([
  { path: 'src/Facets/AcrossFacetV4.sol', keccak: `0x${'11'.repeat(32)}` },
  { path: 'src/Helpers/SwapperV2.sol', keccak: `0x${'33'.repeat(32)}` },
])

const EVM: IAttestationKey = {
  contractName: 'AcrossFacetV4',
  sourceId: 'src/Facets/AcrossFacetV4.sol',
  version: '1.2.0',
  closureHash: CLOSURE_A,
  settingsHash: artifactSettingsHash(ARTIFACT_SETTINGS),
  settingsSource: 'artifact',
  solcVersion: '0.8.29',
}

const ZK_TOOLCHAIN = {
  zksolcVersion: '1.5.15',
  solcForkVersion: '0.8.29',
  llvmVersion: '1.0.2',
}

/**
 * zksolc reports no settings, so a zk key is `config`-tagged by construction —
 * an `artifact`-tagged zk key is a build that cannot exist. The settings object
 * stands in for whatever a zk producer configures; no shape is fixed yet, and
 * the closure a zk build needs has no reader either.
 */
const ZK: IAttestationKey = {
  ...EVM,
  settingsHash: configuredSettingsHash({
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 1000000 },
  }),
  settingsSource: 'config',
  zk: ZK_TOOLCHAIN,
}

const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`

const EVM_BUILD = {
  repo: 'contracts' as const,
  profile: 'default',
  hashedSettings: HASHED_SETTINGS,
}
const ZK_BUILD = { ...EVM_BUILD, profile: 'zksync' }

const minted = (
  key: IAttestationKey,
  maskedHash: string,
  build = EVM_BUILD
): IMintedAttestation => ({ key, build, maskedHash })

const settingsWith = (patch: Record<string, unknown>): string =>
  artifactSettingsHash({ ...ARTIFACT_SETTINGS, ...patch })

describe('serialiseAttestationKey', () => {
  it('separates on every input that can change the bytecode', () => {
    const base = serialiseAttestationKey(EVM)
    const differing: [string, IAttestationKey][] = [
      ['contract name', { ...EVM, contractName: 'AcrossFacetV5' }],
      ['source id', { ...EVM, sourceId: 'src/Periphery/AcrossFacetV4.sol' }],
      ['version', { ...EVM, version: '1.2.1' }],
      ['source closure', { ...EVM, closureHash: CLOSURE_SWAPPER_BUMPED }],
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

  it('separates a facet whose bytecode moved because a helper it inherits did', () => {
    // A facet inheriting a bumped helper changes bytecode while its own file,
    // version and settings stay put, so every key field but the closure hash
    // is identical across the two builds.
    const before = { ...EVM, closureHash: CLOSURE_A }
    const after = { ...EVM, closureHash: CLOSURE_SWAPPER_BUMPED }

    expect(before.version).toBe(after.version)
    expect(before.settingsHash).toBe(after.settingsHash)
    expect(serialiseAttestationKey(after)).not.toBe(
      serialiseAttestationKey(before)
    )
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

  it('keeps the three zk versions from smuggling into each other', () => {
    // The zk triple is length-prefixed inside the outer join, not concatenated.
    // These two toolchains flatten to one string under plain concatenation and
    // must not share a key.
    const a = serialiseAttestationKey({
      ...ZK,
      zk: {
        zksolcVersion: '1.5.15',
        solcForkVersion: '0.8.29',
        llvmVersion: '1.0.2',
      },
    })
    const b = serialiseAttestationKey({
      ...ZK,
      zk: {
        zksolcVersion: '1.5.1',
        solcForkVersion: '50.8.29',
        llvmVersion: '1.0.2',
      },
    })

    expect(a).not.toBe(b)
  })

  it('gives an EVM build a key a zk build cannot reach', () => {
    expect(serialiseAttestationKey(EVM)).toContain('3:evm')
    expect(serialiseAttestationKey(ZK)).not.toContain('3:evm')
  })

  it('files one build under one key when a hash drifts in case', () => {
    expect(
      serialiseAttestationKey({
        ...EVM,
        closureHash: EVM.closureHash.toUpperCase(),
        settingsHash: EVM.settingsHash.toUpperCase(),
      })
    ).toBe(serialiseAttestationKey(EVM))
  })

  it('fixes the field order itself rather than taking the object literal order', () => {
    const reordered: IAttestationKey = {
      solcVersion: EVM.solcVersion,
      settingsSource: EVM.settingsSource,
      settingsHash: EVM.settingsHash,
      closureHash: EVM.closureHash,
      version: EVM.version,
      sourceId: EVM.sourceId,
      contractName: EVM.contractName,
    }

    expect(serialiseAttestationKey(reordered)).toBe(
      serialiseAttestationKey(EVM)
    )
  })

  it('refuses a key that leaves an identifying field empty', () => {
    // Length-prefixing keeps these collision-free, but a key naming no contract
    // also strips every refusal in this module of the name it reports.
    for (const [field, patch] of [
      ['contract name', { contractName: '' }],
      ['source id', { sourceId: '' }],
      ['version', { version: '' }],
      ['solc version', { solcVersion: '' }],
    ] as const)
      expect(
        () => serialiseAttestationKey({ ...EVM, ...patch }),
        field
      ).toThrow(`attestation key states no ${field}`)
  })

  it('refuses a key whose hashes are not keccak digests', () => {
    // The key's own hashes were the only ones in this module reaching the
    // serialiser unvalidated, so nonsense became a plausible-looking key field.
    expect(() =>
      serialiseAttestationKey({ ...EVM, settingsHash: 'nope' })
    ).toThrow('settings hash is not hex in the key for AcrossFacetV4')
    expect(() =>
      serialiseAttestationKey({ ...EVM, closureHash: '0xdeadbeef' })
    ).toThrow('source closure hash is not 32 bytes')
    expect(() =>
      serialiseAttestationKey({ ...EVM, settingsHash: '0x' })
    ).toThrow('settings hash is empty')
  })
})

describe('settings hashing', () => {
  it('covers a setting no field list names', () => {
    // The reason for hashing rather than enumerating: each of these changes the
    // bytecode and no key field mentions any of them.
    for (const patch of [
      { optimizer: { runs: 1000000, details: { yul: false } } },
      { metadata: { bytecodeHash: 'none' } },
      { metadata: { bytecodeHash: 'none', appendCBOR: false } },
      { debug: { revertStrings: 'strip' } },
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
    const reversed = Object.fromEntries(
      Object.entries(ARTIFACT_SETTINGS).reverse()
    )

    expect(artifactSettingsHash(reversed)).toBe(EVM.settingsHash)
  })

  it('does not separate on the order of a nested settings object', () => {
    // Real settings are nested (`optimizer`, `metadata`, `libraries`), and the
    // config path is where a differently-ordered object comes from, so sorting
    // only the top level would still file one build under two keys.
    expect(settingsWith({ optimizer: { runs: 1000000, enabled: true } })).toBe(
      EVM.settingsHash
    )
    expect(
      settingsWith({
        libraries: { 'src/L.sol': { B: '0x02', A: '0x01' } },
      })
    ).toBe(
      settingsWith({
        libraries: { 'src/L.sol': { A: '0x01', B: '0x02' } },
      })
    )
  })

  it('separates on the order of a settings array', () => {
    // Arrays are ordered content, not emitter noise: `optimizerSteps` is a
    // sequence, so sorting or ignoring it would merge two different builds.
    expect(
      settingsWith({ optimizer: { details: { optimizerSteps: ['a', 'b'] } } })
    ).not.toBe(
      settingsWith({ optimizer: { details: { optimizerSteps: ['b', 'a'] } } })
    )
  })

  it('reads an absent setting and an explicitly null one as the same build', () => {
    expect(settingsWith({ viaIR: null })).toBe(EVM.settingsHash)
  })

  it('separates a build whose pipeline actually ran', () => {
    expect(settingsWith({ viaIR: true })).not.toBe(EVM.settingsHash)
  })

  it('ignores the fields that name the source rather than the settings', () => {
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

  it('cannot be made to produce a self-reported hash from configured values', () => {
    // The tag follows from which reader was used; no exported entry point lets
    // a caller choose it, so these are the only two hashes reachable.
    const both = new Set([
      artifactSettingsHash(ARTIFACT_SETTINGS),
      configuredSettingsHash(ARTIFACT_SETTINGS),
    ])

    expect(both.size).toBe(2)
  })

  it('refuses settings that identify no build', () => {
    expect(() => artifactSettingsHash({})).toThrow('empty')
    expect(() => configuredSettingsHash({})).toThrow('empty')
    // Everything present was stripped, so nothing is left to identify.
    expect(() =>
      artifactSettingsHash({ compilationTarget: {}, remappings: [] })
    ).toThrow('empty')
  })

  it('refuses settings that canonicalise away to nothing', () => {
    // These have keys to count, so a count check passes them, and then every
    // value is dropped as null — two unrelated objects would share one hash.
    for (const settings of [
      { evmVersion: null, optimizer: null },
      { viaIR: null, libraries: null, metadata: null },
      { compilationTarget: { 'src/A.sol': 'A' }, evmVersion: null },
    ])
      expect(
        () => artifactSettingsHash(settings),
        JSON.stringify(settings)
      ).toThrow('empty')
  })
})

describe('identityFromArtifactMetadata', () => {
  it('reads the source id and settings hash off a real artifact shape', () => {
    expect(identityFromArtifactMetadata(ARTIFACT_SETTINGS)).toEqual({
      sourceId: 'src/Facets/AcrossFacetV4.sol',
      settingsHash: EVM.settingsHash,
      settingsSource: 'artifact',
      hashedSettings: HASHED_SETTINGS,
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
    // Both of these flatten to the same character sequence under any
    // single-character delimiter, and to different ones here — the property
    // that does not rest on an assumption about what a source path contains.
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
    // The wrong-length cases are the realistic corruptions — a sliced hash, or
    // an address in a hash slot — and a framing check alone accepts them.
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
    // Every other fixture here feeds ascending hashes, where a sort is
    // indistinguishable from insertion order.
    const conflicts = findAttestationConflicts([
      minted(EVM, HASH_B),
      minted(EVM, HASH_A),
    ])

    expect(conflicts[0]?.maskedHashes).toEqual([HASH_B, HASH_A])
  })

  it('names the build readably, not only as a digest', () => {
    const [conflict] = findAttestationConflicts([
      minted(EVM, HASH_A),
      minted(EVM, HASH_B),
    ])

    expect(conflict?.key).toEqual(EVM)
    expect(conflict?.serialisedKey).toBe(serialiseAttestationKey(EVM))
    expect(conflict?.build.hashedSettings).toEqual(HASHED_SETTINGS)
  })

  it('reports the provenance of the first attestation, not the last', () => {
    const [conflict] = findAttestationConflicts([
      minted(EVM, HASH_A, { ...EVM_BUILD, profile: 'default' }),
      minted(EVM, HASH_B, { ...EVM_BUILD, profile: 'ci' }),
    ])

    expect(conflict?.build.profile).toBe('default')
  })

  it('hands back a refusal a caller can annotate without touching the input', () => {
    // Both halves of the payload nest an object — the settings, and the zk
    // toolchain — so a shallow copy would leave either one the caller's.
    const attestation = minted(ZK, HASH_A, ZK_BUILD)
    const [conflict] = findAttestationConflicts([
      attestation,
      minted(ZK, HASH_B, ZK_BUILD),
    ])

    expect(conflict?.build.hashedSettings).not.toBe(
      attestation.build.hashedSettings
    )
    expect(conflict?.key.zk).not.toBe(attestation.key.zk)
    expect(conflict?.key.zk).toEqual(ZK_TOOLCHAIN)
    ;(conflict?.build.hashedSettings as Record<string, unknown>)['evmVersion'] =
      'annotated'
    expect(attestation.build.hashedSettings['evmVersion']).toBe('cancun')
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
    // expected state, so this is what stops the check refusing everything.
    expect(
      findAttestationConflicts([minted(EVM, HASH_A), minted(EVM, HASH_A)])
    ).toEqual([])
  })

  it('does not report one build attested under two Foundry profiles', () => {
    // `[profile.ci]` inherits `[profile.default]` and differs only in fuzz
    // settings, so the two compile to the same bytes. The profile is carried as
    // provenance and not hashed into the key, so this is one entry.
    expect(
      findAttestationConflicts([
        minted(EVM, HASH_A),
        minted(EVM, HASH_A, { ...EVM_BUILD, profile: 'ci' }),
      ])
    ).toEqual([])
  })

  it('does not report two builds that differ only in their key', () => {
    expect(
      findAttestationConflicts([
        minted(EVM, HASH_A),
        minted(ZK, HASH_B, ZK_BUILD),
      ])
    ).toEqual([])
  })

  it('refuses an attestation whose masked hash is not a keccak digest', () => {
    expect(() => findAttestationConflicts([minted(EVM, 'nope')])).toThrow(
      'masked hash is not hex in the attestation for AcrossFacetV4'
    )
    expect(() => findAttestationConflicts([minted(EVM, '0xdeadbeef')])).toThrow(
      'masked hash is not 32 bytes'
    )
  })
})
