/**
 * Sign-time target-state check, evaluated against `origin/main` rather than the
 * reviewer's checkout.
 *
 * Import this from the confirmation flow to grade what a proposal's `diamondCut`
 * would install against the version `main` declares for that network. Two classes
 * of input are kept apart on purpose: the expected version comes from `origin/main`
 * and the proposed version from the deployment record, while the proposer's branch
 * is never read — nothing a proposer controls may turn this check green.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatAddressForNetworkCliDisplay } from '@lifi/tron-devkit'
import { type Hex } from 'viem'

import { readContractVersion } from '../shared/contract-version'
import { collectDiamondCutCalls } from '../shared/diamond-cut-calls'

import {
  resolveDeployedContractByAddress,
  type DeployedContractLookup,
} from './facet-version-utils'

// Resolved from this module rather than `process.cwd()`: the anchor has to be
// this repository's `origin/main` no matter which directory the reviewer ran the
// script from.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
)

/** The path the anchor is read from, inside the pinned tree. */
export const TARGET_STATE_REPO_PATH = 'script/deploy/_targetState.json'

/** The ref the expected state is read at, as the signer is told it. */
export const PINNED_REF = 'origin/main'

// Spelled in full for the read: git resolves a short name through refs/, tags and
// heads before refs/remotes, so a tag or branch literally named `origin/main` in
// the clone would be read instead of the ref the fetch just wrote.
const PINNED_READ_REF = 'refs/remotes/origin/main'

/** The repository the anchor must come from. */
export const EXPECTED_REMOTE_REPO = 'github.com/lifinance/contracts'

/**
 * The refspec the anchor is fetched with.
 *
 * Explicit, because git updates `refs/remotes/origin/main` only opportunistically:
 * where the clone's own fetch refspec does not cover main, `git fetch origin main`
 * leaves an existing `origin/main` untouched and the anchor is read stale with no
 * error.
 */
export const PINNED_FETCH_REFSPEC = '+refs/heads/main:refs/remotes/origin/main'

// `origin` is whatever the clone happens to point at, so the ref alone does not
// establish where the anchor came from: a fork remote would let a proposer author
// the expected state. ssh.github.com and an explicit port are admitted because
// they are GitHub's own SSH-over-443 spelling, which a restricted network needs.
const EXPECTED_REMOTE_URL =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|ssh:\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|(?:[^@/]+@)?(?:ssh\.)?github\.com:)lifinance\/contracts(?:\.git)?\/?$/i

const TARGET_STATE_ENVIRONMENT = 'production'
const TARGET_STATE_DIAMOND = 'LiFiDiamond'

/**
 * The target-state value meaning "follow the repo".
 *
 * A network declaring this expects whatever `@custom:version` says at
 * {@link PINNED_REF}; any other value is a pin that holds the network back.
 */
export const TARGET_STATE_VERSION_LATEST = 'latest'

/** Where a contract's source may live, in the order `getContractVersion` looks. */
const SOURCE_DIRS = ['src', 'src/Facets', 'src/Periphery', 'src/Security']

/** Solidity-style contract name, so a read stays inside `src/`. */
const CONTRACT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `network → environment → diamond → contract → version`, as `main` declares it. */
export type PinnedTargetState = Record<
  string,
  Record<string, Record<string, Record<string, unknown>>>
>

export type PinnedTargetStateRead =
  | { ok: true; state: PinnedTargetState }
  | {
      ok: false
      reason:
        | 'fetch-failed'
        | 'remote-unreadable'
        | 'remote-unexpected'
        | 'blob-unreadable'
        | 'invalid-shape'
    }

/** `LibDiamond.FacetCutAction`. */
const CUT_ACTION_ADD = 0
const CUT_ACTION_REPLACE = 1
const CUT_ACTION_REMOVE = 2

const INSTALLING_ACTIONS: ReadonlySet<number> = new Set([
  CUT_ACTION_ADD,
  CUT_ACTION_REPLACE,
])

export type TargetStateStatus =
  | 'no-diamond-cut'
  | 'removal'
  | 'not-previously-targeted'
  | 'matches-main'
  | 'ahead-of-main'
  | 'matches-pin'
  | 'pinned-mismatch'
  | 'expected-version-unresolved'
  | 'downgrade'
  | 'version-not-comparable'
  | 'proposed-version-unresolved'
  | 'contract-unidentified'
  | 'deployment-record-ambiguous'
  | 'unrecognised-cut-action'
  | 'calldata-not-readable'
  | 'pinned-state-unavailable'

