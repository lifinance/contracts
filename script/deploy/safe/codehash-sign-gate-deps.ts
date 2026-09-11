/**
 * The three real dependencies `verifyCutTargets` needs, wired at the sign-time
 * call site.
 *
 * They live here rather than in `script/deploy/codehash/` because they are the
 * untested glue that owns credentials — an RPC endpoint, the deployment-record
 * store, a compiler — and the modules under test stay free of all three.
 *
 * Two lines carry the whole comparison and are the ones to read first.
 * `observe` normalises through {@link normalizeRuntimeCode}, the same function
 * the attestation side uses: two implementations of "strip then mask" is how
 * both sides come to normalise differently while each looks finished. And
 * `readRecord` reads MongoDB and throws when it cannot — the checked-in
 * `deployments/_deployments_log_file.json` is years stale and omits recent
 * contracts, so falling back to it would report an outage as a clean answer.
 */

import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { MongoClient } from 'mongodb'
import { createPublicClient, http, type Address } from 'viem'

import { EnvironmentEnum } from '../../common/types'
import { redactUrls } from '../../utils/redactUrls'
import {
  getViemChainForNetworkName,
  getTransportConfigFromRpcUrl,
} from '../../utils/viemScriptHelpers'
import type { ILineageScope, IObservedCode } from '../codehash/attested-set'
import { readMetadataTrailer } from '../codehash/bytecode-trailer'
import type { ImmutableReferences } from '../codehash/immutable-offsets'
import {
  deriveToolchainScope,
  parseBuildProfiles,
  type IBuildProfile,
  type IToolchainScope,
} from '../codehash/lineage-scope'
import {
  createAttestationSource,
  normalizeRuntimeCode,
  type IDeploymentRecordRef,
  type IRebuildRequest,
  type IRebuiltArtifact,
} from '../codehash/rebuild-attestations'
import type { IVerifyCutDeps } from '../codehash/verify-cut-targets'

/** A full commit SHA and nothing else: this value reaches a path and git argv. */
const FULL_SHA = /^[0-9a-f]{40}$/

/** What the record writer stores when it could not read a commit. */
const UNKNOWN_COMMIT = 'UNKNOWN'

/** Repo root, resolved from this module so a caller's cwd cannot change it. */
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
)

export interface IToolchainConfig {
  networks: Record<string, { targetEvmVersion: string; isZkEVM: boolean }>
  profiles: Record<string, IBuildProfile>
}

/**
 * Reads the two config files the legitimate-build set is derived from.
 *
 * Parsed at call time rather than imported as a module constant, because the
 * `foundry.toml` profiles are what CI actually builds and a hardcoded copy would
 * keep passing after someone retunes one.
 *
 * @param options.repoRoot - checkout to read from; this repo by default
 * @returns The network rows and the compiler pairs
 */
export const readToolchainConfig = (options?: {
  repoRoot?: string
}): IToolchainConfig => {
  const root = options?.repoRoot ?? REPO_ROOT
  return {
    networks: JSON.parse(
      readFileSync(join(root, 'config', 'networks.json'), 'utf8')
    ),
    profiles: parseBuildProfiles(
      readFileSync(join(root, 'foundry.toml'), 'utf8')
    ),
  }
}

/**
 * Resolves a network to the toolchains its code may legitimately have.
 *
 * Memoised per network: the answer is a pure function of config that several
 * dependencies ask for on the same proposal, and it must be one answer — the
 * observed side masks with the lineage's own offsets, so two resolutions that
 * disagreed would normalise the two sides differently.
 *
 * @param config - the network rows and compiler pairs
 * @returns A resolver that throws when the set cannot be enumerated
 */
export const createToolchainScopeResolver = (
  config: IToolchainConfig
): ((network: string) => IToolchainScope) => {
  const cache = new Map<string, IToolchainScope>()
  return (network: string): IToolchainScope => {
    const hit = cache.get(network)
    if (hit) return hit
    const scope = deriveToolchainScope(network, config)
    cache.set(network, scope)
    return scope
  }
}

export interface IRuntimeCodeObserverDeps {
  scopeFor: (network: string) => IToolchainScope
  /** Foundry's `immutableReferences` for whatever is meant to be at the address. */
  refsFor: (
    address: string,
    network: string
  ) => Promise<ImmutableReferences | undefined>
  /** Runtime bytecode as deployed, `0x`-prefixed. */
  readDeployedCode: (address: string, network: string) => Promise<string>
}

