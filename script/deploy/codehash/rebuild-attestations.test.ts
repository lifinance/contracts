/**
 * The attestation source: what the sign-time gate compares deployed code
 * against, produced by rebuilding at the deployment record's commit.
 *
 * Two properties carry the weight here, and both are about what CANNOT happen.
 * A rebuild that could not be performed must never read as "no attested build" —
 * one is an infrastructure failure that could be hiding either answer, the other
 * is a clean grey — so the four outcomes are asserted separately. And the
 * attested side must normalise through the same function as the observed side,
 * because two normalisations make the comparison meaningless while looking
 * finished.
 *
 * Bytecode fixtures are real bytes, embedded rather than read from `out/` (CI
 * has no build artifacts, so a test reading them either fails there or passes
 * vacuously). Provenance: `bytecode-trailer.test.ts` — the EVM trailer is the
 * tail of `AccessManagerFacet` at `ce1b2760c`, the zksolc one the layout
 * measured in `10c-zkevm-verification-plan.md` §3.4.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { keccak256 } from 'viem'

import {
  compareToAttestedSet,
  type IAttestedBuild,
  type IObservedCode,
} from './attested-set'
import {
  parseBuildProfiles,
  deriveToolchainScope,
  type IBuildProfile,
} from './lineage-scope'
import {
  AttestationSourceError,
  createAttestationSource,
  normalizeRuntimeCode,
  type IAttestationSourceDeps,
  type IDeploymentRecordRef,
  type IRebuildRequest,
  type IRebuiltArtifact,
} from './rebuild-attestations'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const profiles = parseBuildProfiles(
  readFileSync(join(REPO_ROOT, 'foundry.toml'), 'utf8')
)
const networks = JSON.parse(
  readFileSync(join(REPO_ROOT, 'config', 'networks.json'), 'utf8')
) as Record<string, { targetEvmVersion: string; isZkEVM: boolean }>

/**
 * @param name - a profile `foundry.toml` is expected to pin
 */
const profileNamed = (name: string): IBuildProfile => {
  const found = profiles[name]
  if (!found) throw new Error(`foundry.toml pins no "${name}" profile`)
  return found
}

/** Real 51-byte solc CBOR trailer plus its length word, code stripped off. */
const EVM_TRAILER =
  'a2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d0033'

/** The same trailer with a different IPFS digest: metadata drift, same code. */
const EVM_TRAILER_DRIFTED = EVM_TRAILER.replace(
  // pre-commit-checker: not a secret — the IPFS digest inside public bytecode
  'd03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e',
  'ababababababababababababababababababababababababababababababababab'.slice(
    0,
    64
  )
)

/** zksolc's trailer, whose `solc` entry is the `zksolc;solc;llvm` triple. */
const ZK_TRAILER =
  'a2646970667358221220abababababababababababababababababababababababababababababababab64736f6c6378247a6b736f6c633a312e352e31353b736f6c633a302e382e32393b6c6c766d3a312e302e320055'

/** The same, with the LLVM fork the 2026-07-16 deploys were built by. */
const ZK_TRAILER_OLD_FORK = ZK_TRAILER.replace(
  Buffer.from('llvm:1.0.2', 'utf8').toString('hex'),
  Buffer.from('llvm:1.0.1', 'utf8').toString('hex')
)

const IMMUTABLE_HEX = 'de'.repeat(32)
/** 96 bytes: 32 of code, one 32-byte immutable, 32 more of code. */
const CODE_BODY = `${'60'.repeat(32)}${IMMUTABLE_HEX}${'61'.repeat(32)}`
const IMMUTABLE_REFS = { '4211': [{ start: 32, length: 32 }] }

const EVM_RUNTIME = `0x${CODE_BODY}${EVM_TRAILER}`
const ZK_RUNTIME = `0x${CODE_BODY}${ZK_TRAILER}`

const SHA = 'c0cc000e8'.padEnd(40, '0')
const ADDRESS = '0x1111111111111111111111111111111111111111'

const RECORD: IDeploymentRecordRef = {
  contractName: 'AccessManagerFacet',
  version: '2.0.0',
  gitCommitHash: SHA,
}

