import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { keccak256 } from 'viem'

import {
  ForgeArtifactBuildError,
  assertArtifactBuiltFromCurrentSource,
  assertArtifactBuiltWithDefaultProfile,
  readDefaultBuildProfile,
} from './forgeArtifactBuild'
import { metadataBuiltFrom } from './forgeArtifactBuild.fixture'

const SOURCE_PATH = 'src/Facets/Example.sol'
const LIB_PATH = 'lib/dep/Dep.sol'
const DEFAULT_PROFILE = [
  '[profile.default]',
  "solc_version = '0.8.29'",
  "evm_version = 'cancun'",
  'optimizer = true',
  'optimizer_runs = 1000000',
  '',
  '[profile.solc_floor]',
  "solc_version = '0.8.17'",
  "evm_version = 'london'",
  '',
].join('\n')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tron-artifact-build-'))
  mkdirSync(join(root, 'src/Facets'), { recursive: true })
  mkdirSync(join(root, 'lib/dep'), { recursive: true })
  writeFileSync(join(root, SOURCE_PATH), 'contract Example {}\n')
  writeFileSync(join(root, LIB_PATH), 'library Dep {}\n')
  writeFileSync(join(root, 'foundry.toml'), DEFAULT_PROFILE)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const hashOf = (path: string): string =>
  keccak256(readFileSync(join(root, path)))

const artifactFor = (
  sources: Record<string, unknown>
): { metadata: { sources: Record<string, unknown> } } => ({
  metadata: { sources },
})

describe('assertArtifactBuiltFromCurrentSource', () => {
  it('passes when every source hash matches the file on disk', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({
          [SOURCE_PATH]: { keccak256: hashOf(SOURCE_PATH) },
          [LIB_PATH]: { keccak256: hashOf(LIB_PATH) },
        }),
        'Example',
        root
      )
    ).not.toThrow()
  })

  it('compares hashes regardless of case', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({
          [SOURCE_PATH]: {
            keccak256: `0x${hashOf(SOURCE_PATH).slice(2).toUpperCase()}`,
          },
        }),
        'Example',
        root
      )
    ).not.toThrow()
  })

  it('refuses an artifact built from older source, naming every changed path', () => {
    const builtHash = hashOf(SOURCE_PATH)
    const builtLibHash = hashOf(LIB_PATH)
    writeFileSync(join(root, SOURCE_PATH), 'contract Example { uint x; }\n')
    writeFileSync(join(root, LIB_PATH), 'library Dep { function f() {} }\n')

    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({
          [SOURCE_PATH]: { keccak256: builtHash },
          [LIB_PATH]: { keccak256: builtLibHash },
        }),
        'Example',
        root
      )
    ).toThrow(
      /Example.*stale.*src\/Facets\/Example\.sol.*lib\/dep\/Dep\.sol.*forge build/su
    )
  })

  it('counts a whitespace-only edit as a mismatch', () => {
    const builtHash = hashOf(SOURCE_PATH)
    writeFileSync(join(root, SOURCE_PATH), 'contract Example {}\n\n')

    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({ [SOURCE_PATH]: { keccak256: builtHash } }),
        'Example',
        root
      )
    ).toThrow(/Example.*src\/Facets\/Example\.sol.*forge build/su)
  })

  it('refuses an artifact with no metadata', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource({}, 'Example', root)
    ).toThrow(/Example.*cannot be checked against the source/su)
  })

  it('refuses an artifact whose metadata.sources is empty or not a map', () => {
    for (const sources of [{}, null, SOURCE_PATH, []])
      expect(() =>
        assertArtifactBuiltFromCurrentSource(
          { metadata: { sources } },
          'Example',
          root
        )
      ).toThrow(/Example.*cannot be checked against the source/su)
  })

  it('refuses a source entry that carries no keccak256', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({ [SOURCE_PATH]: { urls: [] } }),
        'Example',
        root
      )
    ).toThrow(
      /Example.*cannot be checked against the source.*src\/Facets\/Example\.sol \(no keccak256\)/su
    )
  })

  it('refuses a source entry whose keccak256 is not a whole digest', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({ [SOURCE_PATH]: { keccak256: '0x00' } }),
        'Example',
        root
      )
    ).toThrow(/src\/Facets\/Example\.sol \(keccak256 is not 32 bytes\)/u)
  })

  it('refuses a source path that no longer exists on disk', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({
          [SOURCE_PATH]: { keccak256: hashOf(SOURCE_PATH) },
          'src/Facets/Deleted.sol': { keccak256: hashOf(SOURCE_PATH) },
        }),
        'Example',
        root
      )
    ).toThrow(
      /Example.*cannot be checked against the source.*src\/Facets\/Deleted\.sol \(not on disk\)/su
    )
  })

  it('names the contract and the fix when a source path is a directory', () => {
    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({ 'src/Facets': { keccak256: hashOf(SOURCE_PATH) } }),
        'Example',
        root
      )
    ).toThrow(/Example.*src\/Facets \(unreadable: EISDIR\).*forge build/su)
  })

  it('names the contract and the fix when a source file cannot be read', () => {
    if (process.getuid?.() === 0) return // root reads a mode-000 file regardless
    const builtHash = hashOf(SOURCE_PATH)
    chmodSync(join(root, SOURCE_PATH), 0o000)

    expect(() =>
      assertArtifactBuiltFromCurrentSource(
        artifactFor({ [SOURCE_PATH]: { keccak256: builtHash } }),
        'Example',
        root
      )
    ).toThrow(/Example.*Example\.sol \(unreadable: EACCES\).*forge build/su)
  })

  it('throws a ForgeArtifactBuildError', () => {
    let error: unknown
    try {
      assertArtifactBuiltFromCurrentSource({}, 'Example', root)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ForgeArtifactBuildError)
  })
})

