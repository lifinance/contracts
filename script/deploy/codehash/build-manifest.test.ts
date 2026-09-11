/**
 * What the minted manifest must guarantee for its attestation to mean anything:
 * byte-stability, one build per key, and an honest record of what was minted.
 * `build-manifest.ts` states why each of those is load-bearing.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  serialiseAttestationKey,
  sourceClosureHash,
  type IAttestationKey,
} from './attestation-key'
import {
  ManifestConflictError,
  manifestEntryFrom,
  serialiseManifest,
  MANIFEST_SCHEMA,
  type IBuildManifest,
  type IContractIdentity,
  type IManifestEntry,
  type IMintProfile,
} from './build-manifest'
import { normalizeRuntimeCode } from './rebuild-attestations'

const CLOSURE = sourceClosureHash([
  { path: 'src/Periphery/FeeForwarder.sol', keccak: `0x${'11'.repeat(32)}` },
])
const SETTINGS_HASH = `0x${'22'.repeat(32)}`

const IDENTITY: IContractIdentity = {
  contractName: 'FeeForwarder',
  version: '1.0.0',
  repo: 'contracts',
}

const DEFAULT_PROFILE: IMintProfile = {
  profile: 'default',
  solcVersion: '0.8.29',
  evmVersion: 'cancun',
}

const ZK_PROFILE: IMintProfile = {
  profile: 'zksync',
  solcVersion: '0.8.29',
  evmVersion: 'cancun',
  zksolcVersion: '1.5.15',
}

const HASHED_SETTINGS = {
  evmVersion: 'cancun',
  optimizer: { enabled: true, runs: 1000000 },
}

/** Runtime code with no metadata trailer, so the profile pin supplies solc. */
const CODE_A = `0x${'60'.repeat(40)}`
const CODE_B = `0x${'61'.repeat(40)}`

const keyFor = (overrides: Partial<IAttestationKey> = {}): IAttestationKey => ({
  contractName: 'FeeForwarder',
  sourceId: 'src/Periphery/FeeForwarder.sol',
  version: '1.0.0',
  closureHash: CLOSURE,
  settingsHash: SETTINGS_HASH,
  settingsSource: 'artifact',
  solcVersion: '0.8.29',
  ...overrides,
})

const entryFor = (
  key: IAttestationKey,
  runtimeHex: string,
  profile: IMintProfile = DEFAULT_PROFILE
): IManifestEntry => {
  const built = manifestEntryFrom(
    IDENTITY,
    key,
    profile,
    { runtimeHex },
    HASHED_SETTINGS
  )
  if (!built.ok) throw new Error(`fixture did not build: ${built.reason}`)
  return built.entry
}