/**
 * @param over - the dependency behaviours this case needs
 */
const sourceWith = (
  over: Partial<IAttestationSourceDeps> & { runtime?: string } = {}
) => {
  const requests: IRebuildRequest[] = []
  const gitCalls: string[][] = []
  const deps: IAttestationSourceDeps = {
    readRecord: async () => RECORD,
    toolchainScope: () => ({
      isClosedSet: true,
      profiles: [profileNamed('default')],
    }),
    build: (request: IRebuildRequest): IRebuiltArtifact => {
      requests.push(request)
      return {
        runtimeHex: over.runtime ?? EVM_RUNTIME,
        immutableReferences: IMMUTABLE_REFS,
      }
    },
    git: (args: string[]): string => {
      gitCalls.push(args)
      return ''
    },
    ...over,
  }
  return { source: createAttestationSource(deps), requests, gitCalls }
}

/**
 * @param promise - the call expected to reject
 * @param match - pattern the message must contain
 */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(
      match
    )
    return error
  }
  throw new Error(`expected a rejection matching ${String(match)}`)
}

describe('normalizeRuntimeCode — the one function both sides go through', () => {
  it('masks the immutable occurrences on an EVM lineage', () => {
    const normalized = normalizeRuntimeCode(EVM_RUNTIME, IMMUTABLE_REFS, {
      isZk: false,
    })

    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    // Independently constructed rather than read back from the function, so a
    // masking bug cannot agree with itself.
    const expectedMasked = `0x${'60'.repeat(32)}${'00'.repeat(32)}${'61'.repeat(
      32
    )}`
    expect(normalized.maskedHash).toBe(
      keccak256(expectedMasked as `0x${string}`)
    )
    expect(normalized.maskedByteCount).toBe(32)
    // 96 bytes of code + the 53-byte trailer with its length word.
    expect(normalized.rawByteLength).toBe(149)
    expect(normalized.rawHash).toBe(keccak256(EVM_RUNTIME as `0x${string}`))
  })

  it('does not reach the same hash as leaving the immutables in place', () => {
    // Paired with the case above: without this, a masking step that silently did
    // nothing would satisfy every other assertion in this file.
    const masked = normalizeRuntimeCode(EVM_RUNTIME, IMMUTABLE_REFS, {
      isZk: false,
    })
    const unmasked = normalizeRuntimeCode(EVM_RUNTIME, undefined, {
      isZk: false,
    })

    expect(masked.ok && unmasked.ok).toBe(true)
    if (!masked.ok || !unmasked.ok) return
    expect(masked.maskedHash).not.toBe(unmasked.maskedHash)
    expect(unmasked.maskedByteCount).toBe(0)
  })

  it('does not offset-mask on zkEVM even when occurrences are supplied', () => {
    // zkEVM keeps immutables in `ImmutableSimulator`, so an offset into the
    // runtime code points at real code — masking there would blind the
    // comparison to 32 bytes of codegen.
    const normalized = normalizeRuntimeCode(ZK_RUNTIME, IMMUTABLE_REFS, {
      isZk: true,
    })

    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    expect(normalized.maskedHash).toBe(keccak256(`0x${CODE_BODY}`))
    expect(normalized.maskedByteCount).toBe(0)
  })

  it('refuses bytecode that is not whole hex rather than hashing it', () => {
    const normalized = normalizeRuntimeCode('0xabc', undefined, { isZk: false })

    expect(normalized.ok).toBe(false)
    if (!normalized.ok) expect(normalized.reason).toMatch(/whole bytes/)
  })

  it('refuses occurrences that reach into the metadata trailer', () => {
    // The trailer comes off before masking, so an occurrence inside it runs past
    // the end and is refused instead of zeroing bytes the hash then covers.
    const normalized = normalizeRuntimeCode(
      EVM_RUNTIME,
      { '9': [{ start: 100, length: 32 }] },
      { isZk: false }
    )

    expect(normalized.ok).toBe(false)
    if (!normalized.ok) expect(normalized.reason).toMatch(/runs past the end/)
  })
})

