/**
 * Declares an executed production rollout in `_targetState.json` (EXSC-1257).
 *
 * Run by `/finish-rollout` once every timelock op of the rollout has executed, so the
 * entry lands on the rollout PR and merges after execution — the order the sign-time
 * gate's `not-previously-targeted` grading relies on.
 *
 *   bunx tsx script/tasks/declareRolloutInTargetState.ts \
 *     --contract <Name> --version <x.y.z> --networks <csv> [--unpin]
 *
 * Writes nothing unless every network resolves cleanly.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  baseSemanticVersion,
  compareSemanticVersions,
  CONTRACT_NAME_RE,
  createPinnedAnchor,
  describeTargetStateUnavailable,
  PINNED_REF,
  TARGET_STATE_REPO_PATH,
  TARGET_STATE_VERSION_LATEST,
  type PinnedAnchor,
  type PinnedTargetState,
} from '../deploy/safe/pinned-target-state'
import { isEntrypoint } from '../utils/is-entrypoint'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const ENVIRONMENT = 'production'
const DIAMOND = 'LiFiDiamond'

export type RolloutDeclaration =
  | 'added'
  | 'already-latest'
  | 'pin-matches'
  | 'unpinned'
  | 'pin-conflict'
  | 'network-not-declared'
  | 'not-in-diamond-log'

export interface IRolloutDeclarationResult {
  network: string
  outcome: RolloutDeclaration
  detail: string
}

export interface IDeclareRolloutOptions {
  contract: string
  version: string
  networks: readonly string[]
  unpin: boolean
}

export interface IDeclareRolloutArgs {
  contract: string
  version: string
  networks: string
  unpin: boolean
}

export interface IDeclareRolloutDeps {
  repoRoot: string
  /** Why this branch cannot be trusted to carry main's target state, or null when it can. */
  findMissingMain: () => Promise<string | null>
}