describe('manifestEntryFrom', () => {
  it('normalises exactly as the rebuild path does, so the two are comparable', () => {
    const refs = { a: [{ start: 4, length: 32 }] }
    const built = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      { runtimeHex: CODE_A, immutableReferences: refs },
      HASHED_SETTINGS
    )
    const rebuilt = normalizeRuntimeCode(CODE_A, refs, { isZk: false })

    expect(built.ok).toBe(true)
    expect(rebuilt.ok).toBe(true)
    if (!built.ok || !rebuilt.ok) return
    // The comparison downstream is between these two hashes. If the mint ever
    // normalises differently from the rebuild, every A-CI verdict is answering
    // about bytes the other side never looked at.
    expect(built.entry.maskedHash).toBe(rebuilt.maskedHash)
    expect(built.entry.rawByteLength).toBe(rebuilt.rawByteLength)
  })

  it('refuses a zkEVM profile rather than minting an entry under it', () => {
    const refused = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      ZK_PROFILE,
      { runtimeHex: CODE_A },
      HASHED_SETTINGS
    )
    expect(refused.ok).toBe(false)
    // The normalisation below strips the trailer, which on zkEVM is the only
    // place the solc-fork and LLVM versions live — so an entry minted here
    // would file two different zk toolchains under one hash.
    expect(refused.ok === false && refused.reason).toContain('zkEVM')
    expect(entryFor(keyFor(), CODE_A).lineage).toContain('default: solc')
  })

  it('carries the immutable offsets a reader needs to mask deployed code', () => {
    const built = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      {
        runtimeHex: CODE_A,
        immutableReferences: { owner: [{ start: 8, length: 32 }] },
      },
      HASHED_SETTINGS
    )
    if (!built.ok) throw new Error(built.reason)
    // Without these a lookup can verify the manifest and still be unable to use
    // it: nothing else says which deployed bytes to exclude before comparing.
    expect(built.entry.immutableOffsets).toEqual([{ start: 8, length: 32 }])
  })

  it('records offsets in a form two compilation scopes agree on', () => {
    // An AST id counts source units in load order, so building the same
    // contract alongside a different set renumbers it. Keyed by that id, two
    // honest machines mint two manifests and the attested digest stops
    // surviving a rebuild.
    const laptop = {
      '1927': [{ start: 20, length: 4 }],
      '1930': [{ start: 4, length: 4 }],
    }
    const runner = {
      '103206': [{ start: 20, length: 4 }],
      '103209': [{ start: 4, length: 4 }],
    }
    const entryOf = (
      refs: Record<string, { start: number; length: number }[]>
    ) =>
      manifestEntryFrom(
        IDENTITY,
        keyFor(),
        DEFAULT_PROFILE,
        { runtimeHex: CODE_A, immutableReferences: refs },
        HASHED_SETTINGS
      )

    const a = entryOf(laptop)
    const b = entryOf(runner)
    if (!a.ok || !b.ok) throw new Error('fixture did not build')
    const expected = [
      { start: 4, length: 4 },
      { start: 20, length: 4 },
    ]
    expect(a.entry.immutableOffsets).toEqual(expected)
    expect(b.entry.immutableOffsets).toEqual(expected)
  })

  it('refuses an artifact whose own settings contradict the profile', () => {
    // Without this the floor build is filed under `default`, with
    // `coveredProfiles` vouching for a toolchain that never produced these
    // bytes.
    const refused = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      { runtimeHex: CODE_A },
      { ...HASHED_SETTINGS, evmVersion: 'london' }
    )

    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.reason).toBe(
      'artifact was built for evm london, but profile default pins cancun — minting it would file the build under a toolchain it was not built with'
    )
  })

  it('reads a matching evmVersion the profile spells differently', () => {
    // Case and surrounding whitespace are format, not version: refusing over
    // them is a false red on a build that matches.
    const built = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      { runtimeHex: CODE_A },
      { ...HASHED_SETTINGS, evmVersion: ' Cancun ' }
    )

    expect(built.ok).toBe(true)
  })

  it('separates an artifact that reports no evmVersion from one that contradicts', () => {
    // An artifact that named no toolchain and one that named the wrong
    // toolchain are different claims, and the reason string is the only thing
    // the skip report shows about either.
    const { evmVersion: _dropped, ...withoutEvmVersion } = HASHED_SETTINGS
    const refused = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      { runtimeHex: CODE_A },
      withoutEvmVersion
    )

    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.reason).toBe(
      "artifact reports no evmVersion, so nothing corroborates profile default's cancun pin"
    )
  })

  it('refuses an evmVersion that is not a string, whatever it stringifies to', () => {
    // `String(['cancun'])` is `'cancun'`: only a string can corroborate the
    // pin, so anything else is refused rather than coerced into agreeing.
    const refused = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      { runtimeHex: CODE_A },
      { ...HASHED_SETTINGS, evmVersion: ['cancun'] }
    )

    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.reason).toContain(
      'reports no evmVersion'
    )
  })

  it('refuses bytecode it cannot normalise instead of minting a hash of nothing', () => {
    const built = manifestEntryFrom(
      IDENTITY,
      keyFor(),
      DEFAULT_PROFILE,
      { runtimeHex: 'not-hex' },
      HASHED_SETTINGS
    )
    expect(built.ok).toBe(false)
  })
})