describe('createAttestationSource — the four outcomes stay four', () => {
  it('reports no record as unattestable, and hands the seam an empty set', async () => {
    const { source } = sourceWith({ readRecord: async () => undefined })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('unattestable')
    if (resolution.kind !== 'unattestable') return
    expect(resolution.stage).toBe('no-record')
    expect(await source.attestationsFor(ADDRESS, 'mainnet')).toEqual([])
  })

  it('reports a record with no commit as unattestable, not as an error', async () => {
    // 748 fleet slots predate `gitCommitHash`, and `getCurrentGitCommitHash()`
    // still writes the literal 'UNKNOWN' on failure. Grading those ERROR would
    // page on history rather than on a defect.
    for (const gitCommitHash of ['', 'UNKNOWN']) {
      const { source } = sourceWith({
        readRecord: async () => ({ ...RECORD, gitCommitHash }),
      })
      const resolution = await source.resolve(ADDRESS, 'mainnet')

      expect(resolution.kind).toBe('unattestable')
      if (resolution.kind !== 'unattestable') return
      expect(resolution.stage).toBe('no-commit')
    }
  })

  it('errors, distinctly, when the record store cannot be reached', async () => {
    // Never answer from `deployments/_deployments_log_file.json`: its latest
    // entry is 2025-12-17 and it holds one commit hash in 3,765 records, so a
    // fallback would answer confidently about the wrong bytes.
    const { source } = sourceWith({
      readRecord: async () => {
        throw new Error('MongoServerSelectionError: connection timed out')
      },
    })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('error')
    if (resolution.kind !== 'error') return
    expect(resolution.stage).toBe('record-unreadable')
    expect(resolution.reason).toMatch(/connection timed out/)

    const error = await expectRejects(
      source.attestationsFor(ADDRESS, 'mainnet'),
      /could not be read/
    )
    expect(error).toBeInstanceOf(AttestationSourceError)
    expect((error as AttestationSourceError).stage).toBe('record-unreadable')
  })

  it('errors when the commit cannot be fetched, rather than reporting none', async () => {
    // 56 of 98 audit commits are unreachable from any local ref and retrievable
    // by SHA, so a failed fetch says nothing about the deployment.
    const { source } = sourceWith({
      git: () => {
        throw new Error('fatal: could not read from remote repository')
      },
    })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('error')
    if (resolution.kind !== 'error') return
    expect(resolution.stage).toBe('commit-unfetchable')
  })

  it('errors on a commit hash that is not a full SHA', async () => {
    const { source } = sourceWith({
      readRecord: async () => ({ ...RECORD, gitCommitHash: 'c0cc000e8' }),
    })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('error')
    if (resolution.kind !== 'error') return
    expect(resolution.stage).toBe('commit-refused')
  })

  it('errors when the rebuild itself fails', async () => {
    const { source } = sourceWith({
      build: () => {
        throw new Error('Compiler run failed: pragma rejects 0.8.29')
      },
    })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('error')
    if (resolution.kind !== 'error') return
    expect(resolution.stage).toBe('rebuild-failed')
    expect(resolution.reason).toMatch(/pragma rejects/)
  })

  it('errors when the rebuilt artifact cannot be normalised', async () => {
    const { source } = sourceWith({ runtime: '0x' })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('error')
    if (resolution.kind !== 'error') return
    expect(resolution.stage).toBe('artifact-unusable')
  })

  it('errors when the network has no derivable toolchain scope', async () => {
    const { source } = sourceWith({
      toolchainScope: () => {
        throw new Error('Toolchain scope: "nowhere" is not in networks.json')
      },
    })

    const resolution = await source.resolve(ADDRESS, 'nowhere')
    expect(resolution.kind).toBe('error')
    if (resolution.kind !== 'error') return
    expect(resolution.stage).toBe('scope-unavailable')
  })

  it('fetches the commit by SHA before rebuilding, and says it did', async () => {
    let present = false
    const { source, gitCalls } = sourceWith({
      git: (args: string[]): string => {
        gitCalls.push(args)
        if (args[0] === 'cat-file') {
          if (!present) throw new Error('Not a valid object name')
          return ''
        }
        present = true
        return ''
      },
    })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('built')
    if (resolution.kind !== 'built') return
    expect(resolution.commitFetched).toBe(true)
    expect(gitCalls.some((args) => args[0] === 'fetch')).toBe(true)
  })
})

