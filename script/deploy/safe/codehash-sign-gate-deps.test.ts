/**
 * The three real dependencies the sign-time gate runs on, driven against
 * injected primitives. No test here reaches an RPC, MongoDB or `forge` — the
 * seams exist so it does not have to, and a test that did would pass or fail on
 * the machine rather than on the code.
 *
 * The toolchain-scope assertions run against the repo's own
 * `config/networks.json` and `foundry.toml`, because a scope derived from a
 * fixture proves nothing about the config the gate will actually read.
 *
 * The bytecode fixture carries a real CBOR trailer AND non-zero bytes at its
 * immutable offsets. Both matter: an attestation compared byte-for-byte reports
 * zero excluded bytes, so a fixture without real immutables cannot exercise the
 * masking path at all.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { keccak256, type Chain, type Hex } from 'viem'

import type { ImmutableReferences } from '../codehash/immutable-offsets'
import type { IBuildProfile, IToolchainScope } from '../codehash/lineage-scope'
import { normalizeRuntimeCode } from '../codehash/rebuild-attestations'
import {
  readImmutableDeclarations,
  type IImmutableDeclaration,
} from '../immutables/immutable-ast'
import type { DeployRequirements } from '../immutables/registry-schema'

import {
  buildRecordQuery,
  createForgeRebuildRunner,
  createImmutableSimulatorReader,
  createLocalImmutableDeclarations,
  createOffCodeImmutablesReader,
  createImmutablePricer,
  createImmutableReferencesResolver,
  createDeployedCodeReader,
  createRecordReader,
  createRuntimeCodeObserver,
  createToolchainScopeResolver,
  createArtifactCache,
  createPinnedImmutableExpectations,
  defaultCheckoutRoot,
  readToolchainConfig,
  resolveDeploymentRecord,
} from './codehash-sign-gate-deps'
import type { PinnedJsonRead } from './pinned-target-state'

/** Real tail of `out/AccessManagerFacet.sol/AccessManagerFacet.json`: 51-byte CBOR trailer plus its length word. */
const REAL_TRAILER =
  'a2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d0033'

/** 128 bytes of non-zero filler, so masking is observable rather than a no-op. */
const CODE_BODY = Array.from({ length: 128 }, (_, i) =>
  ((i % 255) + 1).toString(16).padStart(2, '0')
).join('')

const DEPLOYED = `0x${CODE_BODY}${REAL_TRAILER}` as Hex

/** Offsets inside the code body, never inside the trailer. */
const REFS = {
  '8938': [
    { start: 32, length: 32 },
    { start: 64, length: 32 },
  ],
}

const ADDRESS = '0x1111111111111111111111111111111111111111'

/** The message a rejected promise carried, or '' when it resolved. */
const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('readToolchainConfig', () => {
  it('reads the repo config, so a retuned profile cannot go unnoticed', () => {
    const config = readToolchainConfig()

    expect(Object.keys(config.networks).length).toBeGreaterThan(50)
    expect(config.profiles.default?.solcVersion).toBe('0.8.29')
    expect(config.profiles.default?.evmVersion).toBe('cancun')
    expect(config.profiles.solc_floor?.solcVersion).toBe('0.8.17')
    expect(config.profiles.zksync?.zksolcVersion).toBeDefined()
  })
})

describe('createToolchainScopeResolver', () => {
  const resolve = createToolchainScopeResolver(readToolchainConfig())

  it('resolves a cancun mainnet to the one profile that pins cancun', () => {
    const scope = resolve('mainnet')

    expect(scope.isClosedSet).toBe(true)
    expect(scope.profiles.map((p) => p.profile)).toEqual(['default'])
  })

  it('resolves a london network to the floor profile', () => {
    const scope = resolve('fuse')

    expect(scope.profiles.map((p) => p.profile)).toEqual(['solc_floor'])
  })

  it('resolves Tron to the default profile its fork builds with', () => {
    const scope = resolve('tron')

    expect(scope.isClosedSet).toBe(true)
    expect(scope.profiles.map((p) => p.profile)).toEqual(['default'])
  })

  it('resolves a zkEVM network to the zksolc profile', () => {
    const scope = resolve('zksync')

    expect(scope.profiles).toHaveLength(1)
    expect(scope.profiles[0]?.zksolcVersion).toBeDefined()
  })

  it('throws for a network the config does not name', () => {
    expect(() => resolve('notanetwork')).toThrow(
      /not in config\/networks\.json/
    )
  })

  it('answers the same object twice without re-reading the config', () => {
    expect(resolve('mainnet')).toBe(resolve('mainnet'))
  })
})

describe('createRuntimeCodeObserver', () => {
  const observer = (
    over: {
      readDeployedCode?: (address: string, network: string) => Promise<string>
      refsFor?: (
        address: string,
        network: string
      ) => Promise<ImmutableReferences | undefined>
      profiles?: { profile: string; solcVersion: string; evmVersion: string }[]
    } = {}
  ) =>
    createRuntimeCodeObserver({
      scopeFor: () => ({
        isClosedSet: true,
        holdsImmutablesOffCode: false,
        profiles: (over.profiles ?? [
          { profile: 'default', solcVersion: '0.8.29', evmVersion: 'cancun' },
        ]) as never,
      }),
      refsFor: over.refsFor ?? (async () => REFS),
      readDeployedCode: over.readDeployedCode ?? (async () => DEPLOYED),
    })

  it('normalises through normalizeRuntimeCode, byte for byte', async () => {
    const observed = await observer()(ADDRESS, 'mainnet')
    const direct = normalizeRuntimeCode(DEPLOYED, REFS, { isZk: false })

    expect(direct.ok).toBe(true)
    if (!direct.ok) return
    expect(observed.maskedHash).toBe(direct.maskedHash)
    expect(observed.rawHash).toBe(direct.rawHash)
    expect(observed.rawByteLength).toBe(direct.rawByteLength)
    expect(observed.maskedByteCount).toBe(direct.maskedByteCount)
  })

  it('actually strips and masks — the normalised hash is not the raw one', async () => {
    const observed = await observer()(ADDRESS, 'mainnet')

    // The paired positive for the equality above: if the observer had wired the
    // bytes through anything that skipped stripping and masking, these three
    // would coincide and the comparison would be silently void.
    expect(observed.rawHash).toBe(keccak256(DEPLOYED))
    expect(observed.maskedHash).not.toBe(observed.rawHash)
    expect(observed.maskedByteCount).toBe(64)
  })

  it('reads the compiler version out of the deployed trailer', async () => {
    expect((await observer()(ADDRESS, 'mainnet')).solcVersion).toBe('0.8.29')
  })

  it('masks no offsets on a zk lineage, where immutables are not inlined', async () => {
    const zk = createRuntimeCodeObserver({
      scopeFor: () => ({
        isClosedSet: true,
        holdsImmutablesOffCode: false,
        profiles: [
          {
            profile: 'zksync',
            solcVersion: '0.8.29',
            evmVersion: 'cancun',
            zksolcVersion: '1.5.15',
          },
        ],
      }),
      refsFor: async () => REFS,
      readDeployedCode: async () => DEPLOYED,
    })

    const observed = await zk(ADDRESS, 'zksync')
    const direct = normalizeRuntimeCode(DEPLOYED, REFS, { isZk: true })

    expect(direct.ok).toBe(true)
    if (!direct.ok) return
    expect(observed.maskedByteCount).toBe(0)
    expect(observed.maskedHash).toBe(direct.maskedHash)
    // The zk and non-zk normalisations of the same bytes must differ, or the
    // isZk branch is not being taken.
    expect(observed.maskedHash).not.toBe(
      (await observer()(ADDRESS, 'mainnet')).maskedHash
    )
  })

  it('refuses an address that holds no code', async () => {
    expect(
      await rejection(
        observer({ readDeployedCode: async () => '0x' })(ADDRESS, 'mainnet')
      )
    ).toContain('no code')
  })

  it('refuses rather than guessing when the network has several lineages', async () => {
    expect(
      await rejection(
        observer({
          profiles: [
            { profile: 'default', solcVersion: '0.8.29', evmVersion: 'cancun' },
            { profile: 'other', solcVersion: '0.8.29', evmVersion: 'cancun' },
          ],
        })(ADDRESS, 'mainnet')
      )
    ).toContain('more than one')
  })

  it('refuses when the immutable offsets point outside the stripped code', async () => {
    expect(
      await rejection(
        observer({
          refsFor: async () => ({ '1': [{ start: 4000, length: 32 }] }),
        })(ADDRESS, 'mainnet')
      )
    ).toContain('cannot be normalised')
  })
})

describe('createRecordReader', () => {
  it('carries the contract identity and commit the rebuild needs', async () => {
    const read = createRecordReader({
      findByAddress: async () => ({
        contractName: 'AccessManagerFacet',
        version: '1.0.0',
        gitCommitHash: 'b'.repeat(40),
        address: ADDRESS,
        network: 'mainnet',
      }),
    })

    expect(await read(ADDRESS, 'mainnet')).toEqual({
      contractName: 'AccessManagerFacet',
      version: '1.0.0',
      gitCommitHash: 'b'.repeat(40),
    })
  })

  it('returns undefined when the record genuinely says nothing', async () => {
    const read = createRecordReader({ findByAddress: async () => null })

    expect(await read(ADDRESS, 'mainnet')).toBeUndefined()
  })

  it('throws when the store cannot be reached, never reporting an outage as silence', async () => {
    const read = createRecordReader({
      findByAddress: async () => {
        throw new Error('connection timed out')
      },
    })

    expect(await rejection(read(ADDRESS, 'mainnet'))).toContain('MongoDB')
  })
})

