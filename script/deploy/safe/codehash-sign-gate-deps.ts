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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { MongoClient, type Filter } from 'mongodb'
import { createPublicClient, http, type Address, type Chain } from 'viem'

import { EnvironmentEnum } from '../../common/types'
import { redactUrls } from '../../utils/redactUrls'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'
import type { ILineageScope, IObservedCode } from '../codehash/attested-set'
import { readMetadataTrailer } from '../codehash/bytecode-trailer'
import {
  observeEvmImmutables,
  observeZkImmutables,
  priceImmutables,
  type ImmutablePricing,
} from '../codehash/immutable-expectations'
import type { ImmutableReferences } from '../codehash/immutable-offsets'
import type { IOffCodeImmutables } from '../codehash/immutable-verdict'
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
import { resolveSourceRemote } from '../codehash/source-remote'
import type { IVerifyCutDeps } from '../codehash/verify-cut-targets'
import {
  readZkImmutables,
  zkImmutableOrdinals,
  IMMUTABLE_SIMULATOR_ADDRESS,
} from '../codehash/zk-immutables'
import {
  buildAst,
  readImmutableDeclarations,
  type IImmutableDeclaration,
} from '../immutables/immutable-ast'
import type {
  DeployRequirements,
  IImmutableEntry,
} from '../immutables/registry-schema'
import { mergeRequirements } from '../immutables/verify-immutable-registry'
import { createTronAddressSpellings } from '../shared/tron-address-spellings'

import { evaluateRpcQuorum } from './rpc-quorum'
import {
  collectProviderObservations,
  createCodeReader,
  createPinnedBlock,
  createPinnedValueReader,
} from './rpc-quorum-collector'
import { getSignTimeTransportConfig } from './sign-time-transport'

/** A full commit SHA and nothing else: this value reaches a path and git argv. */
const FULL_SHA = /^[0-9a-f]{40}$/

/** What the record writer stores when it could not read a commit. */
const UNKNOWN_COMMIT = 'UNKNOWN'

/**
 * Where foundry-zksync writes artifacts. Fixed: it honours neither `--out` nor
 * the profile's `out`, and exposes no flag of its own to redirect it.
 */
const ZK_OUT_DIR = 'zkout'

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
      runtimeCode: code,
      // Proposer-controlled, and consulted by the comparison only where the
      // legitimate set is open. Carried so a reason can name it, never to
      // decide anything on a closed set.
      ...(trailer.present && trailer.solcVersion
        ? { solcVersion: trailer.solcVersion }
        : {}),
      // Also proposer-written, and compared rather than believed: an attested
      // build that records a triple requires this one to equal it, so a forged
      // value can only move a verdict towards MISMATCH.
      ...(trailer.present && trailer.toolchain
        ? { toolchain: trailer.toolchain }
        : {}),
    }
  }
}

/**
 * The slice of the deployment-record store this needs.
 *
 * `version` and `gitCommitHash` are optional because the stored rows make them
 * so — declaring them required does not make them present, it only moves the
 * absence to a `TypeError` the signer reads as an unreadable record.
 */
export interface IRecordSource {
  findByAddress: (
    address: string,
    network: string
  ) => Promise<{
    contractName: string
    version?: string
    gitCommitHash?: string
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
      version: text(row.version),
      gitCommitHash: text(row.gitCommitHash),
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
  /**
   * Immutable declarations out of a directory of AST-carrying artifacts,
   * with repo-relative source paths resolved against `sourceRoot`.
   */
  readDeclarations: (
    outDir: string,
    sourceRoot: string
  ) => readonly IImmutableDeclaration[]
  /**
   * Where a build survives between runs, keyed on commit and profile.
   *
   * Optional because nothing about the gate's verdict depends on it: a miss on
   * both calls is the behaviour without a cache at all, which is what the tests
   * that omit it exercise. Both sides are best-effort and must not throw — a
   * cache that cannot be read is a slow run, and a cache that makes the gate
   * fail is a signing outage.
   */
  artifactCache?: {
    /** Puts a cached build at `outDir`. Returns false when it holds none. */
    restore: (key: string, outDir: string) => boolean
    /** Keeps `outDir` for the next run. */
    save: (key: string, outDir: string) => void
  }
}

/**
 * Whether an artifact on disk carries the AST layer 2 needs.
 *
 * A parse failure answers false rather than throwing: the caller's response is
 * to rebuild, which is also the right response to an artifact it cannot read.
 *
 * @param deps - the file primitives
 * @param artifactPath - the artifact to inspect
 * @returns true when an `ast` node is present
 */
const carriesAst = (
  deps: Pick<IForgeRebuildDeps, 'readFile'>,
  artifactPath: string
): boolean => {
  try {
    return (
      (JSON.parse(deps.readFile(artifactPath)) as { ast?: unknown }).ast !==
      undefined
    )
  } catch {
    return false
  }
}

const EXTERNAL_ZKSYNC_SECTION = /^\s*\[external\.zksync\]\s*$/
const TOML_SECTION = /^\s*\[[^\]]+\]\s*$/
const FOUNDRY_ZKSYNC_PIN = /^\s*foundry_zksync\s*=\s*['"]([^'"]+)['"]/