const BLOCKING: ReadonlySet<RolloutDeclaration> = new Set([
  'pin-conflict',
  'network-not-declared',
  'not-in-diamond-log',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Repo-relative path of a network's production diamond log.
 * @param network - network name (e.g. optimism)
 * @returns The path `updateDiamondLogs.sh` regenerates for that network
 */
export const diamondLogPath = (network: string): string =>
  `deployments/${network}.diamond.json`

/**
 * Says how a regenerated diamond log fails to show the executed contract.
 *
 * Facets are matched by name and base version; periphery entries carry no version,
 * so a periphery contract is matched by name alone.
 * @param log - parsed `<network>.diamond.json`, or undefined when it could not be read
 * @param contract - the executed contract
 * @param version - the executed version
 * @returns What is missing, or null when the log shows the contract at that version
 */
export const describeDiamondLogGap = (
  log: unknown,
  contract: string,
  version: string
): string | null => {
  if (log === undefined) return 'could not be read'
  const diamond = isRecord(log) ? log[DIAMOND] : undefined
  if (!isRecord(diamond)) return `has no ${DIAMOND} block`
  if (isRecord(diamond.Periphery) && contract in diamond.Periphery) return null

  const facets = isRecord(diamond.Facets) ? Object.values(diamond.Facets) : []
  const versions = facets.flatMap((facet) =>
    isRecord(facet) && facet.Name === contract ? [String(facet.Version)] : []
  )
  if (versions.length === 0) return `does not list ${contract}`
  const executed = baseSemanticVersion(version)
  if (versions.some((listed) => baseSemanticVersion(listed) === executed))
    return null
  return `lists ${contract} at ${versions.join(', ')}, not ${version}`
}

const gradeNetwork = (
  state: PinnedTargetState,
  options: IDeclareRolloutOptions,
  network: string,
  diamondLog: unknown
): IRolloutDeclarationResult => {
  const gap = describeDiamondLogGap(
    diamondLog,
    options.contract,
    options.version
  )
  if (gap)
    return {
      network,
      outcome: 'not-in-diamond-log',
      detail: `${diamondLogPath(
        network
      )} ${gap} — regenerate it with updateDiamondLogs.sh, or drop ${network} from --networks if the cut did not reach it.`,
    }

  const entries = state[network]?.[ENVIRONMENT]?.[DIAMOND]
  if (!entries)
    return {
      network,
      outcome: 'network-not-declared',
      detail: `${network} has no ${ENVIRONMENT}.${DIAMOND} block — seed the network first (/add-network), then re-run.`,
    }

  const declared = entries[options.contract]
  if (typeof declared !== 'string') {
    entries[options.contract] = TARGET_STATE_VERSION_LATEST
    return {
      network,
      outcome: 'added',
      detail: `added ${options.contract}: "${TARGET_STATE_VERSION_LATEST}"`,
    }
  }
  if (declared === TARGET_STATE_VERSION_LATEST)
    return { network, outcome: 'already-latest', detail: 'no change' }
  if (baseSemanticVersion(declared) === baseSemanticVersion(options.version))
    return {
      network,
      outcome: 'pin-matches',
      detail: `pinned at ${declared}, matches the executed version — no change`,
    }
  if (options.unpin) {
    entries[options.contract] = TARGET_STATE_VERSION_LATEST
    return {
      network,
      outcome: 'unpinned',
      detail: `pin ${declared} replaced with "${TARGET_STATE_VERSION_LATEST}"`,
    }
  }
  return {
    network,
    outcome: 'pin-conflict',
    detail: `pinned at ${declared} but ${options.version} executed — re-run with --unpin if the hold-back is over, or fix the pin by hand`,
  }
}

/**
 * Grades and applies one rollout against the target state, mutating `state` in place.
 * @param state - parsed `_targetState.json`
 * @param options - the executed contract, its version and the networks it reached
 * @param readDiamondLog - parsed `<network>.diamond.json`, or undefined when unreadable
 * @returns One result per network; a blocking outcome means `state` must not be written
 */
export const declareRollout = (
  state: PinnedTargetState,
  options: IDeclareRolloutOptions,
  readDiamondLog: (network: string) => unknown
): IRolloutDeclarationResult[] =>
  options.networks.map((network) =>
    gradeNetwork(state, options, network, readDiamondLog(network))
  )

/**
 * Whether any result forbids writing the file.
 * @param results - output of {@link declareRollout}
 * @returns True when at least one network needs a human decision first
 */
export const hasBlockingResult = (
  results: readonly IRolloutDeclarationResult[]
): boolean => results.some((result) => BLOCKING.has(result.outcome))

/**
 * Checks that the branch carries main's current target state.
 *
 * The rollout PR may have branched before main seeded a network or pinned one, and
 * `gh pr checkout` does not merge main — grading against that copy would refuse a
 * network main declares, or add `"latest"` over a pin main holds.
 * @param repoRoot - the clone whose HEAD is checked
 * @param anchor - the fetched `origin/main` commit; defaults to this clone's
 * @returns Why HEAD does not contain `origin/main`, or null when it does
 */
export const findMissingMain = async (
  repoRoot: string,
  anchor: PinnedAnchor = createPinnedAnchor({ repoRoot })
): Promise<string | null> => {
  const anchored = await anchor()
  if (!anchored.ok) return describeTargetStateUnavailable(anchored.reason)

  const check = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', anchored.revision, 'HEAD'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (check.status === 0) return null
  if (check.status === 1)
    return `this branch does not contain ${PINNED_REF} (${anchored.revision.slice(
      0,
      12
    )}), so its ${TARGET_STATE_REPO_PATH} can miss a network or pin main already has. Run \`git merge origin/main\`, resolve any conflict, then re-run.`
  return `could not compare HEAD with ${PINNED_REF}: ${(
    check.stderr || String(check.error)
  ).trim()}`
}

const parseArgs = (
  args: IDeclareRolloutArgs
): IDeclareRolloutOptions | string => {
  if (!CONTRACT_NAME_RE.test(args.contract))
    return `--contract "${args.contract}" is not a Solidity contract name`
  if (compareSemanticVersions(args.version, args.version) === null)
    return `--version "${args.version}" is not MAJOR.MINOR.PATCH (a build suffix such as -tron is allowed)`
  const networks = args.networks
    .split(',')
    .map((network) => network.trim().toLowerCase())
    .filter((network) => network.length > 0)
  if (networks.length === 0) return '--networks is empty'
  return { ...args, networks }
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const writeIfChanged = (
  statePath: string,
  state: PinnedTargetState,
  results: readonly IRolloutDeclarationResult[]
): void => {
  const changed = results.some(
    (result) => result.outcome === 'added' || result.outcome === 'unpinned'
  )
  if (!changed) {
    consola.success(
      `${TARGET_STATE_REPO_PATH} already declares the rollout — no change`
    )
    return
  }
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
  consola.success(`${TARGET_STATE_REPO_PATH} updated`)
}

/**
 * Validates the arguments, grades every network and writes the target state.
 * @param args - raw CLI arguments
 * @param deps - repository root and the main-ancestry check
 * @returns True when the run succeeded (written or already declared)
 */
export const runDeclareRollout = async (
  args: IDeclareRolloutArgs,
  deps: IDeclareRolloutDeps
): Promise<boolean> => {
  const options = parseArgs(args)
  if (typeof options === 'string') {
    consola.error(options)
    return false
  }
  const missingMain = await deps.findMissingMain()
  if (missingMain) {
    consola.error(missingMain)
    return false
  }

  const statePath = join(deps.repoRoot, TARGET_STATE_REPO_PATH)
  const parsed = readJson(statePath)
  if (!isRecord(parsed)) {
    consola.error(
      `${TARGET_STATE_REPO_PATH} could not be read as a JSON object — restore it from ${PINNED_REF} and re-run.`
    )
    return false
  }
  const state = parsed as PinnedTargetState
  const results = declareRollout(state, options, (network) =>
    readJson(join(deps.repoRoot, diamondLogPath(network)))
  )
  for (const result of results)
    consola.log(`${result.network}: ${result.outcome} — ${result.detail}`)

  if (hasBlockingResult(results)) {
    consola.error(
      `${TARGET_STATE_REPO_PATH} left unchanged — resolve the networks above and re-run.`
    )
    return false
  }
  writeIfChanged(statePath, state, results)
  return true
}

const main = defineCommand({
  meta: {
    name: 'declare-rollout-in-target-state',
    description:
      'Add or update the production _targetState.json entry for an executed rollout',
  },
  args: {
    contract: {
      type: 'string',
      description: 'Contract rolled out (e.g. AcrossFacetV4)',
      required: true,
    },
    version: {
      type: 'string',
      description: 'Version the rollout executed (e.g. 1.2.0)',
      required: true,
    },
    networks: {
      type: 'string',
      description: 'Comma-separated networks whose cut executed',
      required: true,
    },
    unpin: {
      type: 'boolean',
      description:
        'Replace a pin that differs from the executed version with "latest"',
      default: false,
    },
  },
  async run({ args }) {
    const ok = await runDeclareRollout(args, {
      repoRoot: REPO_ROOT,
      findMissingMain: () => findMissingMain(REPO_ROOT),
    })
    if (!ok) process.exitCode = 1
  },
})

if (isEntrypoint(import.meta.url)) runMain(main)
