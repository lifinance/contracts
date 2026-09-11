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
  createForgeRebuildRunner,
  createImmutableReferencesResolver,
  createDeployedCodeReader,
  createRecordReader,
  createRuntimeCodeObserver,
  createToolchainScopeResolver,
  defaultCheckoutRoot,
  readToolchainConfig,
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

describe('createForgeRebuildRunner', () => {
  const artifact = JSON.stringify({
    deployedBytecode: { object: DEPLOYED, immutableReferences: REFS },
  })

  const runner = (
    over: {
      run?: (
        command: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> }
      ) => { ok: boolean; output: string }
      exists?: (path: string) => boolean
      readFile?: (path: string) => string
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
        seen = { command, args, env: options.env }
        built = true
        return { ok: true, output: '' }
      },
      exists: (path) => (path.endsWith('.json') ? built : true),
      readFile: () => artifact,
    })

    zk.build({
      ...request,
      profile: {
        ...request.profile,
        profile: 'zksync',
        zksolcVersion: '1.5.15',
      },
    })

    expect(seen.command).toContain('foundry-zksync')
    expect(seen.args).toContain('--zksync')
    expect(seen.env.FOUNDRY_ZKSYNC).toContain('1.5.15')
    expect(seen.env.FOUNDRY_PROFILE).toBe('zksync')
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
        run: () => {
          built = true
          return { ok: true, output: '' }
        },
        exists: (path) => {
          paths.push(path)
          return path.endsWith('.json') ? built : true
        },
        readFile: () => artifact,
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
    expect(zk[0]).toContain('zksync')
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
      }).build(request)
    ).toThrow(/artifact/)
  })

  it('throws when the artifact carries no runtime bytecode', () => {
    expect(() =>
      runner({
        readFile: () => JSON.stringify({ deployedBytecode: {} }),
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
    })

    withCleanup.build(request)
    withCleanup.cleanup()

    expect(
      gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'remove')
    ).toBe(true)
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
      scopeFor: () => ({ isClosedSet: true, profiles: [PROFILE] }),
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
  const SECONDARY = 'https://secondary.example/rpc'
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

  /** Answers `eth_getCode` from whichever hosts are not listed as down. */
  const stubEndpoints = (down: string[]): { hits: string[] } => {
    const hits: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      hits.push(url)
      if (down.some((host) => url.startsWith(host)))
        throw new Error('HTTP request failed: 503')

      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xfeed' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch
    return { hits }
  }

  // The property the change is about, asserted through the reader rather than
  // through the transport helper: a test that calls the helper itself passes
  // just as happily when the reader goes back to reading the primary alone.
  it('falls over to a second endpoint when the primary is down', async () => {
    const { hits } = stubEndpoints([PRIMARY])
    const read = createDeployedCodeReader(() => chainWith([PRIMARY, SECONDARY]))

    expect(await read(ADDRESS, 'arbitrum')).toBe('0xfeed')
    expect(hits.some((url) => url.startsWith(SECONDARY))).toBe(true)
  })

  it('uses the primary when it answers', async () => {
    const { hits } = stubEndpoints([])
    const read = createDeployedCodeReader(() => chainWith([PRIMARY, SECONDARY]))

    expect(await read(ADDRESS, 'arbitrum')).toBe('0xfeed')
    expect(hits.every((url) => url.startsWith(PRIMARY))).toBe(true)
  })

  // Every endpoint failing must reach the caller as a throw. The gate treats
  // that as unverifiable and blocks, which is the right answer — what it must
  // not do is come back as `0x` and compare clean against a rebuild.
  it('throws when no endpoint answers, rather than reporting no code', async () => {
    stubEndpoints([PRIMARY, SECONDARY])
    const read = createDeployedCodeReader(() => chainWith([PRIMARY, SECONDARY]))

    let threw = false
    try {
      await read(ADDRESS, 'arbitrum')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('resolves the chain for the network it is asked about', async () => {
    stubEndpoints([])
    const asked: string[] = []
    await createDeployedCodeReader((network) => {
      asked.push(network)
      return chainWith([PRIMARY])
    })(ADDRESS, 'arbitrum')

    expect(asked).toEqual(['arbitrum'])
  })
})