/** Same shape `install_foundry_zksync` compares against: `vX.Y.Z` and `nightly-<sha>` alike. */
const REPORTED_ZK_RELEASE = /foundry-zksync-(\S+)/

/**
 * How an operator installs the pinned release. Verified by sourcing the script:
 * `install_foundry_zksync` is a shell function, so it exists only after the source.
 */
const ZK_INSTALL_HINT =
  'run `source script/helperFunctions.sh && install_foundry_zksync` in the repository root'

/**
 * The foundry-zksync release pinned in `foundry.toml` `[external.zksync]`.
 *
 * `parseBuildProfiles` reads the neighbouring `zksolc` key but not this one, and
 * neither pin can live in a profile table — vanilla forge warns on an unknown
 * `zksync` key — so the section has to be walked directly.
 *
 * @param toml - contents of `foundry.toml`
 * @returns The pinned release tag, or undefined when the section does not pin one
 */
const parseFoundryZksyncPin = (toml: string): string | undefined => {
  let inSection = false
  for (const line of toml.split('\n')) {
    if (EXTERNAL_ZKSYNC_SECTION.test(line)) {
      inSection = true
      continue
    }
    if (TOML_SECTION.test(line)) {
      inSection = false
      continue
    }
    if (!inSection) continue
    const pin = FOUNDRY_ZKSYNC_PIN.exec(line)
    if (pin) return pin[1]
  }
  return undefined
}

/**
 * Refuses a zk rebuild unless the binary about to compile is the pinned release.
 *
 * `foundry-zksync/` is untracked, so a fresh clone or worktree has none at all.
 * Without this the spawn fails inside the build and surfaces as "the attested
 * build could not be produced", which reads to a signer as a fact about the
 * deployment rather than about their machine. A binary that is present but off
 * the pin is worse: it compiles, produces different bytecode and grades an
 * honest deployment MISMATCH.
 *
 * Mirrors `assertZkToolchainOrFail` (`script/deploy/shared/assertZkToolchain.sh`)
 * on the bash deploy path. Only the observed leg is mirrored: the zksolc request
 * is built by this module from the same pin it would be compared against.
 *
 * @param deps - the file and process primitives, and the repo to read the pin from
 * @param command - the foundry-zksync forge this build would invoke
 * @throws when the binary is absent, unreadable, or off the pin
 */