describe('createAttestationSource — the set it returns', () => {
  it('rebuilds at the record commit under every legitimate profile', async () => {
    // Set membership, not equality against the record: the record's own
    // compiler fields are never an input, because 14 production slots carry a
    // wrong one and a record-derived profile would flag them rogue.
    const { source, requests } = sourceWith({
      toolchainScope: () => ({
        isClosedSet: true,
        profiles: [profileNamed('default'), profileNamed('solc_floor')],
      }),
    })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('built')
    if (resolution.kind !== 'built') return
    expect(resolution.builds).toHaveLength(2)
    expect(requests.map((r) => r.profile.profile)).toEqual([
      'default',
      'solc_floor',
    ])
    expect(requests.every((r) => r.commit === SHA)).toBe(true)
    expect(resolution.builds.map((b) => b.lineage)).toEqual([
      expect.stringContaining('default'),
      expect.stringContaining('solc_floor'),
    ])
  })

  it('reads the attested solc version from the rebuild, not from the record', async () => {
    const { source } = sourceWith()

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('built')
    if (resolution.kind !== 'built') return
    // The fixture's own trailer says 0.8.29; the profile pins 0.8.29 too, so the
    // discriminating case is the trailer-less one below.
    expect(resolution.builds[0]?.solcVersion).toBe('0.8.29')
  })

  it('falls back to the profile pin when our own build carries no trailer', async () => {
    const { source } = sourceWith({ runtime: `0x${CODE_BODY}` })

    const resolution = await source.resolve(ADDRESS, 'mainnet')
    expect(resolution.kind).toBe('built')
    if (resolution.kind !== 'built') return
    expect(resolution.builds[0]?.solcVersion).toBe(
      profileNamed('default').solcVersion
    )
  })

  it('leaves rawHash unpinned on an EVM lineage and pins it on zkEVM', async () => {
    const { source: evm } = sourceWith()
    const evmResolution = await evm.resolve(ADDRESS, 'mainnet')
    expect(evmResolution.kind).toBe('built')
    if (evmResolution.kind !== 'built') return
    expect(evmResolution.builds[0]?.rawHash).toBeUndefined()

    const { source: zk } = sourceWith({
      runtime: ZK_RUNTIME,
      toolchainScope: () => ({
        isClosedSet: true,
        profiles: [profileNamed('zksync')],
      }),
    })
    const zkResolution = await zk.resolve(ADDRESS, 'zksync')
    expect(zkResolution.kind).toBe('built')
    if (zkResolution.kind !== 'built') return
    // D19(b): the solc-fork/LLVM sub-version lives in the trailer, so masking it
    // away is what makes fork drift invisible. Pinning compares it unmasked.
    expect(zkResolution.builds[0]?.rawHash).toBe(
      keccak256(ZK_RUNTIME as `0x${string}`)
    )
    expect(zkResolution.builds[0]?.lineage).toMatch(/llvm 1\.0\.2/)
  })

  it('derives the same profiles from the real repo config it will run against', () => {
    // Grounded in the real `foundry.toml` and `config/networks.json` rather than
    // a fixture, so a retuned profile shows up here instead of at sign time.
    const cancun = deriveToolchainScope('mainnet', { networks, profiles })
    expect(cancun.profiles.map((p) => p.profile)).toEqual(['default'])
    expect(cancun.profiles[0]?.zksolcVersion).toBeUndefined()

    const zk = deriveToolchainScope('zksync', { networks, profiles })
    expect(zk.profiles.map((p) => p.profile)).toEqual(['zksync'])
    expect(zk.profiles[0]?.zksolcVersion).toBe('1.5.15')
  })
})