/**
 * Reads what is deployed at an address and normalises it for comparison.
 *
 * The immutable offsets come from the rebuild of what the record says belongs
 * here, so the observed and attested sides mask the same bytes. That is only
 * well defined for one lineage, so a network resolving to more than one profile
 * is refused rather than masked with an arbitrary one — the refusal surfaces as
 * UNVERIFIABLE, which is the honest answer.
 *
 * @param deps - the scope resolver, the offsets source and the chain read
 * @returns The `observe` dependency of `verifyCutTargets`
 */
export const createRuntimeCodeObserver = (
  deps: IRuntimeCodeObserverDeps
): ((address: string, network: string) => Promise<IObservedCode>) => {
  return async (address: string, network: string): Promise<IObservedCode> => {
    const scope = deps.scopeFor(network)
    if (scope.profiles.length !== 1)
      throw new Error(
        `${network} resolves to ${
          scope.profiles.length
        } build profiles (${scope.profiles
          .map((p) => p.profile)
          .join(
            ', '
          )}), and immutable offsets are per lineage — masking the deployed code with more than one profile's offsets would compare different bytes on each side. Narrow the network's config so one profile applies.`
      )

    const profile = scope.profiles[0] as IBuildProfile
    const isZk = profile.zksolcVersion !== undefined

    const code = await deps.readDeployedCode(address, network)
    if (!code || code === '0x')
      throw new Error(
        `${address} on ${network} holds no code, so there is nothing to compare against an attested build.`
      )

    const refs = await deps.refsFor(address, network)
    const normalized = normalizeRuntimeCode(code, refs, { isZk })
    if (!normalized.ok)
      throw new Error(
        `the code at ${address} on ${network} cannot be normalised: ${normalized.reason}`
      )

    const trailer = readMetadataTrailer(code)
    return {
      maskedHash: normalized.maskedHash,
      rawHash: normalized.rawHash,
      rawByteLength: normalized.rawByteLength,
      maskedByteCount: normalized.maskedByteCount,
      // Proposer-controlled, and consulted by the comparison only where the
      // legitimate set is open. Carried so a reason can name it, never to
      // decide anything on a closed set.
      ...(trailer.present && trailer.solcVersion
        ? { solcVersion: trailer.solcVersion }
        : {}),
    }
  }
}

/** The slice of the deployment-record store this needs. */
export interface IRecordSource {
  findByAddress: (
    address: string,
    network: string
  ) => Promise<{
    contractName: string
    version: string
    gitCommitHash: string
  } | null>
}

/**
 * Reads what the deployment record says is meant to be at an address.
 *
 * A store that cannot be reached throws. Returning undefined there would report
 * an outage as "the record says nothing about this address", which grades a
 * MongoDB failure as a clean grey instead of an infrastructure error.
 *
 * @param source - the record store
 * @returns The `readRecord` dependency of the attestation source
 */