describe('readDefaultBuildProfile', () => {
  it('reads the default profile, not another one', () => {
    expect(readDefaultBuildProfile(root)).toEqual({
      solcVersion: '0.8.29',
      evmVersion: 'cancun',
      optimizer: true,
      optimizerRuns: 1000000,
      viaIr: false,
    })
  })

  it('refuses a checkout with no foundry.toml', () => {
    rmSync(join(root, 'foundry.toml'))

    expect(() => readDefaultBuildProfile(root)).toThrow(
      /Cannot read the build profile from .*foundry\.toml/u
    )
  })

  it('refuses a foundry.toml that is not TOML', () => {
    writeFileSync(join(root, 'foundry.toml'), '[profile.default\n')

    expect(() => readDefaultBuildProfile(root)).toThrow(
      /Cannot read the build profile/u
    )
  })

  it('refuses a default profile that does not pin solc and EVM versions', () => {
    writeFileSync(
      join(root, 'foundry.toml'),
      "[profile.default]\nout = 'out'\n"
    )

    expect(() => readDefaultBuildProfile(root)).toThrow(
      /does not pin solc_version and evm_version/u
    )
  })
})

describe('assertArtifactBuiltWithDefaultProfile', () => {
  const builtWith = (
    patch: (metadata: Record<string, unknown>) => void
  ): { metadata: Record<string, unknown> } => {
    const metadata = metadataBuiltFrom(root, [SOURCE_PATH])
    patch(metadata)
    return { metadata }
  }

  it('passes an artifact built with the default profile', () => {
    expect(() =>
      assertArtifactBuiltWithDefaultProfile(
        builtWith(() => undefined),
        'Example',
        root
      )
    ).not.toThrow()
  })

  it('refuses an artifact built under the solc_floor profile', () => {
    const artifact = builtWith((metadata) => {
      metadata.compiler = { version: '0.8.17+commit.8df45f5f' }
      metadata.settings = {
        evmVersion: 'london',
        optimizer: { enabled: true, runs: 1000000 },
      }
    })

    const solc = 'solc 0.8.17+commit.8df45f5f, expected 0.8.29'
    const evm = 'evmVersion london, expected cancun'
    expect(() =>
      assertArtifactBuiltWithDefaultProfile(artifact, 'Example', root)
    ).toThrow(`(${solc}; ${evm})`)
    expect(() =>
      assertArtifactBuiltWithDefaultProfile(artifact, 'Example', root)
    ).toThrow(/^Example: .*Unset FOUNDRY_PROFILE/su)
  })

  it('refuses a different optimizer setting', () => {
    const artifact = builtWith((metadata) => {
      metadata.settings = {
        evmVersion: 'cancun',
        optimizer: { enabled: false, runs: 200 },
      }
    })

    expect(() =>
      assertArtifactBuiltWithDefaultProfile(artifact, 'Example', root)
    ).toThrow(
      /optimizer false, expected true; optimizer runs 200, expected 1000000/u
    )
  })

  it('refuses an artifact built through the IR pipeline when the profile does not use it', () => {
    const artifact = builtWith((metadata) => {
      ;(metadata.settings as Record<string, unknown>).viaIR = true
    })

    expect(() =>
      assertArtifactBuiltWithDefaultProfile(artifact, 'Example', root)
    ).toThrow(/viaIR true, expected false/u)
  })

  it('refuses an artifact that records no compiler at all', () => {
    expect(() =>
      assertArtifactBuiltWithDefaultProfile({}, 'Example', root)
    ).toThrow(/solc none, expected 0\.8\.29; evmVersion undefined/u)
  })

  it('skips optimizer comparisons the profile leaves to forge', () => {
    writeFileSync(
      join(root, 'foundry.toml'),
      "[profile.default]\nsolc_version = '0.8.29'\nevm_version = 'cancun'\n"
    )
    const artifact = builtWith((metadata) => {
      metadata.settings = {
        evmVersion: 'cancun',
        optimizer: { enabled: true, runs: 1000000 },
      }
    })

    expect(() =>
      assertArtifactBuiltWithDefaultProfile(artifact, 'Example', root)
    ).not.toThrow()
  })
})