describe('resolveDeploymentRecord', () => {
  const row = (fields: Record<string, string>) => ({
    contractName: 'AllBridgeFacet',
    version: '2.1.1',
    gitCommitHash: 'a'.repeat(40),
    ...fields,
  })

  it('returns null when nothing matches', () => {
    expect(resolveDeploymentRecord([], ADDRESS, 'mainnet')).toBeNull()
  })

  it('returns the single record unchanged', () => {
    const only = row({})

    expect(resolveDeploymentRecord([only], ADDRESS, 'tron')).toBe(only)
  })

  it('returns the record when duplicates agree on every field', () => {
    const first = row({})

    expect(resolveDeploymentRecord([first, row({})], ADDRESS, 'tron')).toBe(
      first
    )
  })

  // The commit is what the rebuild is keyed on, so two of them is the same
  // disagreement as two versions, and the query is unsorted — picking either
  // would attest against a different source on an otherwise identical run.
  it('refuses duplicates that agree on version but name different commits', () => {
    expect(() =>
      resolveDeploymentRecord(
        [row({}), row({ gitCommitHash: 'b'.repeat(40) })],
        ADDRESS,
        'tron'
      )
    ).toThrow(/commit/)
  })

  // The verification step rewrites the row it verified and loses `version` on
  // the way through, so the blank row is the checked one. Comparing commits
  // only across what survives the blank-version collapse let the row that can
  // fill in a version vouch for a commit nobody verified.
  it('refuses when a blank-version row names a different commit', () => {
    expect(() =>
      resolveDeploymentRecord(
        [
          row({ version: '', gitCommitHash: 'c'.repeat(40) }),
          row({ gitCommitHash: 'd'.repeat(40) }),
        ],
        ADDRESS,
        'tron'
      )
    ).toThrow(/commit/)
  })

  // `UNKNOWN` is what the record writer stores when it could not read a commit,
  // and the downstream readers already treat it as absence. Counting it as a
  // claim would refuse a pair whose one real commit is the rebuild key.
  it('treats an UNKNOWN commit as absent rather than as a second claim', () => {
    const unknown = row({ gitCommitHash: 'UNKNOWN' })
    const withCommit = row({})

    expect(
      resolveDeploymentRecord([unknown, withCommit], ADDRESS, 'tron')
    ).toBe(withCommit)
    expect(
      resolveDeploymentRecord([withCommit, unknown], ADDRESS, 'tron')
    ).toBe(withCommit)
  })

  // The blank-version row is the one the verification step rewrote, so it can
  // be the only row naming a commit. Dropping it in the collapse and then
  // picking from the survivors returned a row with no commit, which reads
  // downstream as UNVERIFIABLE for an address whose one commit is right here.
  it('keeps the commit when the collapse drops the only row naming it', () => {
    const blank = row({ version: '', gitCommitHash: 'c'.repeat(40) })
    const versioned = row({ gitCommitHash: '' })

    const resolved = resolveDeploymentRecord(
      [blank, versioned],
      ADDRESS,
      'tron'
    )

    expect(resolved?.contractName).toBe('AllBridgeFacet')
    expect(resolved?.version).toBe('2.1.1')
    expect(resolved?.gitCommitHash).toBe('c'.repeat(40))
    expect(versioned.gitCommitHash).toBe('')
  })

  it('prefers the row carrying a commit over a blank sibling, whatever the order', () => {
    const withCommit = row({})
    const blank = row({ gitCommitHash: '' })

    expect(resolveDeploymentRecord([blank, withCommit], ADDRESS, 'tron')).toBe(
      withCommit
    )
    expect(resolveDeploymentRecord([withCommit, blank], ADDRESS, 'tron')).toBe(
      withCommit
    )
  })

  // Most production rows carry no commit field at all, so absence must stay a
  // resolvable answer rather than a refusal.
  it('resolves duplicates that carry no commit at all', () => {
    const first = { contractName: 'TokenWrapper', version: '1.1.0' }

    expect(
      resolveDeploymentRecord(
        [first, { contractName: 'TokenWrapper', version: '1.1.0' }],
        ADDRESS,
        'tron'
      )
    ).toBe(first)
  })

  it('treats a whitespace-only version as blank', () => {
    const versioned = row({ contractName: 'GasZipPeriphery', version: '1.0.2' })

    expect(
      resolveDeploymentRecord(
        [row({ contractName: 'GasZipPeriphery', version: '  ' }), versioned],
        ADDRESS,
        'moonbeam'
      )
    ).toBe(versioned)
  })

  // Blankness was judged trimmed while the identity key used the raw string, so
  // a single space split one deploy into two identities and refused it.
  it('collapses a whitespace-only version against a blank sibling', () => {
    const first = row({ contractName: 'PolymerCCTPFacet', version: '  ' })

    expect(
      resolveDeploymentRecord(
        [first, row({ contractName: 'PolymerCCTPFacet', version: '' })],
        ADDRESS,
        'base'
      )
    ).toBe(first)
  })

  it('does not split one version across rows that pad it differently', () => {
    const first = row({ version: '2.1.1' })

    expect(
      resolveDeploymentRecord(
        [first, row({ version: ' 2.1.1 ' })],
        ADDRESS,
        'tron'
      )
    ).toBe(first)
  })

  // `version` is optional on the record interface, and a row omitting it used
  // to surface at the signer as "could not be read: undefined is not an object".
  it('treats an absent version as blank rather than throwing', () => {
    const named = { contractName: 'TokenWrapper', version: '1.1.0' }

    expect(
      resolveDeploymentRecord(
        [{ contractName: 'TokenWrapper' }, named],
        ADDRESS,
        'tron'
      )
    ).toBe(named)
  })

  // Optional chaining defends against an absent field, not against a stored
  // number, which reached the signer as "could not be read: r.version.trim is
  // not a function" — the unactionable message this resolver exists to replace.
  it('coerces a non-string version instead of dying on its type', () => {
    const numeric = {
      contractName: 'TokenWrapper',
      version: 2 as unknown as string,
    }

    expect(resolveDeploymentRecord([numeric], ADDRESS, 'tron')).toBe(numeric)
  })

  it('names the conflict when a non-string version disagrees with a real one', () => {
    expect(() =>
      resolveDeploymentRecord(
        [
          { contractName: 'TokenWrapper', version: 2 as unknown as string },
          { contractName: 'TokenWrapper', version: '1.1.0' },
        ],
        ADDRESS,
        'tron'
      )
    ).toThrow(/TokenWrapper@1\.1\.0/)
  })

  it('refuses a three-row group where only one row dissents', () => {
    expect(() =>
      resolveDeploymentRecord(
        [row({}), row({}), row({ version: '2.1.2' })],
        ADDRESS,
        'tron'
      )
    ).toThrow(/2\.1\.2/)
  })

  it('resolves a group of blank-version rows that name one contract', () => {
    const first = row({ version: '' })

    expect(
      resolveDeploymentRecord([first, row({ version: '' })], ADDRESS, 'base')
    ).toBe(first)
  })

  // The verification step rewrites the row it just verified and drops `version`
  // on the way through, leaving two rows for one deploy that differ only there.
  // Both describe the same contract, so the versioned one is the answer.
  it('ignores a blank-version duplicate of a named contract', () => {
    const versioned = row({
      contractName: 'PolymerCCTPFacet',
      version: '2.0.0',
    })
    const blank = row({ contractName: 'PolymerCCTPFacet', version: '' })

    expect(resolveDeploymentRecord([blank, versioned], ADDRESS, 'base')).toBe(
      versioned
    )
  })

  it('keeps a blank-version row when no other row names that contract', () => {
    const blank = row({ contractName: 'GasZipPeriphery', version: '' })

    expect(resolveDeploymentRecord([blank], ADDRESS, 'moonbeam')).toBe(blank)
  })

  // The real tron/AllBridgeFacet pair: one address, two versions. Whichever way
  // a sort broke the tie it would name a version to rebuild, and one of the two
  // is wrong, so the gate must refuse rather than pick.
  it('refuses two versions of one contract at one address', () => {
    const conflict = () =>
      resolveDeploymentRecord(
        [row({ version: '2.1.1' }), row({ version: '2.1.2' })],
        ADDRESS,
        'tron'
      )

    expect(conflict).toThrow(/2\.1\.1/)
    expect(conflict).toThrow(/2\.1\.2/)
  })

  it('refuses two contracts at one address', () => {
    expect(() =>
      resolveDeploymentRecord(
        [
          row({ contractName: 'LiFuelFeeCollector', version: '1.0.1' }),
          row({ contractName: 'TokenWrapper', version: '1.0.1' }),
        ],
        ADDRESS,
        'metis'
      )
    ).toThrow(/TokenWrapper/)
  })

  it('names the address and network it could not resolve', () => {
    expect(() =>
      resolveDeploymentRecord(
        [row({ version: '2.1.1' }), row({ version: '2.1.2' })],
        ADDRESS,
        'tron'
      )
    ).toThrow(new RegExp(`${ADDRESS}.*tron|tron.*${ADDRESS}`))
  })

  it('refuses a conflict that a blank-version row cannot collapse', () => {
    expect(() =>
      resolveDeploymentRecord(
        [
          row({ contractName: 'TokenWrapper', version: '' }),
          row({ contractName: 'AllBridgeFacet', version: '2.1.1' }),
        ],
        ADDRESS,
        'tron'
      )
    ).toThrow(/TokenWrapper/)
  })
})