export const createRecordReader = (
  source: IRecordSource
): ((
  address: string,
  network: string
) => Promise<IDeploymentRecordRef | undefined>) => {
  return async (
    address: string,
    network: string
  ): Promise<IDeploymentRecordRef | undefined> => {
    let row
    try {
      row = await source.findByAddress(address, network)
    } catch (error) {
      throw new Error(
        `the MongoDB deployment record for ${address} on ${network} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    if (!row) return undefined
    return {
      contractName: row.contractName,
      version: row.version,
      gitCommitHash: row.gitCommitHash ?? '',
    }
  }
}

/**
 * Resolves the immutable offsets the observed side must mask with.
 *
 * They come from a rebuild of whatever the record says belongs at the address,
 * so the observed and attested sides remove the same bytes. No offsets is a
 * legitimate answer — a contract with no immutables, an address the record is
 * silent about, or a record carrying no commit — and it makes the comparison
 * report what is actually missing rather than an unreadable-code error.
 *
 * @param deps.readRecord - what the record says is meant to be at the address
 * @param deps.scopeFor - the network's legitimate toolchains
 * @param deps.build - the rebuild runner
 * @returns The `refsFor` dependency of the observer
 */
export const createImmutableReferencesResolver = (deps: {
  readRecord: (
    address: string,
    network: string
  ) => Promise<IDeploymentRecordRef | undefined>
  scopeFor: (network: string) => IToolchainScope
  build: (request: IRebuildRequest) => IRebuiltArtifact
}): ((
  address: string,
  network: string
) => Promise<ImmutableReferences | undefined>) => {
  return async (
    address: string,
    network: string
  ): Promise<ImmutableReferences | undefined> => {
    const record = await deps.readRecord(address, network)
    if (!record) return undefined
    const commit = record.gitCommitHash.trim()
    // `UNKNOWN` is what the record writer stores when it could not read a
    // commit, so it is an absent value rather than one to hand to a fetch.
    if (commit === '' || commit === UNKNOWN_COMMIT) return undefined
    const profiles = deps.scopeFor(network).profiles
    // Mirrors the observer's refusal rather than relying on it running first:
    // offsets are per lineage, so picking one of several would mask bytes the
    // attested side did not.
    if (profiles.length !== 1)
      throw new Error(
        `${network} resolves to ${profiles.length} build profiles, and immutable offsets are per lineage, so there is no single set to mask the deployed code with.`
      )
    const profile = profiles[0]
    if (!profile) return undefined
    return deps.build({
      contractName: record.contractName,
      commit,
      profile,
    }).immutableReferences
  }
}

export interface IForgeRebuildDeps {
  repoRoot: string
  /** Where the per-commit checkouts go. */
  checkoutRoot: string
  git: (args: string[]) => string
  run: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> }
  ) => { ok: boolean; output: string }
  exists: (path: string) => boolean
  readFile: (path: string) => string
}

/**
 * Refuses a rebuild whose `lib/` pins do not match the commit's `.gitmodules`.
 *
 * `git submodule status` prefixes each row: a leading space means the checkout
 * matches the recorded SHA; `+`/`-`/`U` mean drift, missing, or conflict. A
 * rebuild against any of those is not an attestation of what was deployed.
 *
 * @param git - runs git with the same cwd/env the runner uses
 * @param checkout - absolute path of the detached worktree
 * @throws when any submodule row is not cleanly pinned
 */
const assertSubmodulesPinned = (
  git: (args: string[]) => string,
  checkout: string
): void => {
  const status = git(['-C', checkout, 'submodule', 'status', '--recursive'])
  const drifted = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith(' '))
  if (drifted.length === 0) return
  throw new Error(
    `refusing to rebuild at ${checkout}: submodule pins are not clean after update — a rebuild against unpinned libraries is not an attestation. Drifted rows:\n${drifted.join(
      '\n'
    )}`
  )
}

/**
 * Compiles one contract at one commit under one profile.
 *
 * The commit is built in its own detached checkout, never in the tree the
 * signer is running from: a signing session must not be able to move the
 * operator's working tree, and a build in place would compile whatever is
 * checked out rather than what was deployed.
 *
 * Each profile gets its own output directory. Foundry puts `default` and
 * `solc_floor` in the same `out/`, and one run can need both — a fleet rollout
 * covering a cancun network and a london one — so a shared directory would hand
 * the second profile the first one's artifact.
 *
 * @param deps - the checkout locations and the git, process and file primitives
 * @returns The `build` dependency, and a cleanup for the checkouts it made
 */
export const createForgeRebuildRunner = (
  deps: IForgeRebuildDeps
): {
  build: (request: IRebuildRequest) => IRebuiltArtifact
  cleanup: () => void
} => {
  const created = new Set<string>()

  const build = (request: IRebuildRequest): IRebuiltArtifact => {
    // The commit comes from a Mongo row and reaches both a path join and git's
    // argv. `ensureCommitAvailable` checks the same shape, but it runs in a
    // different module on a different call, so this does not rely on ordering.
    if (!FULL_SHA.test(request.commit))
      throw new Error(
        `refusing to rebuild at "${request.commit}": a commit must be a full 40-character lowercase SHA before it reaches a path or a git argument.`
      )
    const checkout = join(deps.checkoutRoot, request.commit)
    if (!deps.exists(checkout)) {
      deps.git(['worktree', 'add', '--detach', checkout, request.commit])
      created.add(checkout)
    }

    const outDir = `out-codehash-${request.profile.profile}`
    const artifactPath = join(
      checkout,
      outDir,
      `${request.contractName}.sol`,
      `${request.contractName}.json`
    )

    if (!deps.exists(artifactPath)) {
      // `worktree add --detach` does not populate `lib/`. Without pinning,
      // forge's auto-install clones at tip revisions and the rebuilt runtime
      // cannot match what was deployed — every cut grades MISMATCH.
      deps.git(['-C', checkout, 'submodule', 'update', '--init', '--recursive'])
      assertSubmodulesPinned(deps.git, checkout)

      const isZk = request.profile.zksolcVersion !== undefined
      const command = isZk
        ? join(deps.repoRoot, 'foundry-zksync', 'forge')
        : 'forge'
      // `test`/`script` are forge aliases for `.t.sol`/`.s.sol` only; the
      // path globs match `[profile.solc_floor]` and skip the whole trees.
      // `--offline` refuses forge's auto-install so a missing pin cannot be
      // silently substituted mid-build.
      const args = [
        'build',
        '--out',
        outDir,
        ...(isZk ? ['--zksync'] : []),
        '--skip',
        'test/**',
        '--skip',
        'script/**',
        '--offline',
      ]
      const env: Record<string, string> = {
        FOUNDRY_PROFILE: request.profile.profile,
        ...(isZk
          ? {
              FOUNDRY_ZKSYNC: `{ zksolc = "${request.profile.zksolcVersion}" }`,
            }
          : {}),
      }

      const result = deps.run(command, args, { cwd: checkout, env })
      if (!result.ok)
        throw new Error(
          `rebuilding ${request.contractName} at ${request.commit.slice(
            0,
            9
          )} under profile ${request.profile.profile} failed: ${redactUrls(
            result.output
          )}`
        )
      if (!deps.exists(artifactPath))
        throw new Error(
          `the rebuild of ${request.contractName} at ${request.commit.slice(
            0,
            9
          )} reported success but produced no artifact at ${artifactPath}`
        )
    }

    let parsed: {
      deployedBytecode?: {
        object?: string
        immutableReferences?: ImmutableReferences
      }
    }
    try {
      parsed = JSON.parse(deps.readFile(artifactPath))
    } catch (error) {
      throw new Error(
        `the rebuilt artifact at ${artifactPath} could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    const runtimeHex = parsed.deployedBytecode?.object
    if (!runtimeHex || runtimeHex === '0x')
      throw new Error(
        `the rebuilt artifact for ${request.contractName} carries no runtime bytecode`
      )

    return {
      runtimeHex,
      ...(parsed.deployedBytecode?.immutableReferences
        ? { immutableReferences: parsed.deployedBytecode.immutableReferences }
        : {}),
    }
  }

  return {
    build,
    cleanup: (): void => {
      for (const checkout of created)
        try {
          deps.git(['worktree', 'remove', '--force', checkout])
        } catch {
          // A checkout left behind costs disk, not correctness, and this runs
          // in a `finally` beside the Ledger teardown.
        }
      created.clear()
    },
  }
}

/**
 * Answers each (address, network) once for the life of the run.
 * @param read - the reader to wrap
 * @returns The same reader, called at most once per target
 */
const memoisePerTarget = <T>(
  read: (address: string, network: string) => Promise<T>
): ((address: string, network: string) => Promise<T>) => {
  const cache = new Map<string, Promise<T>>()
  return (address: string, network: string): Promise<T> => {
    const key = `${network}|${address.toLowerCase()}`
    const hit = cache.get(key)
    if (hit) return hit
    const pending = read(address, network)
    cache.set(key, pending)
    // A failed read is not remembered: an outage must be retried, never cached
    // as an answer.
    pending.catch(() => cache.delete(key))
    return pending
  }
}

/**
 * Where the per-commit rebuild checkouts go.
 *
 * Outside the repo, because a `git worktree` under the checkout shows up as an
 * untracked path in the tree the deploy flow refuses to record from. Per
 * process, because `close()` removes this tree and a shared path would let one
 * run's teardown delete a concurrent run's checkouts.
 *
 * @param pid - process to scope the path to; this one by default
 * @returns An absolute path outside the repository
 */
export const defaultCheckoutRoot = (pid = process.pid): string =>
  join(tmpdir(), `lifi-codehash-rebuilds-${pid}`)

export interface ISignTimeCodehashDeps extends IVerifyCutDeps {
  /** Releases the record store and removes the rebuild checkouts. */
  close: () => Promise<void>
}

/**
 * Assembles the sign-time gate's dependencies for a real run.
 *
 * @param overrides.recordSource - the deployment-record store
 * @param overrides.checkoutRoot - where per-commit checkouts go
 * @returns The three dependencies plus a teardown
 */
export const createSignTimeCodehashDeps = (overrides?: {
  recordSource?: IRecordSource
  checkoutRoot?: string
}): ISignTimeCodehashDeps => {
  const scopeFor = createToolchainScopeResolver(readToolchainConfig())
  // Outside the repo: a `git worktree` under the checkout would show up as an
  // untracked path in the tree the deploy flow refuses to record from.
  const checkoutRoot = overrides?.checkoutRoot ?? defaultCheckoutRoot()
  mkdirSync(checkoutRoot, { recursive: true })

  const git = (args: string[]): string => {
    const result = spawnSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    if (result.status !== 0)
      throw new Error(
        redactUrls(
          `git ${args[0]} failed: ${result.stderr ?? ''}${result.stdout ?? ''}`
        )
      )
    return result.stdout ?? ''
  }

  const rebuild = createForgeRebuildRunner({
    repoRoot: REPO_ROOT,
    checkoutRoot,
    git,
    run: (command, args, options) => {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        encoding: 'utf8',
      })
      return {
        ok: result.status === 0,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      }
    },
    exists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
  })

  const recordSource = overrides?.recordSource ?? createMongoRecordSource()
  // One read per (address, network), shared by the attestation side and the
  // offsets side: two reads of a mutable source is the failure this design
  // exists to prevent, even where the worst outcome is a mask asymmetry.
  const readRecord = memoisePerTarget(createRecordReader(recordSource))

  const attestations = createAttestationSource({
    readRecord,
    toolchainScope: scopeFor,
    build: rebuild.build,
    git,
  })

  const observe = createRuntimeCodeObserver({
    scopeFor,
    // The offsets come from the rebuild of what the record says belongs here,
    // through the same cache the attestations were built from, so both sides
    // mask identical bytes and the compile happens once.
    refsFor: createImmutableReferencesResolver({
      readRecord,
      scopeFor,
      build: rebuild.build,
    }),
    readDeployedCode: async (address, network) => {
      const chain = getViemChainForNetworkName(network)
      const client = createPublicClient({
        chain,
        transport: http(
          getTransportConfigFromRpcUrl(chain.rpcUrls.default.http[0] as string)
            .url
        ),
      })
      return (await client.getCode({ address: address as Address })) ?? '0x'
    },
  })

  return {
    scope: (network: string): ILineageScope => scopeFor(network),
    observe,
    attestationsFor: attestations.attestationsFor,
    close: async (): Promise<void> => {
      rebuild.cleanup()
      await closeMongoRecordSource()
      try {
        rmSync(checkoutRoot, { recursive: true, force: true })
      } catch {
        // Disk, not correctness.
      }
    },
  }
}