describe('serialiseManifest', () => {
  it('produces identical bytes regardless of the order entries arrive in', () => {
    const a = entryFor(keyFor(), CODE_A)
    const b = entryFor(keyFor({ contractName: 'Other' }), CODE_B)

    expect(serialiseManifest(['default'], [a, b])).toBe(
      serialiseManifest(['default'], [b, a])
    )
  })

  it('orders covered profiles too, so the header cannot move the digest', () => {
    const entry = entryFor(keyFor(), CODE_A)
    expect(serialiseManifest(['zksync', 'default'], [entry])).toBe(
      serialiseManifest(['default', 'zksync'], [entry])
    )
  })

  it('ends with a newline and parses as the declared schema', () => {
    const text = serialiseManifest(['default'], [entryFor(keyFor(), CODE_A)])
    expect(text.endsWith('\n')).toBe(true)

    const parsed = JSON.parse(text) as IBuildManifest
    expect(parsed.schema).toBe(MANIFEST_SCHEMA)
    expect(parsed.coveredProfiles).toEqual(['default'])
    expect(parsed.entries).toHaveLength(1)
  })

  it('refuses two builds under one key rather than picking one', () => {
    const key = keyFor()
    // Same key, different bytecode: the key does not identify the build, so a
    // lookup would answer with whichever was written first — vouching for code
    // on the strength of an attestation of something else.
    expect(() =>
      serialiseManifest(
        ['default'],
        [entryFor(key, CODE_A), entryFor(key, CODE_B)]
      )
    ).toThrow(ManifestConflictError)
  })

  it('serialises the same settings identically whatever order solc emitted them', () => {
    // solc is free to order `metadata.settings` as it likes, and the key's
    // hash is taken over a canonical form — so two runs agreeing on every
    // value would otherwise write different bytes under an identical hash.
    const ordered = {
      evmVersion: 'cancun',
      optimizer: { enabled: true, runs: 1000000 },
      viaIR: false,
    }
    const shuffled = {
      viaIR: false,
      optimizer: { runs: 1000000, enabled: true },
      evmVersion: 'cancun',
    }

    const manifestWith = (settings: Record<string, unknown>): string => {
      const built = manifestEntryFrom(
        IDENTITY,
        keyFor(),
        DEFAULT_PROFILE,
        { runtimeHex: CODE_A },
        settings
      )
      if (!built.ok) throw new Error(`fixture did not build: ${built.reason}`)
      return serialiseManifest(['default'], [built.entry])
    }

    expect(manifestWith(shuffled)).toBe(manifestWith(ordered))
  })

  it('accepts the same build attested twice, which is not a conflict', () => {
    const key = keyFor()
    const text = serialiseManifest(
      ['default'],
      [entryFor(key, CODE_A), entryFor(key, CODE_A)]
    )
    expect(JSON.parse(text).entries).toHaveLength(2)
  })

  it('refuses a manifest that names no covered profile', () => {
    expect(() => serialiseManifest([], [entryFor(keyFor(), CODE_A)])).toThrow(
      /names no covered profile/
    )
  })

  it('records only the profiles it was minted under', () => {
    const parsed = JSON.parse(
      serialiseManifest(['default', 'solc_floor'], [entryFor(keyFor(), CODE_A)])
    ) as IBuildManifest

    expect(parsed.coveredProfiles).toEqual(['default', 'solc_floor'])
  })

  it('orders entries by contract name, not by the length-prefixed key', () => {
    // The serialised key is length-prefixed, so ordering on it alone puts
    // `Zzz` ahead of `Aaaa`. The second assertion pins that, so this test
    // still fails if the comparator goes back to the key.
    const short = entryFor(keyFor({ contractName: 'Zzz' }), CODE_A)
    const long = entryFor(keyFor({ contractName: 'Aaaa' }), CODE_B)
    const parsed = JSON.parse(
      serialiseManifest(['default'], [short, long])
    ) as IBuildManifest

    expect(parsed.entries.map((entry) => entry.key.contractName)).toEqual([
      'Aaaa',
      'Zzz',
    ])
    expect(
      serialiseAttestationKey(short.key) < serialiseAttestationKey(long.key)
    ).toBe(true)
  })

  it('orders two versions of one contract by version, not by source path', () => {
    // The key puts `sourceId` ahead of `version`, so a contract whose newer
    // version moved to an earlier-sorting path comes out newest-first if the
    // key decides. The paths here are chosen so the two orders disagree.
    const newer = entryFor(
      keyFor({ version: '2.0.0', sourceId: 'src/Periphery/Aaa.sol' }),
      CODE_A
    )
    const older = entryFor(
      keyFor({ version: '1.0.0', sourceId: 'src/Periphery/Zzz.sol' }),
      CODE_B
    )
    const parsed = JSON.parse(
      serialiseManifest(['default'], [newer, older])
    ) as IBuildManifest

    expect(parsed.entries.map((entry) => entry.key.version)).toEqual([
      '1.0.0',
      '2.0.0',
    ])
    expect(
      serialiseAttestationKey(newer.key) < serialiseAttestationKey(older.key)
    ).toBe(true)
  })

  it('orders entries the key cannot separate, so the bytes never follow input order', () => {
    // Same key, agreeing bytecode, different profile: the profile is
    // deliberately outside the key, so nothing above the last tie-breaker can
    // tell these two apart. Without it the serialised bytes would be whatever
    // order the runner emitted, and the attested digest would not survive a
    // rebuild.
    const key = keyFor()
    const a = entryFor(key, CODE_A, DEFAULT_PROFILE)
    const b = entryFor(key, CODE_A, {
      ...DEFAULT_PROFILE,
      profile: 'solc_floor',
    })

    expect(serialiseAttestationKey(a.key)).toBe(serialiseAttestationKey(b.key))
    expect(serialiseManifest(['default', 'solc_floor'], [a, b])).toBe(
      serialiseManifest(['default', 'solc_floor'], [b, a])
    )
  })
})