describe('createForgeRebuildRunner', () => {
  const artifact = JSON.stringify({
    deployedBytecode: { object: DEPLOYED, immutableReferences: REFS },
    ast: { absolutePath: 'src/Facets/AccessManagerFacet.sol' },
  })
  /** The repo's own `foundry.toml` stands in for the checkout's. */
  const CHECKOUT_TOML = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'foundry.toml'),
    'utf8'
  )
  /**
   * Serves the checkout's `foundry.toml` so the rebuild can resolve its profile
   * there, and hands every other path (the artifact, the repo root's own toml
   * that the zk pin is read from) to the reader a test supplies.
   */
  const readCheckoutFiles =
    (readRest: (path: string) => string) =>
    (path: string): string =>
      path.startsWith('/tmp/rebuilds/') && path.endsWith('foundry.toml')
        ? CHECKOUT_TOML
        : readRest(path)
  const readCheckoutFile = readCheckoutFiles(() => artifact)

  /**
   * What zksolc actually emits: the whole contract under `bytecode`, with no
   * `deployedBytecode` and no `ast`. Verified against every artifact under
   * `zkout/`, and byte-for-byte against the deployed `FraxFacet` on zksync.
   */
  const zkArtifact = JSON.stringify({ bytecode: { object: DEPLOYED } })

  const PINNED_ZK_RELEASE = 'v0.0.32'

  /** Only the section the pin reader walks, in the shape `foundry.toml` carries it. */
  const pinnedToml = [
    '[external.zksync]',
    'zksolc = "1.5.15"',
    `foundry_zksync = "${PINNED_ZK_RELEASE}"`,
    '',
  ].join('\n')

  /** What the pinned binary prints, verbatim. */
  const zkVersionOutput = `forge Version: 1.3.5-foundry-zksync-${PINNED_ZK_RELEASE}\nCommit SHA: 742672d7d51ed77b434bffb03804a59a760ce5fe`

  const readZkFiles = (artifactJson: string): ((path: string) => string) =>
    readCheckoutFiles((path) =>
      path.endsWith('foundry.toml') ? pinnedToml : artifactJson
    )

  const zkRequest = {
    contractName: 'AccessManagerFacet',
    commit: 'a'.repeat(40),
    profile: {
      profile: 'zksync',
      solcVersion: '0.8.29',
      evmVersion: 'cancun',
      zksolcVersion: '1.5.15',
    },
  }

  const runner = (
    over: {
      run?: (
        command: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> }
      ) => { ok: boolean; output: string }
      exists?: (path: string) => boolean
      readFile?: (path: string) => string
      readDeclarations?: (
        outDir: string,
        sourceRoot: string
      ) => readonly IImmutableDeclaration[]
      artifactCache?: {
        restore: (key: string, outDir: string) => boolean
        save: (key: string, outDir: string) => void
      }
      calls?: unknown[]
    } = {}
  ) => {
    const calls: unknown[] = over.calls ?? []
    const gitCalls: string[][] = []
    return {
      calls,
      gitCalls,
      runner: createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: (args) => {
          gitCalls.push(args)
          return ''
        },
        run:
          over.run ??
          ((command, args, options) => {
            calls.push({ command, args, env: options.env, cwd: options.cwd })
            return { ok: true, output: '' }
          }),
        exists: over.exists ?? ((path) => path.endsWith('.json')),
        readFile: over.readFile ?? readCheckoutFile,
        readDeclarations: over.readDeclarations ?? (() => []),
        ...(over.artifactCache ? { artifactCache: over.artifactCache } : {}),
      }),
    }
  }

  const request = {
    contractName: 'AccessManagerFacet',
    commit: 'a'.repeat(40),
    profile: {
      profile: 'default',
      solcVersion: '0.8.29',
      evmVersion: 'cancun',
    },
  }

  it('returns the runtime bytecode and immutable references from the artifact', () => {
    const built = runner().runner.build(request)

    expect(built.runtimeHex).toBe(DEPLOYED)
    expect(built.immutableReferences).toEqual(REFS)
  })

  // A cold compile of the whole tree is the minute a signer waits before zone 2
  // appears, and the checkout it lands in dies with the process — so the same
  // commit was recompiled from scratch once per signing session.
  it('takes a cached build instead of compiling, and does not init submodules for it', () => {
    let restored = false
    const calls: unknown[] = []
    const harness = runner({
      calls,
      exists: (path) => (path.endsWith('.json') ? restored : true),
      artifactCache: {
        restore: () => {
          restored = true
          return true
        },
        save: () => undefined,
      },
    })

    const built = harness.runner.build(request)

    expect(built.runtimeHex).toBe(DEPLOYED)
    expect(calls).toHaveLength(0)
    expect(harness.gitCalls.some(([verb]) => verb === 'submodule')).toBe(false)
  })

  it('keys the cache on the commit and the profile, and saves what it built', () => {
    const saved: string[] = []
    const harness = runner({
      exists: (path) => !path.endsWith('.json'),
      artifactCache: { restore: () => false, save: (key) => saved.push(key) },
    })

    // `exists` reports the artifact absent throughout, which the runner treats
    // as a build that produced nothing — the throw is what proves the save is
    // reached only for an artifact this run can vouch for.
    expect(() => harness.runner.build(request)).toThrow('produced no artifact')
    expect(saved).toHaveLength(0)

    let compiled = false
    const ok = runner({
      exists: (path) => (path.endsWith('.json') ? compiled : true),
      run: (_command, args) => {
        // The zk leg of this case runs the pinned-release check first, which
        // spawns the binary before any build.
        if (args.includes('--version'))
          return { ok: true, output: zkVersionOutput }
        compiled = true
        return { ok: true, output: '' }
      },
      // Both spellings, so the one build here stands in for either toolchain:
      // zksolc writes the runtime under `bytecode`, everything else under
      // `deployedBytecode`.
      readFile: readZkFiles(
        JSON.stringify({
          bytecode: { object: DEPLOYED },
          deployedBytecode: { object: DEPLOYED, immutableReferences: REFS },
          ast: { absolutePath: 'src/Facets/AccessManagerFacet.sol' },
        })
      ),
      artifactCache: { restore: () => false, save: (key) => saved.push(key) },
    })
    ok.runner.build(request)
    compiled = false
    // A real zk profile, which writes to the fixed `zkout` whatever it is
    // called — so the profile has to be in the key rather than only in the
    // directory the key is spelled from.
    ok.runner.build({
      ...request,
      profile: {
        ...request.profile,
        profile: 'zksync',
        zksolcVersion: '1.5.15',
      },
    })

    expect(saved).toEqual([
      `${'a'.repeat(40)}-default-out-codehash-default`,
      `${'a'.repeat(40)}-zksync-zkout`,
    ])
  })

  it('builds with --ast, so the ids keying the offsets come from this compilation', () => {
    let built = false
    const calls: unknown[] = []
    const harness = runner({
      calls,
      exists: (path) => (path.endsWith('.json') ? built : true),
      run: (command, args) => {
        built = true
        calls.push({ command, args })
        return { ok: true, output: '' }
      },
    })
    harness.runner.build(request)

    expect((calls[0] as { args: string[] }).args).toContain('--ast')
  })

  it("returns the graded contract's declarations, resolved against its own checkout", () => {
    const seen: { outDir: string; sourceRoot: string }[] = []
    const built = runner({
      readDeclarations: (outDir, sourceRoot) => {
        seen.push({ outDir, sourceRoot })
        return [
          {
            file: 'src/a.sol',
            contract: 'AccessManagerFacet',
            line: 4,
            astId: 8938,
            type: 'address',
            name: 'EXECUTOR',
          },
          {
            file: 'src/b.sol',
            contract: 'SomeOtherFacet',
            line: 9,
            astId: 41,
            type: 'address',
            name: 'OTHER',
          },
        ]
      },
    }).runner.build(request)

    expect(built.immutableDeclarations?.map((one) => one.name)).toEqual([
      'EXECUTOR',
    ])
    expect(seen[0]?.sourceRoot).toBe(`/tmp/rebuilds/${'a'.repeat(40)}`)
    expect(seen[0]?.outDir).toBe(
      `/tmp/rebuilds/${'a'.repeat(40)}/out-codehash-default`
    )
  })

  it('rebuilds an artifact that carries no AST rather than pricing nothing against it', () => {
    const astless = JSON.stringify({
      deployedBytecode: { object: DEPLOYED, immutableReferences: REFS },
    })
    // The artifact is present throughout, so the missing AST is the only thing
    // that can make this rebuild.
    const calls: unknown[] = []
    const harness = runner({
      calls,
      exists: () => true,
      readFile: readCheckoutFiles(() => astless),
      run: (command, args) => {
        calls.push({ command, args })
        return { ok: true, output: '' }
      },
    })
    harness.runner.build(request)

    expect(calls).toHaveLength(1)
  })

  it('does not rebuild when the artifact on disk already carries its AST', () => {
    const harness = runner({ exists: (path) => path.endsWith('.json') })
    harness.runner.build(request)

    expect(harness.calls).toHaveLength(0)
  })

  it('checks the commit out in its own worktree, never in the repo it runs from', () => {
    const harness = runner({ exists: (path) => path.endsWith('.json') })
    harness.runner.build(request)

    expect(harness.gitCalls[0]?.slice(0, 3)).toEqual([
      'worktree',
      'add',
      '--detach',
    ])
    // The path is the dimension this test is about, so it is the one asserted:
    // under the checkout root, never under the repo the signer is running from.
    expect(harness.gitCalls[0]?.[3]).toBe(`/tmp/rebuilds/${request.commit}`)
    expect(harness.gitCalls[0]?.[3]?.startsWith('/repo')).toBe(false)
    expect(harness.gitCalls[0]?.[4]).toBe(request.commit)
  })

  it('pins submodules in the worktree before forging, and builds offline without test/script trees', () => {
    const gitCalls: string[][] = []
    let built = false
    const seenArgs: string[] = []
    createForgeRebuildRunner({
      repoRoot: '/repo',
      checkoutRoot: '/tmp/rebuilds',
      git: (args) => {
        gitCalls.push(args)
        if (args.includes('status'))
          return ' e50c24f5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa lib/openzeppelin-contracts (v4.9.2)\n'
        return ''
      },
      run: (_command, args) => {
        seenArgs.push(...args)
        built = true
        return { ok: true, output: '' }
      },
      exists: (path) => (path.endsWith('.json') ? built : false),
      readFile: readCheckoutFile,
      readDeclarations: () => [],
    }).build(request)

    expect(gitCalls[0]?.slice(0, 3)).toEqual(['worktree', 'add', '--detach'])
    expect(gitCalls[1]).toEqual([
      '-C',
      `/tmp/rebuilds/${request.commit}`,
      'submodule',
      'update',
      '--init',
      '--recursive',
    ])
    expect(gitCalls[2]?.slice(0, 4)).toEqual([
      '-C',
      `/tmp/rebuilds/${request.commit}`,
      'submodule',
      'status',
    ])
    expect(seenArgs).toContain('--offline')
    expect(seenArgs).toEqual(
      expect.arrayContaining(['--skip', 'test/**', '--skip', 'script/**'])
    )
    expect(seenArgs).not.toContain('test')
    expect(seenArgs).not.toContain('script')
  })

  it('refuses to rebuild when submodule pins drifted after update', () => {
    expect(() =>
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: (args) => {
          if (args.includes('status'))
            return '+bbf3600daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa lib/openzeppelin-contracts (v4.8.0)\n'
          return ''
        },
        run: () => ({ ok: true, output: '' }),
        exists: () => false,
        readFile: readCheckoutFile,
        readDeclarations: () => [],
      }).build(request)
    ).toThrow(/submodule pins are not clean/)
  })

  it('builds under the profile it was asked for', () => {
    const harness = runner({ exists: () => false })
    let built = false
    const withRun = createForgeRebuildRunner({
      repoRoot: '/repo',
      checkoutRoot: '/tmp/rebuilds',
      git: () => '',
      run: (command, args, options) => {
        built = true
        expect(command).toBe('forge')
        expect(args).toContain('build')
        expect(options.env.FOUNDRY_PROFILE).toBe('default')
        return { ok: true, output: '' }
      },
      exists: (path) => !path.endsWith('.json') || built,
      readFile: readCheckoutFile,
      readDeclarations: () => [],
    })

    withRun.build(request)
    expect(built).toBe(true)
    expect(harness.calls).toEqual([])
  })

  describe('resolves the profile against the checkout, not HEAD', () => {
    const londonProfile = {
      profile: 'solc_floor',
      solcVersion: '0.8.17',
      evmVersion: 'london',
    }
    const buildWithToml = (
      toml: string,
      profile: IBuildProfile = londonProfile
    ): { env: Record<string, string>[]; build: () => void } => {
      const env: Record<string, string>[] = []
      const harness = createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: (_command, args, options) => {
          // The pin check runs ahead of the profile resolution, so a zk
          // request has to pass it before the toml can be judged.
          if (args[0] === '--version')
            return { ok: true, output: zkVersionOutput }
          env.push(options.env)
          return { ok: true, output: '' }
        },
        exists: (path) => !path.endsWith('.json') || env.length > 0,
        readFile: (path) => (path.endsWith('foundry.toml') ? toml : artifact),
        readDeclarations: () => [],
      })
      return { env, build: () => harness.build({ ...request, profile }) }
    }

    it('exports the name the checkout gives the pair when it differs from HEAD', () => {
      // Two fuse deployments were made from a branch that spelled the london
      // profile `london`; HEAD spells it `solc_floor`. Both must rebuild.
      const renamed = CHECKOUT_TOML.replace(
        '[profile.solc_floor]',
        '[profile.london]'
      )
      expect(renamed).not.toBe(CHECKOUT_TOML)
      const harness = buildWithToml(renamed)

      harness.build()

      expect(harness.env.map((env) => env.FOUNDRY_PROFILE)).toEqual(['london'])
    })

    it('exports the HEAD name when the checkout spells it the same', () => {
      const harness = buildWithToml(CHECKOUT_TOML)

      harness.build()

      expect(harness.env.map((env) => env.FOUNDRY_PROFILE)).toEqual([
        'solc_floor',
      ])
    })

    it('refuses instead of building when no profile in the checkout pins the pair', () => {
      // forge would answer the unknown name with [profile.default] and exit 0.
      const withoutLondon = CHECKOUT_TOML.replace(
        "solc_version = '0.8.17'",
        "solc_version = '0.8.19'"
      )
      expect(withoutLondon).not.toBe(CHECKOUT_TOML)
      const harness = buildWithToml(withoutLondon)

      expect(() => harness.build()).toThrow(/declares no profile pinning/)
      expect(harness.env).toEqual([])
    })

    it('does not admit the zk profile as a cancun lineage for a non-zk request', () => {
      // [profile.zksync] pins the default pair too; without the zksolc pin it
      // would read as a plain cancun profile and make the match ambiguous.
      const unpinnedZk = CHECKOUT_TOML.replace(/^zksolc = .*$/m, '')
      expect(unpinnedZk).not.toBe(CHECKOUT_TOML)
      const harness = buildWithToml(unpinnedZk, request.profile)

      harness.build()

      expect(harness.env.map((env) => env.FOUNDRY_PROFILE)).toEqual(['default'])
    })

    it('refuses a zk rebuild in a checkout without [profile.zksync]', () => {
      const withoutZk = CHECKOUT_TOML.replace(
        '[profile.zksync]',
        '[profile.renamed_away]'
      ).replace(/^zksolc = .*$/m, '')
      const harness = buildWithToml(withoutZk, {
        ...request.profile,
        profile: 'zksync',
        zksolcVersion: '1.5.15',
      })

      expect(() => harness.build()).toThrow(/declares no \[profile\.zksync\]/)
      expect(harness.env).toEqual([])
    })
  })

  it('builds a zk lineage with the pinned foundry-zksync binary', () => {
    let seen: { command: string; args: string[]; env: Record<string, string> } =
      { command: '', args: [], env: {} }
    let built = false
    const zk = createForgeRebuildRunner({
      repoRoot: '/repo',
      checkoutRoot: '/tmp/rebuilds',
      git: () => '',
      run: (command, args, options) => {
        if (args[0] === '--version')
          return { ok: true, output: zkVersionOutput }
        seen = { command, args, env: options.env }
        built = true
        return { ok: true, output: '' }
      },
      exists: (path) => (path.endsWith('.json') ? built : true),
      readFile: readZkFiles(zkArtifact),
      readDeclarations: () => [],
    })

    zk.build(zkRequest)

    expect(seen.command).toContain('foundry-zksync')
    expect(seen.args).toContain('--zksync')
    expect(seen.env.FOUNDRY_ZKSYNC).toContain('1.5.15')
    expect(seen.env.FOUNDRY_PROFILE).toBe('zksync')
  })

  describe('zk toolchain preflight', () => {
    const zkRunner = (over: {
      exists?: (path: string) => boolean
      readFile?: (path: string) => string
      version?: { ok: boolean; output: string }
      onBuild?: () => void
    }) =>
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: (_command, args) => {
          if (args[0] === '--version')
            return over.version ?? { ok: true, output: zkVersionOutput }
          over.onBuild?.()
          return { ok: true, output: '' }
        },
        exists: over.exists ?? ((path) => !path.endsWith('.json')),
        readFile: over.readFile
          ? readCheckoutFiles(over.readFile)
          : readZkFiles(zkArtifact),
        readDeclarations: () => [],
      })

    it('refuses when the untracked foundry-zksync binary is absent', () => {
      let compiled = false
      expect(() =>
        zkRunner({
          exists: (path) => !path.endsWith('.json') && !path.endsWith('forge'),
          onBuild: () => {
            compiled = true
          },
        }).build(zkRequest)
      ).toThrow(/toolchain problem, not a codehash verdict/)
      expect(compiled).toBe(false)
    })

    it('names the install path a signer can act on', () => {
      expect(() =>
        zkRunner({
          exists: (path) => !path.endsWith('.json') && !path.endsWith('forge'),
        }).build(zkRequest)
      ).toThrow(/source script\/helperFunctions\.sh && install_foundry_zksync/)
    })

    it('refuses a binary that is not the pinned release', () => {
      expect(() =>
        zkRunner({
          version: {
            ok: true,
            output: 'forge Version: 1.3.5-foundry-zksync-v0.0.31',
          },
        }).build(zkRequest)
      ).toThrow(/foundry-zksync v0\.0\.31 but foundry\.toml pins v0\.0\.32/)
    })

    it('refuses a binary whose version it cannot read', () => {
      expect(() =>
        zkRunner({ version: { ok: false, output: 'bad CPU type' } }).build(
          zkRequest
        )
      ).toThrow(/did not report a foundry-zksync release/)
    })

    it('refuses when foundry.toml pins no release to hold the rebuild to', () => {
      expect(() =>
        zkRunner({
          readFile: (path) =>
            path.endsWith('foundry.toml')
              ? '[external.zksync]\nzksolc = "1.5.15"\n'
              : zkArtifact,
        }).build(zkRequest)
      ).toThrow(/pins no foundry_zksync release/)
    })

    it('reads the pin from the section it lives in, not from anywhere in the file', () => {
      expect(() =>
        zkRunner({
          readFile: (path) =>
            path.endsWith('foundry.toml')
              ? '[profile.zksync]\nfoundry_zksync = "v0.0.32"\n\n[external.zksync]\nzksolc = "1.5.15"\n'
              : zkArtifact,
        }).build(zkRequest)
      ).toThrow(/pins no foundry_zksync release/)
    })

    it('leaves a vanilla forge build unchecked', () => {
      const probed: string[][] = []
      let built = false
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: (_command, args) => {
          probed.push(args)
          built = true
          return { ok: true, output: '' }
        },
        exists: (path) => (path.endsWith('.json') ? built : true),
        readFile: readCheckoutFile,
        readDeclarations: () => [],
      }).build(request)

      expect(probed.every((args) => args[0] === 'build')).toBe(true)
    })
  })

  it('keeps each profile in its own output directory', () => {
    const paths: string[] = []
    let built = false
    const seen = (profile: { profile: string; zksolcVersion?: string }) => {
      paths.length = 0
      built = false
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: (_command, args) => {
          if (args[0] === '--version')
            return { ok: true, output: zkVersionOutput }
          built = true
          return { ok: true, output: '' }
        },
        exists: (path) => {
          paths.push(path)
          return path.endsWith('.json') ? built : true
        },
        readFile: readZkFiles(
          profile.zksolcVersion === undefined ? artifact : zkArtifact
        ),
        readDeclarations: () => [],
      }).build({
        ...request,
        profile: { ...request.profile, ...profile },
      })
      return paths.filter((path) => path.endsWith('.json'))
    }

    const zk = seen({ profile: 'zksync', zksolcVersion: '1.5.15' })
    const floor = seen({ profile: 'solc_floor' })

    // Two non-zk profiles share `out/` in foundry's own layout, and this runner
    // builds several profiles inside one checkout, so a shared directory would
    // hand the second profile the first one's artifact.
    // zk is not profile-named: foundry-zksync ignores `--out` and always writes
    // `zkout/`, so the runner must read there or find nothing.
    expect(zk[0]).toContain('zkout')
    expect(floor[0]).toContain('solc_floor')
    expect(zk[0]).not.toBe(floor[0])
  })

  it('throws with the build output when the compile fails', () => {
    expect(() =>
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: () => ({
          ok: false,
          output: 'Compiler run failed: stack too deep',
        }),
        exists: () => false,
        readFile: readCheckoutFile,
        readDeclarations: () => [],
      }).build(request)
    ).toThrow(/stack too deep/)
  })

  it('redacts a keyed URL out of a build failure it reports', () => {
    let thrown = ''
    try {
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: () => ({
          ok: false,
          output:
            'backend error: https://rpc.example.com/ogrpc?dkey=SUPERSECRET',
        }),
        exists: () => false,
        readFile: readCheckoutFile,
        readDeclarations: () => [],
      }).build(request)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }

    expect(thrown).not.toContain('SUPERSECRET')
    expect(thrown).toContain('backend error')
  })

  it('throws when the build reports success but leaves no artifact', () => {
    expect(() =>
      createForgeRebuildRunner({
        repoRoot: '/repo',
        checkoutRoot: '/tmp/rebuilds',
        git: () => '',
        run: () => ({ ok: true, output: '' }),
        exists: (path) => !path.endsWith('.json'),
        readFile: readCheckoutFile,
        readDeclarations: () => [],
      }).build(request)
    ).toThrow(/artifact/)
  })

  it('throws when the artifact carries no runtime bytecode', () => {
    expect(() =>
      runner({
        readFile: (path) =>
          path.endsWith('foundry.toml')
            ? CHECKOUT_TOML
            : JSON.stringify({ deployedBytecode: {} }),
        readDeclarations: () => [],
      }).runner.build(request)
    ).toThrow(/runtime bytecode/)
  })

  it('compiles once for two requests that would produce the same artifact', () => {
    let builds = 0
    let built = false
    const cached = createForgeRebuildRunner({
      repoRoot: '/repo',
      checkoutRoot: '/tmp/rebuilds',
      git: () => '',
      run: () => {
        builds += 1
        built = true
        return { ok: true, output: '' }
      },
      exists: (path) => (path.endsWith('.json') ? built : true),
      readFile: readCheckoutFile,
      readDeclarations: () => [],
    })

    cached.build(request)
    cached.build(request)

    expect(builds).toBe(1)
  })

  it('removes the worktrees it created', () => {
    const gitCalls: string[][] = []
    const withCleanup = createForgeRebuildRunner({
      repoRoot: '/repo',
      checkoutRoot: '/tmp/rebuilds',
      git: (args) => {
        gitCalls.push(args)
        return ''
      },
      run: () => ({ ok: true, output: '' }),
      exists: (path) => path.endsWith('.json'),
      readFile: readCheckoutFile,
      readDeclarations: () => [],
    })

    withCleanup.build(request)
    withCleanup.cleanup()

    expect(
      gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'remove')
    ).toBe(true)
  })
})