describe('the real fleet decides which lineage masks and which pins', () => {
  const active = Object.keys(networks).filter(
    (network) =>
      (networks[network] as { status?: string } | undefined)?.status ===
      'active'
  )

  /**
   * @param network - a network key from the real config
   */
  const buildFor = async (network: string): Promise<IAttestedBuild> => {
    const { source } = sourceWith({
      toolchainScope: () =>
        deriveToolchainScope(network, { networks, profiles }),
    })
    const [build] = await source.attestationsFor(ADDRESS, network)
    if (!build) throw new Error(`${network} produced no attested build`)
    return build
  }

  it('pins the exact bytes on exactly the zkEVM networks', async () => {
    // The zk discriminator is the profile's zksolc pin, so this asserts the
    // branch that decides masking against every active network in the real
    // config rather than against the two the fixtures name.
    expect(active.length).toBeGreaterThan(60)
    const zk = active.filter((n) => networks[n]?.isZkEVM)
    // Paired with the assertion below: with no zk network in the config, an
    // implementation that never pinned would satisfy it vacuously.
    expect(zk.length).toBeGreaterThan(0)

    const pinned: string[] = []
    for (const network of active) {
      const build = await buildFor(network)
      if (build.rawHash !== undefined) pinned.push(network)
    }

    expect(pinned.sort()).toEqual(zk.sort())
  })
})

describe('createAttestationSource — the per-run cache', () => {
  it('rebuilds once per address, commit and profile', async () => {
    const { source, requests } = sourceWith()

    await source.resolve(ADDRESS, 'mainnet')
    const second = await source.resolve(ADDRESS, 'mainnet')

    expect(requests).toHaveLength(1)
    expect(second.kind).toBe('built')
    if (second.kind !== 'built') return
    expect(second.builds[0]?.maskedHash).toBe(
      (
        normalizeRuntimeCode(EVM_RUNTIME, IMMUTABLE_REFS, {
          isZk: false,
        }) as { maskedHash: string }
      ).maskedHash
    )
  })

  it('does not cache a failed rebuild', async () => {
    // A cached failure could outlive its cause; a cached success cannot soften a
    // verdict, because the deployed side is re-read and re-compared every call.
    let attempts = 0
    const { source } = sourceWith({
      build: (): IRebuiltArtifact => {
        attempts += 1
        if (attempts === 1) throw new Error('transient toolchain download')
        return {
          runtimeHex: EVM_RUNTIME,
          immutableReferences: IMMUTABLE_REFS,
        }
      },
    })

    expect((await source.resolve(ADDRESS, 'mainnet')).kind).toBe('error')
    expect((await source.resolve(ADDRESS, 'mainnet')).kind).toBe('built')
    expect(attempts).toBe(2)
  })

  it('does not serve one profile’s build for another', async () => {
    const { source, requests } = sourceWith({
      toolchainScope: () => ({
        isClosedSet: true,
        profiles: [profileNamed('default'), profileNamed('solc_floor')],
      }),
    })

    await source.resolve(ADDRESS, 'mainnet')
    expect(requests).toHaveLength(2)
  })
})

