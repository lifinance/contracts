/**
 * What the minted manifest must guarantee for its attestation to mean anything.
 *
 * The attestation binds a sha256 of these exact bytes, so byte-stability is not
 * a tidiness property here — it is the whole binding. The rest of the file
 * covers the two ways a manifest can be worse than useless: filing two
 * different builds under one key, and letting a reader mistake a toolchain
 * nobody minted for a build nobody attested.
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

const HASHED_SETTINGS = { optimizer: { enabled: true, runs: 1000000 } }

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

  it('pins the exact bytes on zk and leaves them unpinned elsewhere', () => {
    // The solc-fork/LLVM version a zksolc build came from lives only in the
    // trailer, so stripping it is what makes fork drift invisible there.
    expect(entryFor(keyFor(), CODE_A, ZK_PROFILE).rawHash).toBeDefined()
    expect(entryFor(keyFor(), CODE_A).rawHash).toBeUndefined()
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

    // The attestation binds a digest of these bytes. A manifest whose text
    // depends on emission order cannot stay bound across two runs of one
    // commit, and every verify would fail for a build that never changed.
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
      optimizer: { enabled: true, runs: 1000000 },
      viaIR: false,
    }
    const shuffled = {
      viaIR: false,
      optimizer: { runs: 1000000, enabled: true },
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
    // An empty list reads as "nothing was minted", which a consumer cannot
    // distinguish from "this toolchain was minted and matched nothing".
    expect(() => serialiseManifest([], [entryFor(keyFor(), CODE_A)])).toThrow(
      /names no covered profile/
    )
  })

  it('records the profiles minted so an unminted toolchain is not read as unattested', () => {
    const parsed = JSON.parse(
      serialiseManifest(['default', 'solc_floor'], [entryFor(keyFor(), CODE_A)])
    ) as IBuildManifest

    // A zkEVM deploy is outside this manifest's claim. A reader that ignores
    // coveredProfiles grades it MISMATCH on the strength of a manifest that
    // never described it.
    expect(parsed.coveredProfiles).not.toContain('zksync')
  })

  it('sorts entries by their own key, not by contract name', () => {
    const first = entryFor(keyFor({ contractName: 'Aaa' }), CODE_A)
    const second = entryFor(keyFor({ contractName: 'Zzz' }), CODE_B)
    const parsed = JSON.parse(
      serialiseManifest(['default'], [second, first])
    ) as IBuildManifest

    const keys = parsed.entries.map((entry) =>
      serialiseAttestationKey(entry.key)
    )
    expect([...keys].sort()).toEqual(keys)
  })
})