describe('createPinnedImmutableExpectations', () => {
  const REQUIREMENTS = 'script/deploy/resources/deployRequirements.json'
  const REGISTRY = 'script/deploy/resources/immutableRegistry.json'

  const pinned = (blobs: Record<string, PinnedJsonRead>) => {
    const asked: string[] = []
    const source = createPinnedImmutableExpectations((repoPath) => {
      asked.push(repoPath)
      return blobs[repoPath] ?? { ok: false, reason: 'blob-unreadable' }
    })
    return { source, asked }
  }

  it('joins the registry and the requirements as the pinned commit has them', () => {
    const { source, asked } = pinned({
      [REQUIREMENTS]: {
        ok: true,
        value: {
          OnlyOnMainFacet: {
            configData: {
              _bridge: { configFileName: 'x.json', keyInConfigFile: '.a' },
            },
          },
        },
      },
      [REGISTRY]: {
        ok: true,
        value: {
          OnlyOnMainFacet: {
            BRIDGE: { source: 'config', configData: '_bridge' },
          },
        },
      },
    })

    const requirements = source.loadRequirements()

    expect(asked).toEqual([REQUIREMENTS, REGISTRY])
    expect(requirements.OnlyOnMainFacet?.immutables?.BRIDGE).toEqual({
      source: 'config',
      configData: '_bridge',
    })
    // The checkout's own registry declares GasZipFacet; the pinned one here
    // does not, so finding it would mean the working tree was read.
    expect(
      readFileSync(join(import.meta.dir, '..', '..', '..', REGISTRY), 'utf8')
    ).toContain('"GasZipFacet"')
    expect(requirements.GasZipFacet).toBeUndefined()
  })

  it('throws when an expectation file cannot be read at the pinned commit', () => {
    const { source } = pinned({
      [REQUIREMENTS]: { ok: true, value: {} },
      [REGISTRY]: { ok: false, reason: 'fetch-failed' },
    })

    expect(() => source.loadRequirements()).toThrow(
      `${REGISTRY} could not be read at origin/main (fetch-failed)`
    )
  })

  it('reads a config file from config/ at the pinned commit', () => {
    const { source, asked } = pinned({
      'config/centrifuge.json': {
        ok: true,
        value: { tokenBridge: { mainnet: '0xpinned' } },
      },
    })

    expect(source.loadConfigFile('centrifuge.json')).toEqual({
      tokenBridge: { mainnet: '0xpinned' },
    })
    expect(asked).toEqual(['config/centrifuge.json'])
  })

  it('answers "expected value unknown" for a config file main does not carry', () => {
    const { source } = pinned({})

    expect(source.loadConfigFile('absent.json')).toBeNull()
  })

  it('never asks for a config name that is not a plain basename', () => {
    const { source, asked } = pinned({})

    expect(source.loadConfigFile('../foundry.json')).toBeNull()
    expect(asked).toEqual([])
  })

  it('throws rather than answering "unknown" when the anchor itself failed', () => {
    // A null here would grade as unpriceable with a reason blaming the config
    // file, when nothing about the file was learned.
    const { source } = pinned({
      'config/centrifuge.json': { ok: false, reason: 'remote-unexpected' },
    })

    expect(() => source.loadConfigFile('centrifuge.json')).toThrow(
      'config/centrifuge.json could not be read at origin/main (remote-unexpected)'
    )
  })
})
describe('createImmutableReferencesResolver', () => {
  const PROFILE = {
    profile: 'default',
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
  }

  const resolver = (
    record:
      | { contractName: string; version: string; gitCommitHash: string }
      | undefined,
    builds: string[]
  ) =>
    createImmutableReferencesResolver({
      readRecord: async () => record,
      scopeFor: () => ({
        isClosedSet: true,
        holdsImmutablesOffCode: false,
        profiles: [PROFILE],
      }),
      build: (request) => {
        builds.push(request.commit)
        return { runtimeHex: DEPLOYED, immutableReferences: REFS }
      },
    })

  it('rebuilds at the record commit and returns its offsets', async () => {
    const builds: string[] = []
    const refs = await resolver(
      {
        contractName: 'AccessManagerFacet',
        version: '1.0.0',
        gitCommitHash: `  ${'a'.repeat(40)}  `,
      },
      builds
    )(ADDRESS, 'mainnet')

    expect(refs).toEqual(REFS)
    expect(builds).toEqual(['a'.repeat(40)])
  })

  it.each([
    ['an empty commit', ''],
    ['the UNKNOWN placeholder', 'UNKNOWN'],
  ])('does not attempt a rebuild for %s', async (_label, gitCommitHash) => {
    const builds: string[] = []
    const refs = await resolver(
      { contractName: 'AccessManagerFacet', version: '1.0.0', gitCommitHash },
      builds
    )(ADDRESS, 'mainnet')

    // Paired with the positive above, where the same spy records one build.
    expect(builds).toEqual([])
    expect(refs).toBeUndefined()
  })

  it('returns no offsets when the record is silent about the address', async () => {
    const builds: string[] = []

    expect(
      await resolver(undefined, builds)(ADDRESS, 'mainnet')
    ).toBeUndefined()
    expect(builds).toEqual([])
  })
})