let client: MongoClient | undefined

/** Escapes a string for use as a literal inside a MongoDB regex pattern. */
const escapeRegexLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The production deployment-log collection, connected on first use.
 *
 * Queried directly rather than through `CachedDeploymentQuerier`, whose cache
 * returns stale local records when MongoDB is unreachable. That fallback is
 * right for a report and wrong for a gate: "the record could not be read" and
 * "this is what the record says" are the two facts a gate exists to keep apart,
 * and an outage must reach the signer as an error.
 *
 * `production` and not the operator's environment: this judges proposals
 * against a production Safe, and staging records describe a different deploy.
 */
const createMongoRecordSource = (): IRecordSource => ({
  findByAddress: async (address, network) => {
    const uri = process.env.MONGODB_URI
    if (!uri)
      throw new Error(
        'MONGODB_URI is not set, so the deployment record cannot be read. The checked-in deployment log is years stale and omits recent contracts, so it is not a fallback.'
      )
    if (!client) {
      client = new MongoClient(uri)
      await client.connect()
    }
    const collection = client.db('contract-deployments').collection<{
      contractName: string
      version: string
      gitCommitHash: string
    }>(EnvironmentEnum.production)

    // Latest first: one address can carry several records over its life, and
    // what is meant to be there now is the most recent of them.
    const sort = { timestamp: -1 } as const
    const exact = await collection.findOne(
      { address: { $eq: address }, network: { $eq: network } },
      { sort }
    )
    if (exact) return exact

    // The decoded cut supplies checksummed addresses (`classifyCut` returns
    // `getAddress`), and records were written in either case over the years, so
    // the exact match above can miss on case alone. Do not "simplify" this by
    // lowercasing one side: the stored case is not ours to assume. `network` is
    // matched exactly on purpose — the deploy path writes it from the config
    // key, so it is lowercase by construction, unlike an address that a human
    // or an older script may have written either way.
    return collection.findOne(
      {
        network: { $eq: network },
        address: { $regex: `^${escapeRegexLiteral(address)}$`, $options: 'i' },
      },
      { sort }
    )
  },
})

const closeMongoRecordSource = async (): Promise<void> => {
  if (!client) return
  const open = client
  client = undefined
  await open.close(true).catch(() => undefined)
}
