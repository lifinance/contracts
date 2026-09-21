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
import { normalizeRuntimeCode } from '../codehash/rebuild-attestations'
import {
  readImmutableDeclarations,
  type IImmutableDeclaration,
} from '../immutables/immutable-ast'

import {
  createForgeRebuildRunner,
  createImmutableSimulatorReader,
  createLocalImmutableDeclarations,
  createOffCodeImmutablesReader,
  createImmutableReferencesResolver,
  createDeployedCodeReader,
  createRecordReader,
  createRuntimeCodeObserver,
  createToolchainScopeResolver,
  createArtifactCache,
  defaultCheckoutRoot,
  loadImmutableExpectations,
  readToolchainConfig,
  resolveDeploymentRecord,
} from './codehash-sign-gate-deps'

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
    const scope = resolve('tron')

    expect(scope.profiles.map((p) => p.profile)).toEqual(['solc_floor'])
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

  it('returns the record when duplicates agree on contract and version', () => {
    const first = row({})

    expect(
      resolveDeploymentRecord(
        [first, row({ gitCommitHash: 'b'.repeat(40) })],
        ADDRESS,
        'tron'
      )
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

  const readZkFiles =
    (artifactJson: string) =>
    (path: string): string =>
      path.endsWith('foundry.toml') ? pinnedToml : artifactJson

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
        readFile: over.readFile ?? (() => artifact),
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
      readFile: () => astless,
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
      readFile: () => artifact,
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
        readFile: () => artifact,
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
      readFile: () => artifact,
      readDeclarations: () => [],
    })

    withRun.build(request)
    expect(built).toBe(true)
    expect(harness.calls).toEqual([])
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
        readFile: over.readFile ?? readZkFiles(zkArtifact),
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
        readFile: () => artifact,
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
        readFile: () => artifact,
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
        readFile: () => artifact,
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
        readFile: () => artifact,
        readDeclarations: () => [],
      }).build(request)
    ).toThrow(/artifact/)
  })

  it('throws when the artifact carries no runtime bytecode', () => {
    expect(() =>
      runner({
        readFile: () => JSON.stringify({ deployedBytecode: {} }),
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
      readFile: () => artifact,
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
      readFile: () => artifact,
      readDeclarations: () => [],
    })

    withCleanup.build(request)
    withCleanup.cleanup()

    expect(
      gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'remove')
    ).toBe(true)
  })
})

describe('loadImmutableExpectations', () => {
  it('reads the expectation files from the repo regardless of cwd', () => {
    const originalCwd = process.cwd()
    const elsewhere = mkdtempSync(join(tmpdir(), 'expectations-cwd-'))
    let requirements
    try {
      process.chdir(elsewhere)
      requirements = loadImmutableExpectations()
    } finally {
      process.chdir(originalCwd)
      rmSync(elsewhere, { recursive: true, force: true })
    }

    expect(Object.keys(requirements).length).toBeGreaterThan(0)
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
      loadRequirements: () => ({}),
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