describe('defaultCheckoutRoot', () => {
  it('sits outside the repository and is scoped to the process', () => {
    const root = defaultCheckoutRoot(4242)

    expect(root).toContain('4242')
    expect(root.startsWith(join(import.meta.dir, '..', '..', '..'))).toBe(false)
    // Paired: a different process gets a different tree, so one run's teardown
    // cannot delete a concurrent run's checkouts.
    expect(defaultCheckoutRoot(4243)).not.toBe(root)
  })
})

describe('createForgeRebuildRunner refuses a commit it cannot trust', () => {
  it.each([
    ['a path traversal', '../../etc'],
    ['a git option', '--upload-pack=touch'],
    ['a short prefix', 'a'.repeat(7)],
    ['an uppercase SHA', 'A'.repeat(40)],
  ])('refuses %s before touching the filesystem', (_label, commit) => {
    const gitCalls: string[][] = []
    const runner = createForgeRebuildRunner({
      repoRoot: '/repo',
      checkoutRoot: '/tmp/rebuilds',
      git: (args) => {
        gitCalls.push(args)
        return ''
      },
      run: () => ({ ok: true, output: '' }),
      exists: () => false,
      readFile: () => '{}',
      readDeclarations: () => [],
    })

    expect(() =>
      runner.build({
        contractName: 'AccessManagerFacet',
        commit,
        profile: {
          profile: 'default',
          solcVersion: '0.8.29',
          evmVersion: 'cancun',
        },
      })
    ).toThrow(/40-character/)
    // Paired with the accepted-commit cases above, where the same spy records a
    // worktree add: nothing ran for a commit that was refused.
    expect(gitCalls).toEqual([])
  })
})