describe('falsification — the attested set against real observed code', () => {
  /**
   * @param runtimeHex - the bytes to present as deployed
   * @param isZk - whether the lineage is zkEVM
   */
  const observe = (runtimeHex: string, isZk: boolean): IObservedCode => {
    const normalized = normalizeRuntimeCode(runtimeHex, IMMUTABLE_REFS, {
      isZk,
    })
    if (!normalized.ok) throw new Error(normalized.reason)
    return {
      maskedHash: normalized.maskedHash,
      rawByteLength: normalized.rawByteLength,
      rawHash: normalized.rawHash,
      maskedByteCount: normalized.maskedByteCount,
    }
  }

  /**
   * @param runtime - what the rebuild produced
   * @param network - which network's scope to derive
   */
  const attest = async (
    runtime: string,
    network: string
  ): Promise<IAttestedBuild[]> => {
    const { source } = sourceWith({
      runtime,
      toolchainScope: () =>
        deriveToolchainScope(network, { networks, profiles }),
    })
    return source.attestationsFor(ADDRESS, network)
  }

  it('stays silent on the code it rebuilt', async () => {
    const verdict = compareToAttestedSet(
      observe(EVM_RUNTIME, false),
      await attest(EVM_RUNTIME, 'mainnet'),
      { isClosedSet: true }
    )

    expect(verdict.verdict).toBe('MATCH')
    expect(verdict.blocksSigning).toBe(false)
    // The immutable bytes were excluded, so the MATCH is explicitly incomplete.
    expect(verdict.excludedByteCount).toBe(32)
  })

  it('fires on one flipped code byte', async () => {
    const tampered = EVM_RUNTIME.replace(
      `0x${'60'.repeat(32)}`,
      `0x${'60'.repeat(31)}61`
    )
    // Asserting the fixture is actually tampered, and tampered in the code
    // rather than in a length: otherwise this passes on the wrong reason.
    expect(tampered).not.toBe(EVM_RUNTIME)
    expect(tampered.length).toBe(EVM_RUNTIME.length)

    const verdict = compareToAttestedSet(
      observe(tampered, false),
      await attest(EVM_RUNTIME, 'mainnet'),
      { isClosedSet: true }
    )

    expect(verdict.verdict).toBe('MISMATCH')
    expect(verdict.blocksSigning).toBe(true)
  })

  it('fires on code that normalises alike but is longer than attested', async () => {
    // Same code body under a 34-byte-longer trailer, so it strips to the same
    // bytes and the masked hashes agree. Only the pre-strip length separates
    // them, and the trailer's own length word is what decides how much comes
    // off — so a hash-only comparison would call this a match.
    const longerTrailer = `0x${CODE_BODY}${ZK_TRAILER}`
    const observed = observe(longerTrailer, false)
    const attested = await attest(EVM_RUNTIME, 'mainnet')
    const [attestedBuild] = attested
    expect(attestedBuild).toBeDefined()
    if (!attestedBuild) return
    expect(observed.maskedHash).toBe(attestedBuild.maskedHash)
    expect(observed.rawByteLength).not.toBe(attestedBuild.rawByteLength)

    const verdict = compareToAttestedSet(observed, attested, {
      isClosedSet: true,
    })

    expect(verdict.verdict).toBe('MISMATCH')
    expect(verdict.reason).toMatch(/not accounted for/)
  })

  it('tolerates metadata drift on an EVM lineage', async () => {
    // The whole reason the trailer is stripped: a changed comment or file path
    // moves these bytes without moving a byte of codegen.
    const drifted = `0x${CODE_BODY}${EVM_TRAILER_DRIFTED}`
    expect(drifted).not.toBe(EVM_RUNTIME)
    expect(drifted.length).toBe(EVM_RUNTIME.length)

    const verdict = compareToAttestedSet(
      observe(drifted, false),
      await attest(EVM_RUNTIME, 'mainnet'),
      { isClosedSet: true }
    )

    expect(verdict.verdict).toBe('MATCH')
  })

  it('fires on a zkEVM fork drift the EVM lineage would have tolerated', async () => {
    // Measured on `LayerSwapFacet`: llvm 1.0.1 vs 1.0.2, 33 bytes differing,
    // all inside the trailer. D19(b) says pin, so this must block.
    const oldFork = `0x${CODE_BODY}${ZK_TRAILER_OLD_FORK}`
    expect(oldFork.length).toBe(ZK_RUNTIME.length)

    const verdict = compareToAttestedSet(
      observe(oldFork, true),
      await attest(ZK_RUNTIME, 'zksync'),
      { isClosedSet: true }
    )

    expect(verdict.verdict).toBe('MISMATCH')
    expect(verdict.reason).toMatch(/metadata trailer/)
  })

  it('stays silent on the zkEVM code it rebuilt', async () => {
    const verdict = compareToAttestedSet(
      observe(ZK_RUNTIME, true),
      await attest(ZK_RUNTIME, 'zksync'),
      { isClosedSet: true }
    )

    expect(verdict.verdict).toBe('MATCH')
    expect(verdict.excludedByteCount).toBe(0)
  })
})