const assertZkToolchainPinned = (
  deps: Pick<IForgeRebuildDeps, 'repoRoot' | 'run' | 'exists' | 'readFile'>,
  command: string
): void => {
  const refusal = (why: string): Error =>
    new Error(
      `zkEVM toolchain problem, not a codehash verdict: ${why}. Nothing about the deployment has been established — to make this checkable, ${ZK_INSTALL_HINT}.`
    )

  const pin = parseFoundryZksyncPin(
    deps.readFile(join(deps.repoRoot, 'foundry.toml'))
  )
  if (pin === undefined)
    throw refusal(
      'foundry.toml [external.zksync] pins no foundry_zksync release, so there is nothing to hold the rebuild to'
    )

  if (!deps.exists(command))
    throw refusal(`no foundry-zksync forge at ${command}`)

  const probe = deps.run(command, ['--version'], {
    cwd: deps.repoRoot,
    env: {},
  })
  const reported = REPORTED_ZK_RELEASE.exec(probe.output)?.[1]
  if (!probe.ok || reported === undefined)
    throw refusal(
      `\`${command} --version\` did not report a foundry-zksync release: ${redactUrls(
        probe.output
      )}`
    )

  if (reported !== pin)
    throw refusal(
      `${command} is foundry-zksync ${reported} but foundry.toml pins ${pin}, and a rebuild under the wrong release would not reproduce the deployed bytecode`
    )
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

    // The zk toolchain writes to `zkout/` and ignores `--out`, so the path the
    // artifact is read from has to follow the toolchain rather than the flag.
    // It still sits inside this commit's checkout, so it stays per-commit.
    const isZk = request.profile.zksolcVersion !== undefined
    const outDir = isZk ? ZK_OUT_DIR : `out-codehash-${request.profile.profile}`
    const artifactPath = join(
      checkout,
      outDir,
      `${request.contractName}.sol`,
      `${request.contractName}.json`
    )

    // An artifact left by a build that predates `--ast` satisfies an
    // existence check while carrying no declarations, which would report every
    // immutable as unpriceable instead of rebuilding. Treat it as absent.
    // zksolc emits no AST at all, so requiring one there would rebuild on every
    // call and never be satisfied. It costs only layer 2, which cannot name a
    // simulator slot without it either way.
    const usable = (): boolean =>
      deps.exists(artifactPath) && (isZk || carriesAst(deps, artifactPath))

    // A build this machine already made of this commit under this profile. The
    // checkout is per process and its output dies with the run, so without this
    // every signing session recompiles the same tree from cold — which is the
    // whole of the minute a signer waits before the checks appear.
    //
    // The profile is in the key as well as the directory it writes to: the zk
    // toolchain sends every profile to `zkout`, so a key spelled from the
    // directory alone would serve one zksolc version's build as another's.
    const cacheKey = `${request.commit}-${request.profile.profile}-${outDir}`
    if (!usable()) deps.artifactCache?.restore(cacheKey, join(checkout, outDir))

    if (!usable()) {
      // `worktree add --detach` does not populate `lib/`. Without pinning,
      // forge's auto-install clones at tip revisions and the rebuilt runtime
      // cannot match what was deployed — every cut grades MISMATCH.
      deps.git(['-C', checkout, 'submodule', 'update', '--init', '--recursive'])
      assertSubmodulesPinned(deps.git, checkout)

      const command = isZk
        ? join(deps.repoRoot, 'foundry-zksync', 'forge')
        : 'forge'
      if (isZk) assertZkToolchainPinned(deps, command)
      // `test`/`script` are forge aliases for `.t.sol`/`.s.sol` only; the
      // path globs match `[profile.solc_floor]` and skip the whole trees.
      // `--offline` refuses forge's auto-install so a missing pin cannot be
      // silently substituted mid-build.
      const args = [
        'build',
        ...(isZk ? ['--zksync'] : ['--out', outDir]),
        '--skip',
        'test/**',
        '--skip',
        'script/**',
        '--offline',
        // Layer 2 keys the deployment's immutables by AST id, and an id is
        // only meaningful inside the compilation that assigned it. Emitting
        // the AST here is what makes the ids and the offsets come from one
        // build; a second compile to obtain them would not.
        '--ast',
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

      // Only a build this run made and can vouch for. Keyed on the commit and
      // the profile, which is what determines the output — a key that named
      // neither would serve one commit's bytecode as another's.
      if (usable()) deps.artifactCache?.save(cacheKey, join(checkout, outDir))
    }

    let parsed: {
      deployedBytecode?: {
        object?: string
        immutableReferences?: ImmutableReferences
      }
      bytecode?: { object?: string }
      ast?: unknown
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

    // EraVM has no constructor/runtime split: what it stores at the address is
    // the whole `bytecode.object`, and the artifact carries no
    // `deployedBytecode` at all. Confirmed byte-for-byte against the deployed
    // `FraxFacet` on zksync.
    const runtimeHex = isZk
      ? parsed.bytecode?.object
      : parsed.deployedBytecode?.object
    if (!runtimeHex || runtimeHex === '0x')
      throw new Error(
        `the rebuilt artifact for ${request.contractName} carries no runtime bytecode`
      )

    // Read from the build's own output directory and resolved against its own
    // checkout, so both the ids and the line numbers describe the commit being
    // graded rather than whatever the operator has checked out.
    const declarations = deps
      .readDeclarations(join(checkout, outDir), checkout)
      .filter((one) => one.contract === request.contractName)

    return {
      runtimeHex,
      ...(parsed.deployedBytecode?.immutableReferences
        ? { immutableReferences: parsed.deployedBytecode.immutableReferences }
        : {}),
      ...(declarations.length > 0
        ? { immutableDeclarations: declarations }
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

/**
 * Where a rebuild's artifacts outlive the checkout that produced them.
 *
 * Shared across runs, unlike {@link defaultCheckoutRoot}: a build is a pure
 * function of the commit and the profile, both of which are in the key, so one
 * run's output is another's answer. What must not be shared is the git
 * worktree — that is what `close()` removes, and what the per-process root
 * keeps one run from deleting under another.
 *
 * Artifacts only. Nothing here is trusted as evidence: the gate re-reads the
 * bytecode out of the restored artifact and compares it against the chain, so a
 * tampered cache produces a MISMATCH and blocks, never a false match.
 */
export const defaultArtifactCacheRoot = (): string =>
  join(tmpdir(), 'lifi-codehash-artifacts')

/**
 * The cross-run artifact store, as the rebuild runner consumes it.
 *
 * Both sides swallow their failures. A cache is an optimisation on a path that
 * decides whether a signature may be taken, so every way it can go wrong has to
 * end in "build it again", never in a gate that could not run.
 *
 * @param root - where cached builds live
 * @returns The `artifactCache` dependency
 */
export const createArtifactCache = (
  root: string = defaultArtifactCacheRoot()
): NonNullable<IForgeRebuildDeps['artifactCache']> => ({
  restore: (key, outDir) => {
    const cached = join(root, key)
    try {
      if (!existsSync(cached)) return false
      cpSync(cached, outDir, { recursive: true })
      return true
    } catch {
      return false
    }
  },
  save: (key, outDir) => {
    // Staged under this process and moved into place in one step, so a run that
    // dies mid-copy cannot leave a half-written build where the next run reads
    // a whole one. The rename loses to whichever process got there first, and
    // losing is fine — both copies are builds of the same commit.
    const staged = join(root, `.staging-${process.pid}-${key}`)
    try {
      mkdirSync(root, { recursive: true })
      cpSync(outDir, staged, { recursive: true })
      renameSync(staged, join(root, key))
    } catch {
      try {
        rmSync(staged, { recursive: true, force: true })
      } catch {
        // Disk, not correctness, and the next save overwrites the staging path.
      }
    }
  },
})

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
/**
 * Reads the code live at an address, without letting one fallback decide it.
 *
 * This read decides the codehash gate, which is the one check that refuses a
 * signature outright, so failing over is not simply a robustness win: it widens
 * the set of endpoints whose answer can make a wrong codehash look right. A
 * stale or hostile fallback that returns the expected bytes would pass the gate
 * on code that is not on chain.
 *
 * So the two cases are separated. The primary answers and its answer stands —
 * the same single endpoint the gate has always trusted, no new trust. Only when
 * the primary cannot answer do the fallbacks get the question, and then no
 * single one of them decides: the remaining endpoints are read together and
 * their answer is taken only if independent providers agree on it at the same
 * block. Agreeing that there is no code at all is agreement too, and is
 * returned as such — the gate is what grades that against the rebuild.
 *
 * On the answer itself this is never worse than reading the primary alone:
 * where that blocked, this either blocks the same way or proceeds on
 * corroborated agreement. On patience it is deliberately less: the primary is
 * read on the sign-time retry budget rather than the endpoint's own, so a
 * network whose only endpoint is throttled reaches the block sooner instead of
 * holding the signature for the ten minutes TronGrid's profile would spend.
 *
 * @param resolveChain - Resolves a network name to its viem chain; injectable for tests.
 * @returns A reader from `(address, network)` to the code at that address, `0x` when none.
 * @throws When the primary is unavailable and the fallbacks do not agree.
 */
export const createDeployedCodeReader =
  (
    resolveChain: (network: string) => Chain = getViemChainForNetworkName
  ): ((address: string, network: string) => Promise<string>) =>
  async (address, network) => {
    const chain = resolveChain(network)
    const [primary, ...fallbacks] = chain.rpcUrls.default.http

    if (primary)
      try {
        const { url, fetchOptions, retryCount, retryDelay } =
          getSignTimeTransportConfig(primary)
        const client = createPublicClient({
          chain,
          transport: http(url, {
            ...(fetchOptions ? { fetchOptions } : {}),
            retryCount,
            retryDelay,
          }),
        })
        return (await client.getCode({ address: address as Address })) ?? '0x'
      } catch (error) {
        if (fallbacks.length === 0) throw error
      }

    if (fallbacks.length === 0)
      throw new Error(
        `No RPC endpoint is configured for ${network}, so the code at ${address} could not be read`
      )

    const verdict = evaluateRpcQuorum(
      await collectProviderObservations(
        fallbacks,
        createCodeReader(address as Address, chain.id)
      )
    )

    // `agreed-absent` is agreement: the providers concur that nothing is
    // deployed there. The gate grades that against the rebuild, and it is the
    // loudest thing this read can report.
    if (verdict.reachesQuorum) return verdict.agreedValue ?? '0x'
    if (verdict.status === 'agreed-absent') return '0x'

    throw new Error(
      `The primary RPC for ${network} could not answer and its fallbacks did not agree on the code at ${address} (${verdict.status}), so nothing here is verified`
    )
  }

/** The one function of `ImmutableSimulator` this reads. */
const IMMUTABLE_SIMULATOR_ABI = [
  {
    type: 'function',
    name: 'getImmutable',
    stateMutability: 'view',
    inputs: [
      { name: '_dest', type: 'address' },
      { name: '_index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const

/**
 * Reads one immutable out of `ImmutableSimulator`, on the same terms as the
 * code read this gate already trusts.
 *
 * Trusted anchor, so the fallbacks never decide alone: the primary answers and
 * its answer stands, and only when it cannot do the remaining endpoints get the
 * question, under the same quorum. A value nobody could read is an error and
 * never a zero — zero is a value an immutable legitimately holds, and
 * defaulting to it would compare a failed read against a config entry that
 * happens to be unset and call the pair a match.
 *
 * @param resolveChain - Resolves a network name to its viem chain; injectable for tests.
 * @returns A reader from `(network, address, index)` to the 32-byte word held there.
 * @throws When the primary is unavailable and the fallbacks do not agree.
 */
export const createImmutableSimulatorReader = (
  resolveChain: (network: string) => Chain = getViemChainForNetworkName
): ((network: string, address: string, index: number) => Promise<string>) => {
  const pins = new Map<string, () => Promise<bigint>>()

  return async (network, address, index) => {
    const chain = resolveChain(network)
    const [primary, ...fallbacks] = chain.rpcUrls.default.http

    if (primary)
      try {
        const { url, fetchOptions, retryCount, retryDelay } =
          getSignTimeTransportConfig(primary)
        const client = createPublicClient({
          chain,
          transport: http(url, {
            ...(fetchOptions ? { fetchOptions } : {}),
            retryCount,
            retryDelay,
          }),
        })
        return await client.readContract({
          address: IMMUTABLE_SIMULATOR_ADDRESS as Address,
          abi: IMMUTABLE_SIMULATOR_ABI,
          functionName: 'getImmutable',
          args: [address as Address, BigInt(index)],
        })
      } catch (error) {
        if (fallbacks.length === 0) throw error
      }

    if (fallbacks.length === 0)
      throw new Error(
        `No RPC endpoint is configured for ${network}, so slot ${index} of ${address} could not be read from ${IMMUTABLE_SIMULATOR_ADDRESS}`
      )

    // One pin per network for every slot of every address, because a fan-out
    // that picks its own head per call reads each slot at a different block and
    // the quorum grades that as unaligned rather than as agreement.
    let pinnedBlock = pins.get(network)
    if (!pinnedBlock) {
      pinnedBlock = createPinnedBlock(fallbacks, chain.id)
      pins.set(network, pinnedBlock)
    }

    const verdict = evaluateRpcQuorum(
      await collectProviderObservations(
        fallbacks,
        createPinnedValueReader(
          chain.id,
          async (client, blockNumber) =>
            client.readContract({
              address: IMMUTABLE_SIMULATOR_ADDRESS as Address,
              abi: IMMUTABLE_SIMULATOR_ABI,
              functionName: 'getImmutable',
              args: [address as Address, BigInt(index)],
              blockNumber,
            }),
          undefined,
          pinnedBlock
        )
      )
    )

    if (verdict.reachesQuorum && verdict.agreedValue !== undefined)
      return verdict.agreedValue

    throw new Error(
      `The primary RPC for ${network} could not answer and its fallbacks did not agree on slot ${index} of ${address} (${verdict.status}), so nothing here is verified`
    )
  }
}

/**
 * What this checkout's AST says about one contract.
 *
 * An empty {@link declarations} means "declares no immutables" only when
 * {@link covered} is true; otherwise it means the enumeration never reached that
 * contract, which is not a fact about the deployment at all.
 */
export interface ILocalImmutableDeclarations {
  covered: boolean
  declarations: readonly IImmutableDeclaration[]
}

/**
 * The immutables `src/` declares, from the checkout the signer is running in.
 *
 * Not from the rebuild of the recorded commit, which is where the EVM path gets
 * them: zksolc emits no AST, so the zk rebuild cannot supply them, and a
 * vanilla-solc `--ast` build of that commit is a second full compile nobody has
 * already paid for. The operator's own tree is the cheaper source AND the
 * anchor a proposer does not reach, which is why the row it feeds is A-LOCAL
 * in provenance even though it is graded under A-ASSUMED.
 *
 * What it costs: a checkout at a different commit from the deployment declares
 * a different set, and a declaration added or removed since shifts every
 * ordinal after it. That reads as a disagreement rather than as a pass, and the
 * table the signer confirms names the slots — but it is the reason this result
 * is confirmed rather than believed.
 *
 * Built once per run and only when a zk target is actually reached, because it
 * compiles the whole of `src/`.
 *
 * @returns A resolver from contract name to its own immutable declarations, and
 * to whether the enumeration covered that contract at all.
 */
export const createLocalImmutableDeclarations = (
  read: () => {
    declarations: readonly IImmutableDeclaration[]
    contracts: ReadonlySet<string>
  } = () => readImmutableDeclarations(buildAst())
): ((contractName: string) => ILocalImmutableDeclarations) => {
  let all: ReturnType<typeof read> | undefined
  return (contractName: string): ILocalImmutableDeclarations => {
    all ??= read()
    return {
      covered: all.contracts.has(contractName),
      declarations: all.declarations.filter(
        (one) => one.contract === contractName
      ),
    }
  }
}

/**
 * Reads and prices the immutables of a contract that keeps them off its code.
 *
 * Every value comes from the chain and every expectation from this checkout, so
 * the pricing is exactly the one the inlined path performs. What it cannot take
 * from either side is which slot belongs to which name — see
 * {@link zkImmutableOrdinals} — so gate L grades the result as assumed and puts
 * the table to the signer.
 *
 * Refusing is the normal answer for anything it cannot establish, and it is
 * carried as an undecided pricing rather than thrown: gate L reports "the
 * values were not established", which is a different row from "they disagree".
 *
 * @param deps - the record read, the local declarations, the simulator read and the config source
 * @returns The `readOffCodeImmutables` dependency of `verifyCutTargets`
 */
export const createOffCodeImmutablesReader = (deps: {
  readRecord: (
    address: string,
    network: string
  ) => Promise<IDeploymentRecordRef | undefined>
  declarationsFor: (contractName: string) => ILocalImmutableDeclarations
  getImmutable: (
    network: string,
    address: string,
    index: number
  ) => Promise<string>
  loadRequirements: () => DeployRequirements
}): ((address: string, network: string) => Promise<IOffCodeImmutables>) => {
  const refused = (reason: string): IOffCodeImmutables => ({
    declared: 'some',
    pricing: { decided: false, reason },
    slotByName: {},
  })

  return async (
    address: string,
    network: string
  ): Promise<IOffCodeImmutables> => {
    const record = await deps.readRecord(address, network)
    if (!record)
      return refused(
        `the deployment record says nothing about ${address} on ${network}, so there is no contract whose immutables could be looked up`
      )

    const local = deps.declarationsFor(record.contractName)
    // "I found nothing" is not "there is nothing": a contract this checkout
    // never compiled — renamed or deleted since the deployment, or an AST build
    // that produced no artifacts at all — contributes the same empty list as one
    // that genuinely declares no immutables, and grading that as `none` passes a
    // contract whose values were never looked at.
    if (!local.covered)
      return refused(
        `no AST from this checkout covers ${record.contractName}, so whether it declares immutables was never established — this tree does not compile that contract`
      )
    const { declarations } = local
    if (declarations.length === 0) return { declared: 'none' }

    const numbered = zkImmutableOrdinals(declarations)
    if (!numbered.ok) return refused(numbered.reason)

    const read = await readZkImmutables({
      address,
      ordinals: numbered.ordinals,
      getImmutable: (target, index) =>
        deps.getImmutable(network, target, index),
    })
    if (!read.ok) return refused(read.reason)

    const observed = observeZkImmutables(read.values)
    if (!('ok' in observed))
      return { declared: 'some', pricing: observed, slotByName: {} }

    return {
      declared: 'some',
      pricing: priceImmutables(
        {
          contractName: record.contractName,
          observed: observed.observed,
          network,
          environment: EnvironmentEnum.production,
          address,
        },
        deps.loadRequirements()
      ),
      slotByName: numbered.ordinals,
    }
  }
}

export const createSignTimeCodehashDeps = (overrides?: {
  recordSource?: IRecordSource
  checkoutRoot?: string
  artifactCacheRoot?: string
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
    readDeclarations: (outDir, sourceRoot) =>
      readImmutableDeclarations(outDir, sourceRoot).declarations,
    artifactCache: createArtifactCache(overrides?.artifactCacheRoot),
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
    sourceRemote: (network: string) => resolveSourceRemote(network, { git }),
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
    readDeployedCode: createDeployedCodeReader(),
  })

  // Same record read and same rebuild cache as the observer, and the deployed
  // bytes are handed over by the observer rather than fetched again, so the two
  // layers cannot grade different readings of one address. The expectations are
  // the one input taken from somewhere else: this checkout, which is the anchor
  // the proposer does not reach.
  const price = createImmutablePricer({
    readRecord,
    scopeFor,
    build: rebuild.build,
    loadRequirements: loadImmutableExpectations,
  })

  return {
    scope: (network: string): ILineageScope => scopeFor(network),
    observe,
    price,
    readOffCodeImmutables: createOffCodeImmutablesReader({
      readRecord,
      declarationsFor: createLocalImmutableDeclarations(),
      getImmutable: createImmutableSimulatorReader(),
      loadRequirements: loadImmutableExpectations,
    }),
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
 * A stored field as trimmed text, whatever the row actually holds.
 *
 * Coerced rather than optional-chained: a row storing a number reaches the
 * signer as `record-unreadable`, which is the unactionable message this
 * resolver exists to replace, and the store's shape is not ours to assume.
 */
const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim()

/** The fields the gate reads off a production deployment record. */
interface IDeploymentRecordFields {
  contractName: string
  version?: string
  gitCommitHash?: string
}

/**
 * The filter that finds every production record for one address on one network.
 *
 * The decoded cut supplies checksummed addresses (`classifyCut` returns
 * `getAddress`), and records were written in either case over the years, so an
 * exact match alone can miss on case. Do not "simplify" this by lowercasing one
 * side: the stored case is not ours to assume. `network` is matched exactly on
 * purpose — the deploy path writes it from the config key, so it is lowercase
 * by construction, unlike an address that a human or an older script may have
 * written either way.
 *
 * One query rather than exact-then-fallback: the fallback only ran when the
 * exact tier came back empty, so a corrupt row stored in the other casing sat
 * behind a clean exact match and was never compared against it. Casing is a
 * spelling of one address, not two addresses.
 *
 * A Tron record stores base58 while the cut carries 20-byte hex, so the address
 * as decoded matches nothing there. Those spellings are matched exactly and
 * never case-insensitively: base58check is case-sensitive, so folding case
 * there would match an address that is not the one asked about.
 *
 * `\z` rather than `$` on the hex spelling: this is PCRE2, where `$` also
 * matches before a trailing newline, so `$` would let `<address>\n` answer for
 * the address.
 *
 * @param address - the address as the calldata carries it
 * @param network - key in `config/networks.json`
 * @returns The filter both spellings are looked up through
 */
export const buildRecordQuery = (
  address: string,
  network: string
): Filter<IDeploymentRecordFields> => {
  const spellings =
    createTronAddressSpellings(network)?.forCalldataAddress(address)
  return {
    network: { $eq: network },
    $or: [
      {
        address: {
          $regex: `^${escapeRegexLiteral(address)}\\z`,
          $options: 'i',
        },
      },
      ...(spellings ? [{ address: { $in: spellings } }] : []),
    ],
  }
}

/**
 * Picks the one record that describes an address, or refuses.
 *
 * There is no "latest wins" here to implement. An address holds one contract
 * for its whole life, so two records that disagree about it are not a history —
 * one of them is wrong, and every ordering picks the wrong one somewhere. The
 * production collection carries both shapes today: `TCyAJzp…` on tron is
 * AllBridgeFacet 2.1.1 per the diamond log that recorded the cut, while a later
 * backfill row claims 2.1.2 at the same address, and `0x851450…` on metis
 * carries LiFuelFeeCollector and TokenWrapper at once. Sorting by `timestamp`
 * picks the wrong row for tron's TokenWrapper, sorting by version picks the
 * wrong row for AllBridgeFacet, and sorting by `createdAt` picks a
 * blank-version row on three EVM chains. A refusal reaches the signer as
 * `record-unreadable`, which is the honest answer to a store that holds two.
 *
 * The one collapse is a blank field alongside a filled one: the verification
 * step rewrites the row it just verified and loses `version` on the way
 * through, and most rows carry no commit at all, so a blank is absence of
 * evidence rather than a competing claim. Two *filled* values disagreeing is
 * the refusal, for the commit as much as for the version — the commit is what
 * the rebuild is keyed on, so picking between two would choose which source to
 * attest against. The query is unsorted, so picking either would also vary
 * between runs on identical data.
 *
 * @param candidates - every record matching the address and network
 * @param address - the address being resolved, for the refusal message
 * @param network - the network being resolved, for the refusal message
 * @returns The single record, or null when there is none
 * @throws When the surviving records disagree on contract, version or commit
 */
export const resolveDeploymentRecord = <
  T extends { contractName: string; version?: string; gitCommitHash?: string }
>(
  candidates: T[],
  address: string,
  network: string
): T | null => {
  if (candidates.length === 0) return null

  // Trimmed everywhere, and the identity key below is built from this rather
  // than from the raw field: a row whose version differs from its twin's by a
  // space describes the same deploy, and comparing raw strings would refuse
  // exactly the duplicates this collapses. `version` is optional on the record
  // interface, so a missing one must read as blank rather than throw.
  const versionOf = (record: T): string => text(record.version)

  const named = new Set(
    candidates.filter((r) => versionOf(r) !== '').map((r) => r.contractName)
  )
  const kept = candidates.filter(
    (r) => versionOf(r) !== '' || !named.has(r.contractName)
  )

  const refuse = (what: string, values: string[]): never => {
    throw new Error(
      `the production deployment records disagree about ${what} at ${address} on ${network}: ${values
        .sort()
        .join(
          ', '
        )}. An address holds one contract, so one of these records is wrong and no ordering of them is a safe guess — fix the records before signing against this address.`
    )
  }

  const identities = new Set(
    kept.map((r) => `${r.contractName}@${versionOf(r)}`)
  )
  if (identities.size > 1) refuse('what is', [...identities])

  const commits = new Set(
    kept.map((r) => text(r.gitCommitHash)).filter((c) => c !== '')
  )
  if (commits.size > 1) refuse('which commit built what is', [...commits])

  return (kept.find((r) => text(r.gitCommitHash) !== '') ?? kept[0]) as T
}

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
    const collection = client
      .db('contract-deployments')
      .collection<IDeploymentRecordFields>(EnvironmentEnum.production)

    const matches = await collection
      .find(buildRecordQuery(address, network))
      .toArray()
    return resolveDeploymentRecord(matches, address, network)
  },
})

const closeMongoRecordSource = async (): Promise<void> => {
  if (!client) return
  const open = client
  client = undefined
  await open.close(true).catch(() => undefined)
}

/**
 * `deployRequirements.json` joined with `immutableRegistry.json`, from the
 * checkout the signer is running in.
 *
 * Read fresh on each call rather than cached at module load: a signing session
 * outlives a `git pull`, and an expectation set from before one is not the one
 * the operator believes they are checking against.
 *
 * @returns The merged requirements layer 2 resolves expectations through
 */
export const loadImmutableExpectations = (): DeployRequirements =>
  mergeRequirements(
    JSON.parse(
      readFileSync(
        join(
          REPO_ROOT,
          'script',
          'deploy',
          'resources',
          'deployRequirements.json'
        ),
        'utf8'
      )
    ) as DeployRequirements,
    JSON.parse(
      readFileSync(
        join(
          REPO_ROOT,
          'script',
          'deploy',
          'resources',
          'immutableRegistry.json'
        ),
        'utf8'
      )
    ) as Record<string, Record<string, IImmutableEntry>>
  )

/**
 * Prices the bytes layer 1 masked, for one address on one network.
 *
 * Every input comes from a side the proposer does not control: the runtime code
 * from the chain, the offsets and declarations from a rebuild of the commit the
 * record names, and the expectations from `immutableRegistry.json` plus
 * `deployRequirements.json` plus `config/` **in the operator's own checkout**.
 * The rebuild's checkout sits at a commit the proposer influences, so reading
 * the expectations from there would let a proposal declare what it should be
 * compared against.
 *
 * `production` for the same reason {@link createMongoRecordSource} uses it: this
 * judges proposals against a production Safe, and a staging config describes a
 * different deploy.
 *
 * Refusing is the normal answer for anything it cannot establish — no record, no
 * commit, no immutables in the artifact — because layer 1's masked verdict then
 * stands exactly as it did before this layer ran. Nothing here can turn a
 * refusal into a pass.
 *
 * @param deps - the record read, the toolchain scope, the rebuild, the chain read and the config source
 * @returns The `price` dependency of `verifyCutTargets`
 */
export const createImmutablePricer = (deps: {
  readRecord: (
    address: string,
    network: string
  ) => Promise<IDeploymentRecordRef | undefined>
  scopeFor: (network: string) => IToolchainScope
  build: (request: IRebuildRequest) => IRebuiltArtifact
  loadRequirements: () => DeployRequirements
}): ((
  address: string,
  network: string,
  runtimeCode: string
) => Promise<ImmutablePricing>) => {
  return async (
    address: string,
    network: string,
    runtimeCode: string
  ): Promise<ImmutablePricing> => {
    const record = await deps.readRecord(address, network)
    if (!record)
      return {
        decided: false,
        reason: `the deployment record says nothing about ${address} on ${network}, so there is no contract whose immutables could be looked up`,
      }

    const commit = record.gitCommitHash.trim()
    if (commit === '' || commit === UNKNOWN_COMMIT)
      return {
        decided: false,
        reason: `the record for ${record.contractName} at ${address} carries no commit, so no build of it can supply the offsets its immutables sit at`,
      }

    const profiles = deps.scopeFor(network).profiles
    if (profiles.length !== 1)
      return {
        decided: false,
        reason: `${network} resolves to ${profiles.length} build profiles, and immutable offsets are per lineage, so there is no single build to read them from`,
      }

    const profile = profiles[0]
    if (!profile)
      return {
        decided: false,
        reason: `${network} resolves to no build profile, so there is no build to read immutable offsets from`,
      }

    const artifact = deps.build({
      contractName: record.contractName,
      commit,
      profile,
    })

    // Both come from that one build, which is what makes the ids line up. A
    // contract with no immutables reaches here with neither, and its masked
    // count is zero, so layer 1 never needed this layer for it.
    if (!artifact.immutableReferences || !artifact.immutableDeclarations)
      return {
        decided: false,
        reason: `the rebuild of ${record.contractName} at ${commit.slice(
          0,
          9
        )} reports no immutables, so the bytes masked in the deployed code cannot be named`,
      }

    const observed = observeEvmImmutables(
      runtimeCode,
      artifact.immutableReferences,
      artifact.immutableDeclarations
    )
    // Discriminated on the property the ok branch carries, matching how
    // `immutable-expectations` narrows the same union.
    if (!('ok' in observed)) return observed

    return priceImmutables(
      {
        contractName: record.contractName,
        observed: observed.observed,
        network,
        environment: EnvironmentEnum.production,
        address,
      },
      deps.loadRequirements()
    )
  }
}