describe('createImmutableReferencesResolver refuses several lineages', () => {
  it('does not pick one profile when the network has two', async () => {
    const builds: string[] = []
    const resolve = createImmutableReferencesResolver({
      readRecord: async () => ({
        contractName: 'AccessManagerFacet',
        version: '1.0.0',
        gitCommitHash: 'a'.repeat(40),
      }),
      scopeFor: () => ({
        isClosedSet: true,
        holdsImmutablesOffCode: false,
        profiles: [
          { profile: 'default', solcVersion: '0.8.29', evmVersion: 'cancun' },
          { profile: 'other', solcVersion: '0.8.29', evmVersion: 'cancun' },
        ],
      }),
      build: (request) => {
        builds.push(request.commit)
        return { runtimeHex: DEPLOYED, immutableReferences: REFS }
      },
    })

    expect(await rejection(resolve(ADDRESS, 'mainnet'))).toContain(
      'per lineage'
    )
    expect(builds).toEqual([])
  })
})

describe('createDeployedCodeReader', () => {
  const PRIMARY = 'https://primary.example/rpc'
  const SECOND = 'https://second.example/rpc'
  const THIRD = 'https://third.example/rpc'
  const ADDRESS = '0x1111111111111111111111111111111111111111'

  const chainWith = (http: string[]): Chain =>
    ({
      id: 1,
      name: 'test',
      nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 },
      rpcUrls: { default: { http } },
    } as Chain)

  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /**
   * Answers each JSON-RPC method per host. `code` undefined marks the host
   * down, so a test can fail one endpoint without failing the rest.
   */
  const stub = (byHost: Record<string, string | undefined>): void => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input)
      const host = Object.keys(byHost).find((h) => url.startsWith(h))
      const code = host ? byHost[host] : undefined
      if (code === undefined) {
        const error = new Error('HTTP request failed: 503')
        error.name = 'HttpRequestError'
        throw error
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as {
        method?: string
        id?: number
      }
      const result =
        body.method === 'eth_chainId'
          ? '0x1'
          : body.method === 'eth_getBlockByNumber'
          ? { number: '0x64', hash: `0x${'ab'.repeat(32)}` }
          : code

      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch
  }

  it('takes the primary answer when the primary answers', async () => {
    stub({ [PRIMARY]: '0xfeed', [SECOND]: '0xbad' })
    const read = createDeployedCodeReader(() => chainWith([PRIMARY, SECOND]))

    expect(await read(ADDRESS, 'arbitrum')).toBe('0xfeed')
  })

  // The security property. A single fallback must not be able to decide the
  // gate that refuses a signature: a stale or hostile endpoint returning the
  // expected bytes would otherwise pass code that is not on chain.
  it('refuses a lone fallback answer when the primary is down', async () => {
    stub({ [PRIMARY]: undefined, [SECOND]: '0xfeed' })
    const read = createDeployedCodeReader(() => chainWith([PRIMARY, SECOND]))

    let threw = false
    try {
      await read(ADDRESS, 'arbitrum')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('accepts a fallback answer two independent providers agree on', async () => {
    stub({ [PRIMARY]: undefined, [SECOND]: '0xfeed', [THIRD]: '0xfeed' })
    const read = createDeployedCodeReader(() =>
      chainWith([PRIMARY, SECOND, THIRD])
    )

    expect(await read(ADDRESS, 'arbitrum')).toBe('0xfeed')
  })

  // Disagreement is the case the corroboration exists for.
  it('refuses when the fallbacks disagree', async () => {
    stub({ [PRIMARY]: undefined, [SECOND]: '0xfeed', [THIRD]: '0xdead' })
    const read = createDeployedCodeReader(() =>
      chainWith([PRIMARY, SECOND, THIRD])
    )

    let threw = false
    try {
      await read(ADDRESS, 'arbitrum')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('resolves the chain for the network it is asked about', async () => {
    stub({ [PRIMARY]: '0xfeed' })
    const asked: string[] = []
    await createDeployedCodeReader((n) => {
      asked.push(n)
      return chainWith([PRIMARY])
    })(ADDRESS, 'arbitrum')

    expect(asked).toEqual(['arbitrum'])
  })

  // The same read discipline over `ImmutableSimulator`, which gate L trusts on
  // exactly the same terms: it decides whether a signer is asked to confirm a
  // value, so one endpoint may not decide it alone.
  describe('createImmutableSimulatorReader', () => {
    const WORD = `0x${'00'.repeat(12)}${'22'.repeat(20)}`

    it('takes the primary answer when the primary answers', async () => {
      stub({ [PRIMARY]: WORD, [SECOND]: `0x${'33'.repeat(32)}` })
      const read = createImmutableSimulatorReader(() =>
        chainWith([PRIMARY, SECOND])
      )

      expect(await read('arbitrum', ADDRESS, 0)).toBe(WORD)
    })

    it('refuses a lone fallback answer when the primary is down', async () => {
      stub({ [PRIMARY]: undefined, [SECOND]: WORD })
      const read = createImmutableSimulatorReader(() =>
        chainWith([PRIMARY, SECOND])
      )

      let threw = false
      try {
        await read('arbitrum', ADDRESS, 0)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })

    it('rejects rather than returning a zero when nothing could be read', async () => {
      // Zero is a value an immutable legitimately holds, so a failed read that
      // resolved to it would be compared against an unset config entry and
      // reported as agreement.
      stub({})
      const read = createImmutableSimulatorReader(() => chainWith([PRIMARY]))

      let threw = false
      try {
        await read('arbitrum', ADDRESS, 0)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })
  })
})

/**
 * The zk half of layer 2, which reads the values out of a system contract
 * rather than out of the code. Every refusal below leaves gate L reporting "the
 * values were not established", which is a different row from "they disagree" —
 * so nothing here may collapse into a pricing that decided.
 */
describe('createImmutablePricer', () => {
  const BRIDGE = `${'22'.repeat(20)}`
  const RUNTIME = `0x${'5b'.repeat(32)}${'00'.repeat(12)}${BRIDGE}`

  const requirements: DeployRequirements = {
    CentrifugeFacet: {
      configData: {
        _tokenBridge: {
          configFileName: 'centrifuge.json',
          keyInConfigFile: '.tokenBridge.<NETWORK>',
        },
      },
      immutables: {
        TOKEN_BRIDGE: { source: 'config', configData: '_tokenBridge' },
      },
    },
  }

  const price = (configured: string) =>
    createImmutablePricer({
      readRecord: async () => ({
        contractName: 'CentrifugeFacet',
        version: '1.0.0',
        gitCommitHash: 'a'.repeat(40),
      }),
      scopeFor: () =>
        ({
          isClosedSet: true,
          holdsImmutablesOffCode: false,
          profiles: [
            { profile: 'default', solcVersion: '0.8.29', evmVersion: 'cancun' },
          ],
        } as unknown as IToolchainScope),
      build: () => ({
        runtimeHex: RUNTIME,
        immutableReferences: { '7': [{ start: 32, length: 32 }] },
        immutableDeclarations: [
          {
            file: 'src/Facets/CentrifugeFacet.sol',
            contract: 'CentrifugeFacet',
            line: 33,
            astId: 7,
            type: 'address',
            name: 'TOKEN_BRIDGE',
          },
        ],
      }),
      loadRequirements: () => requirements,
      loadConfigFile: (fileName) =>
        fileName === 'centrifuge.json'
          ? { tokenBridge: { mainnet: configured } }
          : null,
    })(ADDRESS, 'mainnet', RUNTIME)

  it('prices against the config the expectation source supplies', async () => {
    // config/centrifuge.json on disk names a different mainnet bridge, so both
    // verdicts below can only come from the injected loader.
    const agrees = await price(`0x${BRIDGE}`)
    const differs = await price(`0x${'33'.repeat(20)}`)

    if (agrees.decided) expect(agrees.slots[0]?.status).toBe('verified')
    else throw new Error(`expected a decided pricing: ${agrees.reason}`)
    if (differs.decided) expect(differs.slots[0]?.status).toBe('disagrees')
    else throw new Error(`expected a decided pricing: ${differs.reason}`)
  })
})

describe('createOffCodeImmutablesReader', () => {
  const ADDRESS = '0x1111111111111111111111111111111111111111'
  const WORD = `0x${'00'.repeat(12)}${'22'.repeat(20)}`

  const declaration = (name: string, line: number): IImmutableDeclaration => ({
    file: 'src/Facets/GasZipFacet.sol',
    contract: 'GasZipFacet',
    line,
    type: 'address',
    name,
  })

  const reader = (over: {
    record?: { contractName: string; version: string; gitCommitHash: string }
    declarations?: readonly IImmutableDeclaration[]
    covered?: boolean
    getImmutable?: (
      network: string,
      address: string,
      index: number
    ) => Promise<string>
    loadRequirements?: () => DeployRequirements
    loadConfigFile?: (fileName: string) => unknown
  }) =>
    createOffCodeImmutablesReader({
      readRecord: async () =>
        over.record ?? {
          contractName: 'GasZipFacet',
          version: '1.0.0',
          gitCommitHash: 'a'.repeat(40),
        },
      declarationsFor: () => ({
        covered: over.covered ?? true,
        declarations: over.declarations ?? [declaration('router', 22)],
      }),
      getImmutable: over.getImmutable ?? (async () => WORD),
      loadRequirements: over.loadRequirements ?? (() => ({})),
      loadConfigFile: over.loadConfigFile ?? (() => null),
    })

  it('reports a contract declaring no immutables as nothing to grade', async () => {
    const read = await reader({ declarations: [] })(ADDRESS, 'zksync')

    expect(read).toEqual({ declared: 'none' })
  })

  it('refuses when this checkout never compiled the recorded contract', async () => {
    // The same empty list a contract with no immutables produces. Grading it
    // `none` would pass a deployment whose values were never looked at.
    const read = await reader({ covered: false, declarations: [] })(
      ADDRESS,
      'zksync'
    )

    if (read.declared === 'some' && !read.pricing.decided)
      expect(read.pricing.reason).toContain('no AST from this checkout covers')
    else throw new Error('expected a refusal')
  })

  it('prices the value the simulator returned, and names its slot', async () => {
    const read = await reader({})(ADDRESS, 'zksync')

    expect(read).toMatchObject({
      declared: 'some',
      slotByName: { router: 0 },
    })
    if (read.declared === 'some' && read.pricing.decided)
      expect(read.pricing.slots[0]?.observed).toBe(WORD)
    else throw new Error('expected a decided pricing')
  })

  it('addresses the simulator by ordinal scaled to a whole word', async () => {
    const asked: number[] = []
    await reader({
      declarations: [
        declaration('backendSigner', 41),
        declaration('router', 22),
      ],
      getImmutable: async (_network, _address, index) => {
        asked.push(index)
        return WORD
      },
    })(ADDRESS, 'zksync')

    expect(asked).toEqual([0, 32])
  })

  it('refuses rather than pricing when the record says nothing', async () => {
    const read = await createOffCodeImmutablesReader({
      readRecord: async () => undefined,
      declarationsFor: () => ({
        covered: true,
        declarations: [declaration('router', 22)],
      }),
      getImmutable: async () => WORD,
      loadRequirements: () => ({}),
      loadConfigFile: () => null,
    })(ADDRESS, 'zksync')

    expect(read).toMatchObject({ declared: 'some' })
    if (read.declared === 'some') expect(read.pricing.decided).toBe(false)
  })

  it('refuses rather than defaulting when a slot could not be read', async () => {
    // Zero is a value an immutable legitimately holds, so a failed read that
    // defaulted to it would compare against an unset config entry and match.
    const read = await reader({
      getImmutable: async () => {
        throw new Error('ImmutableSimulator unreachable')
      },
    })(ADDRESS, 'zksync')

    if (read.declared === 'some' && !read.pricing.decided)
      expect(read.pricing.reason).toContain('unreachable')
    else throw new Error('expected a refusal')
  })

  it('prices against the config the expectation source supplies', async () => {
    const requirements: DeployRequirements = {
      GasZipFacet: {
        configData: {
          _router: {
            configFileName: 'fixture.json',
            keyInConfigFile: '.routers.<NETWORK>',
          },
        },
        immutables: { router: { source: 'config', configData: '_router' } },
      },
    }
    const priced = (configured: string) =>
      reader({
        loadRequirements: () => requirements,
        loadConfigFile: (fileName) =>
          fileName === 'fixture.json'
            ? { routers: { zksync: configured } }
            : null,
      })(ADDRESS, 'zksync')

    const agrees = await priced(`0x${'22'.repeat(20)}`)
    const differs = await priced(`0x${'33'.repeat(20)}`)

    if (agrees.declared === 'some' && agrees.pricing.decided)
      expect(agrees.pricing.slots[0]?.status).toBe('verified')
    else throw new Error('expected a decided pricing')
    if (differs.declared === 'some' && differs.pricing.decided)
      expect(differs.pricing.slots[0]?.status).toBe('disagrees')
    else throw new Error('expected a decided pricing')
  })

  it('refuses when declaration order does not determine a numbering', async () => {
    const read = await reader({
      declarations: [declaration('router', 22), declaration('signer', 22)],
    })(ADDRESS, 'zksync')

    if (read.declared === 'some') expect(read.pricing.decided).toBe(false)
    else throw new Error('expected a refusal')
  })
})

describe('createLocalImmutableDeclarations', () => {
  it('compiles once and answers every contract from that one read', () => {
    // It builds the whole of `src/`, so a second call per target would put a
    // full compile on each address a cut installs.
    let builds = 0
    const declarationsFor = createLocalImmutableDeclarations(() => {
      builds += 1
      return {
        declarations: [
          {
            file: 'src/Facets/GasZipFacet.sol',
            contract: 'GasZipFacet',
            line: 22,
            type: 'address',
            name: 'router',
          },
          {
            file: 'src/Facets/OtherFacet.sol',
            contract: 'OtherFacet',
            line: 10,
            type: 'address',
            name: 'other',
          },
        ],
        contracts: new Set(['GasZipFacet', 'OtherFacet', 'QuietFacet']),
      }
    })

    expect(
      declarationsFor('GasZipFacet').declarations.map((one) => one.name)
    ).toEqual(['router'])
    expect(
      declarationsFor('OtherFacet').declarations.map((one) => one.name)
    ).toEqual(['other'])
    expect(builds).toBe(1)
  })

  it('separates a contract the AST covered from one it never saw', () => {
    const declarationsFor = createLocalImmutableDeclarations(() => ({
      declarations: [],
      contracts: new Set(['QuietFacet']),
    }))

    expect(declarationsFor('QuietFacet')).toEqual({
      covered: true,
      declarations: [],
    })
    expect(declarationsFor('RenamedSinceDeployFacet')).toEqual({
      covered: false,
      declarations: [],
    })
  })

  it('covers nothing when the AST build produced no readable artifacts', () => {
    const declarationsFor = createLocalImmutableDeclarations(() =>
      readImmutableDeclarations(join(tmpdir(), 'codehash-no-such-ast-out'))
    )

    expect(declarationsFor('GasZipFacet').covered).toBe(false)
  })
})

describe('createArtifactCache', () => {
  const roots: string[] = []
  const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'codehash-artifact-cache-'))
    roots.push(root)
    return root
  }

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  it('serves a later run the build an earlier one made', () => {
    const cache = createArtifactCache(tempRoot())
    const built = tempRoot()
    mkdirSync(join(built, 'AccessManagerFacet.sol'), { recursive: true })
    writeFileSync(
      join(built, 'AccessManagerFacet.sol', 'AccessManagerFacet.json'),
      '{"deployedBytecode":{"object":"0xdead"}}'
    )

    cache.save('commit-out-codehash-default', built)
    const restoredInto = join(tempRoot(), 'out-codehash-default')

    expect(cache.restore('commit-out-codehash-default', restoredInto)).toBe(
      true
    )
    expect(
      readFileSync(
        join(restoredInto, 'AccessManagerFacet.sol', 'AccessManagerFacet.json'),
        'utf8'
      )
    ).toContain('0xdead')
  })

  // The gate must reach "build it again", never "the gate could not run": every
  // way the cache can fail is an optimisation missing, not a signing outage.
  it('reports a miss rather than throwing, for a key and a source it cannot read', () => {
    const cache = createArtifactCache(tempRoot())

    expect(cache.restore('nothing-was-ever-saved-here', tempRoot())).toBe(false)
    expect(() =>
      cache.save('unbuilt', join(tmpdir(), 'no-such-build-directory-here'))
    ).not.toThrow()
    expect(cache.restore('unbuilt', tempRoot())).toBe(false)
  })
})

/**
 * A real production Tron facet, in the two spellings the lookup has to join:
 * base58 as the deployment record holds it, checksummed hex as a decoded cut
 * carries it. Taken from `tron-address-spellings.test.ts`, where the mapping is
 * corroborated on chain rather than against this repo's own codec.
 */
const TRON_BASE58 = 'TNZ3fznhvEssLeovS9Uc7zCLgYjKdNjX9P'
const TRON_HEX = '0x8A07DD6cA9EA2DcCfF2A0015811C895ac1Abfcc5'

/**
 * Whether a record would be returned by a filter, over the operators the record
 * query is built from and no others.
 *
 * The query is asserted by running rows through it rather than by reading its
 * shape: "the base58 branch carries no `$options`" is a fact about this object,
 * while "a base58 spelled in another case is not found" is the property the
 * gate depends on. An operator this does not model throws instead of being
 * ignored, so a filter that grew one cannot be reported as behaving like the
 * filter that did not.
 */
const wouldMatch = (query: object, row: Record<string, string>): boolean =>
  Object.entries(query).every(([field, condition]) => {
    if (field === '$or') {
      if (!Array.isArray(condition)) throw new Error('$or is not a list')
      return condition.some((branch) => wouldMatch(branch as object, row))
    }
    if (field.startsWith('$')) throw new Error(`unmodelled operator ${field}`)
    if (typeof condition !== 'object' || condition === null)
      throw new Error(`unmodelled condition on ${field}`)

    const operators = condition as Record<string, unknown>
    const value = row[field]
    return Object.entries(operators).every(([operator, operand]) => {
      switch (operator) {
        case '$eq':
          return value === operand
        case '$in':
          return (operand as string[]).includes(value ?? '')
        case '$regex': {
          const options = operators.$options
          if (options !== undefined && options !== 'i')
            throw new Error(`unmodelled regex options ${String(options)}`)
          return new RegExp(
            asJsPattern(operand as string),
            options === 'i' ? 'i' : ''
          ).test(value ?? '')
        }
        case '$options':
          return true
        default:
          throw new Error(`unmodelled operator ${operator}`)
      }
    })
  })

/**
 * A PCRE2 pattern as the JavaScript engine has to spell it to mean the same.
 *
 * Only the two end-of-subject anchors differ here, and they differ the way the
 * query turns on: PCRE2 `$` also matches before a trailing newline while the
 * JavaScript `$` does not, and PCRE2 `\z` is the strict one JavaScript spells
 * `$`. Running the pattern unchanged would read `\z` as a literal `z` and read
 * a regressed `$` as if it were strict — the assertion would pass against the
 * bug it exists to catch.
 */
const asJsPattern = (pattern: string): string =>
  pattern.replace(/\\.|[$]/g, (token) =>
    token === '$' ? '(?=\\n?$)' : token === '\\z' ? '$' : token
  )

/** The same base58 address with its first lowercase letter upper-cased. */
const caseFlipped = (base58: string): string => {
  const letter = [...base58].find((c) => c >= 'a' && c <= 'z')
  if (!letter) throw new Error('no letter to flip')
  const at = base58.indexOf(letter)
  const flipped =
    base58.slice(0, at) + letter.toUpperCase() + base58.slice(at + 1)
  if (flipped === base58) throw new Error('flipping changed nothing')
  return flipped
}

describe('buildRecordQuery', () => {
  it('finds the hex spelling whatever case the record was written in', () => {
    const query = buildRecordQuery(TRON_HEX, 'tron')

    expect(wouldMatch(query, { network: 'tron', address: TRON_HEX })).toBe(true)
    expect(
      wouldMatch(query, { network: 'tron', address: TRON_HEX.toLowerCase() })
    ).toBe(true)
    expect(
      wouldMatch(query, {
        network: 'tron',
        address: '0x' + TRON_HEX.slice(2).toUpperCase(),
      })
    ).toBe(true)
    expect(
      wouldMatch(query, {
        network: 'tron',
        address: '0x0e07d966239d00a7fb445d4cb06b478a0e538b3b',
      })
    ).toBe(false)
  })

  // base58check is case-sensitive, so a folded comparison answers about an
  // address nobody asked about.
  it('finds the base58 spelling exactly, and never case-folded', () => {
    const query = buildRecordQuery(TRON_HEX, 'tron')

    expect(wouldMatch(query, { network: 'tron', address: TRON_BASE58 })).toBe(
      true
    )
    expect(
      wouldMatch(query, {
        network: 'tron',
        address: caseFlipped(TRON_BASE58),
      })
    ).toBe(false)
    expect(
      wouldMatch(query, { network: 'tron', address: TRON_BASE58.toUpperCase() })
    ).toBe(false)
    expect(
      wouldMatch(query, { network: 'tron', address: TRON_BASE58.toLowerCase() })
    ).toBe(false)
  })

  it('offers no base58 spelling on a network that spells addresses one way', () => {
    const query = buildRecordQuery(TRON_HEX, 'mainnet')

    expect(
      wouldMatch(query, { network: 'mainnet', address: TRON_HEX.toLowerCase() })
    ).toBe(true)
    expect(
      wouldMatch(query, { network: 'mainnet', address: TRON_BASE58 })
    ).toBe(false)
  })

  // The deploy path writes `network` from the config key, so it is lowercase by
  // construction and a fold there would widen the lookup for nothing.
  it('matches the network exactly', () => {
    const query = buildRecordQuery(TRON_HEX, 'tron')

    expect(wouldMatch(query, { network: 'tron', address: TRON_HEX })).toBe(true)
    expect(wouldMatch(query, { network: 'Tron', address: TRON_HEX })).toBe(
      false
    )
    expect(
      wouldMatch(query, { network: 'tronshasta', address: TRON_HEX })
    ).toBe(false)
  })

  it('matches the whole address, as a literal', () => {
    const query = buildRecordQuery(TRON_HEX, 'tron')

    expect(
      wouldMatch(query, { network: 'tron', address: TRON_HEX + '00' })
    ).toBe(false)
    // PCRE2 `$` matches before a trailing newline too, so the anchor has to be
    // `\z`: a row padded with one is a different stored value.
    expect(
      wouldMatch(query, { network: 'tron', address: TRON_HEX + '\n' })
    ).toBe(false)
    expect(
      wouldMatch(query, { network: 'tron', address: '00' + TRON_HEX })
    ).toBe(false)
    expect(
      wouldMatch(buildRecordQuery('0x.a', 'mainnet'), {
        network: 'mainnet',
        address: '0xba',
      })
    ).toBe(false)
  })

  // Self-check on the harness above: every assertion here is an observation
  // made through it, so a filter it silently mis-read would report the gate as
  // safe.
  it('is asserted through a matcher that refuses what it cannot model', () => {
    expect(() =>
      wouldMatch(
        { address: { $not: { $eq: TRON_HEX } } },
        {
          address: TRON_HEX,
        }
      )
    ).toThrow('unmodelled operator $not')
  })
})