/**
 * The statuses a proposal may be signed or executed with.
 *
 * Named by what may proceed, so a status added later refuses until it is
 * admitted here deliberately.
 *
 * Exported so the ledger mapping can be cross-checked against it rather than
 * against a copy: a test that restates the set proves only that the copy agrees
 * with itself, and stays green while the two drift.
 */
export const STATUSES_CLEARED_TO_PROCEED: ReadonlySet<TargetStateStatus> =
  new Set<TargetStateStatus>([
    'no-diamond-cut',
    'removal',
    'not-previously-targeted',
    'matches-main',
    'ahead-of-main',
    'matches-pin',
  ])

/** One graded element of a proposal. */
export interface ITargetStateFinding {
  status: TargetStateStatus
  /** Checksummed facet address the cut names, or null when the finding is not per-facet. */
  facetAddress: string | null
  contractName: string | null
  /** Version the deployment record has for `facetAddress`. */
  proposedVersion: string | null
  /** Version `origin/main` declares for this contract on this network. */
  mainVersion: string | null
  /** Networks whose pinned target state already declares this contract at `proposedVersion`. */
  crossFleetCount: number | null
  detail: string
}

export interface ITargetStateVerdict {
  findings: ITargetStateFinding[]
  /** True only when every finding's status is cleared to proceed. */
  cleared: boolean
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Compares two `major.minor.patch` versions numerically.
 * @param left - first version
 * @param right - second version
 * @returns Negative when `left` is older, 0 when equal, positive when newer;
 * null when either side is not three dot-separated integers.
 */
export const compareSemanticVersions = (
  left: string,
  right: string
): number | null => {
  const a = SEMVER.exec(left.trim())
  const b = SEMVER.exec(right.trim())
  if (!a || !b) return null
  for (let part = 1; part <= 3; part++) {
    const diff = Number(a[part]) - Number(b[part])
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Reads the version `main` declares for one contract on one network.
 * @param state - the pinned target state
 * @param network - network name (e.g. optimism)
 * @param contractName - contract name as the target state spells it
 * @returns The declared version, or null when the network, diamond or contract has no entry
 */
export const readDeclaredVersion = (
  state: PinnedTargetState,
  network: string,
  contractName: string
): string | null => {
  const version =
    state[network.toLowerCase()]?.[TARGET_STATE_ENVIRONMENT]?.[
      TARGET_STATE_DIAMOND
    ]?.[contractName]
  return typeof version === 'string' ? version : null
}

/**
 * Counts the networks whose pinned target state declares a contract at all.
 *
 * Corroboration for a first-time add, which by construction has no entry of its
 * own on `main`: a contract already declared across the fleet is a rollout
 * reaching one more chain, one declared nowhere is a genuinely new build.
 *
 * @remarks Counts membership rather than a matching version. Since versions read
 *   `latest` fleet-wide, a version-matched count would report 0 everywhere and be
 *   read as "no corroboration" when it means "nobody pins this".
 * @param state - the pinned target state
 * @param contractName - contract name as the target state spells it
 * @returns How many networks declare that contract
 */
export const countNetworksDeclaring = (
  state: PinnedTargetState,
  contractName: string
): number =>
  Object.keys(state).filter(
    (network) => readDeclaredVersion(state, network, contractName) !== null
  ).length

/** What `origin/main` expects of one contract on one network. */
export type ExpectedVersion =
  /** No entry: the contract is not declared for this network. */
  | { kind: 'absent' }
  /** The network is pinned to this exact version. */
  | { kind: 'pin'; version: string }
  /** The network follows the repo, which is at this version. */
  | { kind: 'latest'; version: string }
  /** The network follows the repo, but the repo's version could not be read. */
  | { kind: 'unresolved'; detail: string }

/**
 * Resolves what {@link PINNED_REF} expects, for one contract on one network.
 *
 * A declared semver is a pin and is returned as written. `latest` delegates to
 * the contract's `@custom:version` **at the same pinned ref** — never this
 * checkout, which the proposer controls.
 * @param state - the pinned target state
 * @param network - network the proposal targets
 * @param contractName - contract name as the target state spells it
 * @param readSourceVersion - reads a contract's version at the pinned ref
 * @returns What the network expects, or why it could not be established
 */
export const resolveExpectedVersion = (
  state: PinnedTargetState,
  network: string,
  contractName: string,
  readSourceVersion: (contractName: string) => SourceVersionRead
): ExpectedVersion => {
  const declared = readDeclaredVersion(state, network, contractName)
  if (declared === null) return { kind: 'absent' }
  if (declared !== TARGET_STATE_VERSION_LATEST)
    return { kind: 'pin', version: declared }

  const read = readSourceVersion(contractName)
  if (read.ok) return { kind: 'latest', version: read.version }
  return { kind: 'unresolved', detail: read.detail }
}

/** A contract's `@custom:version` at the pinned ref, or why it is not available. */
export type SourceVersionRead =
  | { ok: true; version: string }
  | { ok: false; detail: string }

/** The reads this check needs, injectable so the policy is testable. */
export interface ITargetStateDeps {
  /** The expected state, read at {@link PINNED_REF}. */
  readPinnedState: () => PinnedTargetStateRead
  /** A contract's `@custom:version`, read at {@link PINNED_REF}. */
  readSourceVersion: (contractName: string) => SourceVersionRead
  /** What the deployment record says a facet address is. */
  resolveDeployed: (facetAddress: string) => DeployedContractLookup
}

/**
 * Says why the anchor could not be read, in the words the signer sees.
 * @param reason - why the pinned read failed
 * @returns The operator-facing explanation, naming the remedy
 */
export const describeTargetStateUnavailable = (
  reason: Exclude<PinnedTargetStateRead, { ok: true }>['reason']
): string => {
  if (reason === 'fetch-failed')
    return `could not refresh ${PINNED_REF} — the expected version can only come from the remote, and a stale local copy is not an anchor. Restore network access to the git remote and re-run.`
  if (reason === 'remote-unreadable')
    return `could not read this clone's \`origin\` remote, so it cannot be established that the anchor would come from ${EXPECTED_REMOTE_REPO}.`
  if (reason === 'remote-unexpected')
    return `this clone's \`origin\` is not ${EXPECTED_REMOTE_REPO} — the anchor would be read from a repository the proposer could control. Re-run from a clone whose origin is ${EXPECTED_REMOTE_REPO}.`
  if (reason === 'blob-unreadable')
    return `could not read ${PINNED_REF}:${TARGET_STATE_REPO_PATH} — the ref or the file is missing from this clone.`
  return `${PINNED_REF}:${TARGET_STATE_REPO_PATH} did not parse as a target-state object.`
}

/**
 * Grades a proposal's `diamondCut` elements against the version `origin/main`
 * declares, one finding per element.
 *
 * R4.6 is graded per case, not as a single equality: an upgrade of a facet `main`
 * already targets is the mechanical anchor and a downgrade there refuses, while a
 * first-time add has no entry on `main` by construction — the target-state PR
 * merges only after execution — so it is labeled and allowed. Grading absence as
 * a "no" would refuse every honest new-chain rollout.
 * @param calldatas - the proposal's calls, in the order they were passed
 * @param network - network the proposal targets
 * @param deps - the pinned-state and deployment-record reads
 * @returns Every finding, and whether all of them are cleared to proceed
 */
export const evaluateTargetStateIntent = (
  calldatas: readonly Hex[],
  network: string,
  deps: ITargetStateDeps
): ITargetStateVerdict => {
  const findings: ITargetStateFinding[] = []
  const blank = {
    facetAddress: null,
    contractName: null,
    proposedVersion: null,
    mainVersion: null,
    crossFleetCount: null,
  }

  const { calls, undecodable } = collectDiamondCutCalls(calldatas)

  for (const index of undecodable)
    findings.push({
      ...blank,
      status: 'calldata-not-readable',
      detail: `call ${index} carries the diamondCut selector but no cut could be read out of it, so what it installs cannot be graded against ${PINNED_REF}.`,
    })

  const elements = calls.flatMap((call) => call.cuts)

  if (elements.length === 0) {
    if (findings.length === 0)
      findings.push({
        ...blank,
        status: 'no-diamond-cut',
        detail: 'no diamondCut in this proposal — nothing to compare.',
      })
    return {
      findings,
      cleared: findings.every((f) => STATUSES_CLEARED_TO_PROCEED.has(f.status)),
    }
  }

  // Read lazily: a proposal made only of removals, or of calls that are not cuts
  // at all, needs no anchor, and must not be refused because the remote is
  // unreachable.
  let pinned: PinnedTargetStateRead | undefined
  const pinnedState = (): PinnedTargetStateRead => {
    pinned ??= deps.readPinnedState()
    return pinned
  }

  for (const element of elements) {
    const facetAddress = element.facetAddress

    if (element.action === CUT_ACTION_REMOVE) {
      findings.push({
        ...blank,
        facetAddress,
        status: 'removal',
        detail:
          'facet removal — the target state carries no record of a removal, so this is reported rather than graded.',
      })
      continue
    }

    if (!INSTALLING_ACTIONS.has(element.action)) {
      findings.push({
        ...blank,
        facetAddress,
        status: 'unrecognised-cut-action',
        detail: `cut action ${element.action} is not Add, Replace or Remove — what it would do to the diamond is unknown.`,
      })
      continue
    }

    const read = pinnedState()
    if (!read.ok) {
      findings.push({
        ...blank,
        facetAddress,
        status: 'pinned-state-unavailable',
        detail: describeTargetStateUnavailable(read.reason),
      })
      continue
    }

    const deployed = deps.resolveDeployed(facetAddress)

    if (deployed.kind === 'ambiguous') {
      findings.push({
        ...blank,
        facetAddress,
        status: 'deployment-record-ambiguous',
        detail: `the deployment record for this address on ${network} contradicts itself — ${
          deployed.contractNames.join(' / ') || 'no name'
        } at ${
          deployed.versions.join(' / ') || 'no version'
        } — so which one this cut installs cannot be established, and neither can a downgrade be ruled out.`,
      })
      continue
    }

    const contractName =
      deployed.kind === 'resolved' ? deployed.contractName : null
    const proposedVersion =
      deployed.kind === 'resolved' ? deployed.version : null

    // An address with no record is not the same question as a contract with no
    // entry on `main`. Without a name there is nothing to look the anchor up
    // by, so clearing it as a first-time add would hand a free pass to any
    // address a proposer chose to name.
    if (!contractName) {
      findings.push({
        ...blank,
        facetAddress,
        proposedVersion,
        status: 'contract-unidentified',
        detail: `no deployment record on ${network} names this address, so the contract it installs cannot be identified and this check could not run. Remedy: write the missing MongoDB deployment record for this address.`,
      })
      continue
    }

    const expected = resolveExpectedVersion(
      read.state,
      network,
      contractName,
      deps.readSourceVersion
    )

    if (expected.kind === 'absent') {
      findings.push({
        facetAddress,
        contractName,
        proposedVersion,
        mainVersion: null,
        crossFleetCount: countNetworksDeclaring(read.state, contractName),
        status: 'not-previously-targeted',
        detail: `${contractName} is not declared for ${network} in ${PINNED_REF} — expected for a first deployment, since the target-state update merges only after execution. Intent rests on the linked ticket and PR.`,
      })
      continue
    }

    if (expected.kind === 'unresolved') {
      findings.push({
        ...blank,
        facetAddress,
        contractName,
        proposedVersion,
        status: 'expected-version-unresolved',
        detail: `${network} follows the repo for ${contractName}, but ${expected.detail} — with no expected version, a downgrade cannot be ruled out.`,
      })
      continue
    }

    const mainVersion = expected.version

    if (!proposedVersion) {
      findings.push({
        facetAddress,
        contractName,
        proposedVersion: null,
        mainVersion,
        crossFleetCount: null,
        status: 'proposed-version-unresolved',
        detail: `${PINNED_REF} declares ${contractName} at v${mainVersion} on ${network}, but its deployment record carries no version, so a downgrade cannot be ruled out. Remedy: backfill the version on that MongoDB deployment record — the blank is in the record, not in the cut.`,
      })
      continue
    }

    // A pin is a deliberate statement that this network is held back, so it is
    // graded as equality rather than as an ordering: "newer than the pin" is
    // still not what the pin asked for.
    if (expected.kind === 'pin') {
      const matches = proposedVersion === mainVersion
      findings.push({
        facetAddress,
        contractName,
        proposedVersion,
        mainVersion,
        crossFleetCount: null,
        status: matches ? 'matches-pin' : 'pinned-mismatch',
        detail: matches
          ? `v${proposedVersion} matches the v${mainVersion} ${PINNED_REF} pins ${contractName} to on ${network}.`
          : `${PINNED_REF} pins ${contractName} to v${mainVersion} on ${network}, but this cut installs v${proposedVersion}. Either the pin is stale or the proposal is wrong — both are fixed by a PR to main, not here.`,
      })
      continue
    }

    const order = compareSemanticVersions(proposedVersion, mainVersion)
    const shared = {
      facetAddress,
      contractName,
      proposedVersion,
      mainVersion,
      crossFleetCount: null,
    }

    if (order === null)
      findings.push({
        ...shared,
        status: 'version-not-comparable',
        detail: `v${proposedVersion} and the declared v${mainVersion} are not both major.minor.patch, so which is newer cannot be established.`,
      })
    else if (order < 0)
      findings.push({
        ...shared,
        status: 'downgrade',
        detail: `v${proposedVersion} is OLDER than the v${mainVersion} ${PINNED_REF} declares on ${network} — this cut would move the diamond backwards.`,
      })
    else if (order === 0)
      findings.push({
        ...shared,
        status: 'matches-main',
        detail: `v${proposedVersion} matches the version ${PINNED_REF} declares on ${network}.`,
      })
    else
      findings.push({
        ...shared,
        status: 'ahead-of-main',
        detail: `v${proposedVersion} is newer than the v${mainVersion} ${PINNED_REF} declares on ${network}.`,
      })
  }

  return {
    findings,
    cleared: findings.every((f) => STATUSES_CLEARED_TO_PROCEED.has(f.status)),
  }
}

/** Injectable git reads, so tests never touch a real remote. */
export interface IPinnedStateGit {
  remoteUrl: () => string
  fetch: () => void
  show: (revSpec: string) => string
}

const defaultGit = (repoRoot: string): IPinnedStateGit => ({
  // `get-url` rather than `config remote.origin.url`, because it applies any
  // insteadOf rewrite and so reports where a fetch would actually go.
  remoteUrl: () =>
    execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    }),
  fetch: () => {
    execFileSync('git', ['fetch', '--quiet', 'origin', PINNED_FETCH_REFSPEC], {
      cwd: repoRoot,
      stdio: 'ignore',
      timeout: 60_000, // 60 seconds — a hung remote must not hold up a review
    })
  },
  show: (revSpec) =>
    execFileSync('git', ['show', revSpec], {
      cwd: repoRoot,
      encoding: 'utf8',
      // A source lookup tries each candidate directory in turn, so a miss is routine
      // rather than an incident; without this every miss prints a raw `fatal:` into the
      // signer's terminal mid-ceremony. The throw still carries the failure.
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000, // 60 seconds — matches the other git seams
      maxBuffer: 16 * 1024 * 1024, // 16 MB — the target state is ~74 KB today
    }),
})

/**
 * Establishes that the anchor may be trusted, and refreshes it.
 *
 * Shared by every pinned read so the remote check exists in exactly one place: a
 * reader that skipped it would take its answer from whatever repository `origin`
 * happens to point at.
 *
 * `memoizable` separates a refusal that will not change within the process (this
 * clone's `origin` is the wrong repository) from one that might (an exec that
 * could not run), so a caller never caches a transient failure.
 * @param git - the git seam to read and fetch through
 * @returns That the ref is refreshed, or why it is not and whether to cache that
 */
const verifyRemoteAndFetch = (
  git: IPinnedStateGit
):
  | { ok: true }
  | { ok: false; reason: PinnedReadFailure; memoizable: boolean } => {
  let remote: string
  try {
    remote = git.remoteUrl()
  } catch {
    // Not memoizable, for the same reason a failed fetch is not: an exec that
    // could not run says nothing about what the remote is.
    return { ok: false, reason: 'remote-unreadable', memoizable: false }
  }
  if (!EXPECTED_REMOTE_URL.test(remote.trim()))
    return { ok: false, reason: 'remote-unexpected', memoizable: true }

  try {
    git.fetch()
  } catch {
    // A transient fetch must not pin the rest of the process to a refusal —
    // the sibling cache reader in facet-version-utils.ts makes the same call.
    return { ok: false, reason: 'fetch-failed', memoizable: false }
  }
  return { ok: true }
}

/** The ways a pinned read can fail. */
export type PinnedReadFailure = Exclude<
  PinnedTargetStateRead,
  { ok: true }
>['reason']

/**
 * Builds the pinned read: one `git fetch` per process, then the target state as
 * `origin/main` has it.
 *
 * The result is memoized so a fleet run of 70 networks costs one fetch and one
 * blob read.
 * @param options - repository root and git seam; both default to this checkout
 * @returns A reader returning the pinned state, or why it could not be read
 */
export const createPinnedTargetStateReader = (options?: {
  repoRoot?: string
  git?: IPinnedStateGit
}): (() => PinnedTargetStateRead) => {
  const repoRoot = options?.repoRoot ?? REPO_ROOT
  const git = options?.git ?? defaultGit(repoRoot)
  let memo: PinnedTargetStateRead | undefined

  return () => {
    if (memo) return memo

    const anchored = verifyRemoteAndFetch(git)
    if (!anchored.ok) {
      const failure = { ok: false as const, reason: anchored.reason }
      if (anchored.memoizable) memo = failure
      return failure
    }

    let raw: string
    try {
      raw = git.show(`${PINNED_READ_REF}:${TARGET_STATE_REPO_PATH}`)
    } catch {
      memo = { ok: false, reason: 'blob-unreadable' }
      return memo
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      memo = { ok: false, reason: 'invalid-shape' }
      return memo
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      memo = { ok: false, reason: 'invalid-shape' }
    else memo = { ok: true, state: parsed as PinnedTargetState }

    return memo
  }
}

/**
 * Builds the source-version read: a contract's `@custom:version` at {@link PINNED_REF}.
 *
 * Shares the remote check and fetch with the target-state reader rather than
 * taking a tree-ish of its own — a reader that accepted any ref would let a
 * proposer's clone author the version this check grades against.
 * @param options - repository root and git seam; both default to this checkout
 * @returns A reader taking a contract name, returning its version or why not
 */
export const createPinnedSourceVersionReader = (options?: {
  repoRoot?: string
  git?: IPinnedStateGit
}): ((contractName: string) => SourceVersionRead) => {
  const repoRoot = options?.repoRoot ?? REPO_ROOT
  const git = options?.git ?? defaultGit(repoRoot)
  const memo = new Map<string, SourceVersionRead>()
  // Held across contracts, not just across repeat reads of one: a proposal naming
  // several facets would otherwise fetch once per name.
  let anchored: ReturnType<typeof verifyRemoteAndFetch> | undefined

  return (contractName) => {
    const cached = memo.get(contractName)
    if (cached) return cached

    const resolve = (): { read: SourceVersionRead; memoizable: boolean } => {
      if (!CONTRACT_NAME_RE.test(contractName))
        return {
          read: {
            ok: false,
            detail: `'${contractName}' is not a Solidity identifier, so no source path can be built for it`,
          },
          memoizable: true,
        }

      // A refusal that could change within the process is retried rather than held.
      if (!anchored || (!anchored.ok && !anchored.memoizable))
        anchored = verifyRemoteAndFetch(git)
      if (!anchored.ok)
        return {
          read: {
            ok: false,
            detail: describeTargetStateUnavailable(anchored.reason),
          },
          memoizable: anchored.memoizable,
        }

      for (const dir of SOURCE_DIRS) {
        let source: string
        try {
          source = git.show(`${PINNED_READ_REF}:${dir}/${contractName}.sol`)
        } catch {
          continue
        }
        const read = readContractVersion(source)
        if (read.kind === 'ok')
          return { read: { ok: true, version: read.base }, memoizable: true }
        // A file that exists but carries no usable tag is this contract's
        // answer, not a reason to keep looking in the other directories.
        return {
          read: {
            ok: false,
            detail:
              read.kind === 'malformed'
                ? `'${read.raw}' in ${dir}/${contractName}.sol at ${PINNED_REF} is not a @custom:version`
                : `${dir}/${contractName}.sol at ${PINNED_REF} carries no @custom:version`,
          },
          memoizable: true,
        }
      }

      return {
        read: {
          ok: false,
          detail: `no source for ${contractName} at ${PINNED_REF} (looked in ${SOURCE_DIRS.join(
            ', '
          )}) — a contract whose source was deleted cannot be graded`,
        },
        memoizable: true,
      }
    }

    // An unreachable remote must not turn the rest of a fleet run into refusals.
    const { read, memoizable } = resolve()
    if (memoizable) memo.set(contractName, read)
    return read
  }
}

/**
 * The production reads: `origin/main` for the expected version, the deployment
 * record for the proposed one.
 *
 * The record read stays relative to the working directory because that is where
 * the confirmation flow refreshes the cache from MongoDB; only the anchor is
 * pinned, and only the anchor is repository content a proposer could edit.
 * @param network - network the proposal targets
 * @param options - overrides for the pinned read and the cache root
 * @returns Deps for {@link evaluateTargetStateIntent}
 */
export const createTargetStateDeps = (
  network: string,
  options?: {
    readPinnedState?: () => PinnedTargetStateRead
    readSourceVersion?: (contractName: string) => SourceVersionRead
    cacheRootDir?: string
  }
): ITargetStateDeps => ({
  readPinnedState: options?.readPinnedState ?? createPinnedTargetStateReader(),
  readSourceVersion:
    options?.readSourceVersion ?? createPinnedSourceVersionReader(),
  resolveDeployed: (facetAddress) =>
    resolveDeployedContractByAddress(
      network,
      // A Tron deployment record stores the base58 form, so the hex address a
      // cut carries matches nothing there and every Tron facet would grade as
      // never targeted.
      [facetAddress, formatAddressForNetworkCliDisplay(network, facetAddress)],
      options?.cacheRootDir
    ),
})

/**
 * Renders a verdict for the signer, one line per finding.
 * @param verdict - output of {@link evaluateTargetStateIntent}
 * @returns Display lines, blocking findings first
 */
export const formatTargetStateLines = (
  verdict: ITargetStateVerdict
): string[] => {
  const label: Record<TargetStateStatus, string> = {
    'no-diamond-cut': 'n/a',
    removal: 'REMOVAL (warn)',
    'not-previously-targeted': 'NOT PREVIOUSLY TARGETED',
    'matches-main': 'matches main',
    'ahead-of-main': 'upgrade',
    'matches-pin': 'matches pin',
    'pinned-mismatch': 'PINNED VERSION MISMATCH',
    'expected-version-unresolved': 'EXPECTED VERSION UNRESOLVED',
    downgrade: 'DOWNGRADE',
    'version-not-comparable': 'UNEXPECTED VERSION',
    'proposed-version-unresolved': 'PROPOSED VERSION UNRESOLVED',
    'contract-unidentified': 'CONTRACT UNIDENTIFIED',
    'deployment-record-ambiguous': 'DEPLOYMENT RECORD AMBIGUOUS',
    'unrecognised-cut-action': 'UNRECOGNISED CUT ACTION',
    'calldata-not-readable': 'CUT NOT READABLE',
    'pinned-state-unavailable': 'EXPECTED STATE UNAVAILABLE',
  }

  const ordered = [
    ...verdict.findings.filter(
      (f) => !STATUSES_CLEARED_TO_PROCEED.has(f.status)
    ),
    ...verdict.findings.filter((f) =>
      STATUSES_CLEARED_TO_PROCEED.has(f.status)
    ),
  ]

  return [
    `    Expected state:  read from ${PINNED_REF}:${TARGET_STATE_REPO_PATH} (this checkout is not consulted)`,
    ...ordered.map((finding) => {
      const who = finding.contractName ?? finding.facetAddress ?? 'proposal'
      const fleet =
        finding.crossFleetCount === null
          ? ''
          : ` [${finding.crossFleetCount} network(s) declare this contract]`
      return `      ${label[finding.status]} — ${who}: ${
        finding.detail
      }${fleet}`
    }),
  ]
}

/**
 * A refusing verdict for a check that could not run at all.
 *
 * An evaluation that throws must not read as "nothing to report" — the caller
 * has no verdict, and no verdict is not a pass.
 * @param message - what went wrong, shown to the signer
 * @returns A verdict whose single finding is not cleared to proceed
 */
export const blockedByEvaluationError = (
  message: string
): ITargetStateVerdict => ({
  cleared: false,
  findings: [
    {
      status: 'pinned-state-unavailable',
      facetAddress: null,
      contractName: null,
      proposedVersion: null,
      mainVersion: null,
      crossFleetCount: null,
      detail: `the target-state check could not be evaluated: ${message}`,
    },
  ],
})
