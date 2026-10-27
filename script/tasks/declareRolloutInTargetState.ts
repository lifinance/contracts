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

import { readFileSync, writeFileSync } from 'node:fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  baseSemanticVersion,
  compareSemanticVersions,
  TARGET_STATE_REPO_PATH,
  TARGET_STATE_VERSION_LATEST,
  type PinnedTargetState,
} from '../deploy/safe/pinned-target-state'
import { isEntrypoint } from '../utils/is-entrypoint'

const ENVIRONMENT = 'production'
const DIAMOND = 'LiFiDiamond'

export type RolloutDeclaration =
  | 'added'
  | 'already-latest'
  | 'pin-matches'
  | 'unpinned'
  | 'pin-conflict'
  | 'network-not-declared'

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

const BLOCKING: ReadonlySet<RolloutDeclaration> = new Set([
  'pin-conflict',
  'network-not-declared',
])

/**
 * Grades and applies one rollout against the target state, mutating `state` in place.
 * @param state - parsed `_targetState.json`
 * @param options - the executed contract, its version and the networks it reached
 * @returns One result per network; a blocking outcome means `state` must not be written
 */
export const declareRollout = (
  state: PinnedTargetState,
  options: IDeclareRolloutOptions
): IRolloutDeclarationResult[] =>
  options.networks.map((network) => {
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
  })

/**
 * Whether any result forbids writing the file.
 * @param results - output of {@link declareRollout}
 * @returns True when at least one network needs a human decision first
 */
export const hasBlockingResult = (
  results: readonly IRolloutDeclarationResult[]
): boolean => results.some((result) => BLOCKING.has(result.outcome))

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
  run({ args }) {
    if (compareSemanticVersions(args.version, args.version) === null) {
      consola.error(
        `--version "${args.version}" is not MAJOR.MINOR.PATCH (a build suffix such as -tron is allowed)`
      )
      process.exitCode = 1
      return
    }
    const networks = args.networks
      .split(',')
      .map((network) => network.trim().toLowerCase())
      .filter((network) => network.length > 0)
    if (networks.length === 0) {
      consola.error('--networks is empty')
      process.exitCode = 1
      return
    }

    const state = JSON.parse(
      readFileSync(TARGET_STATE_REPO_PATH, 'utf8')
    ) as PinnedTargetState
    const results = declareRollout(state, {
      contract: args.contract,
      version: args.version,
      networks,
      unpin: args.unpin,
    })
    for (const result of results)
      consola.log(`${result.network}: ${result.outcome} — ${result.detail}`)

    if (hasBlockingResult(results)) {
      consola.error(
        `${TARGET_STATE_REPO_PATH} left unchanged — resolve the networks above and re-run.`
      )
      process.exitCode = 1
      return
    }
    if (
      !results.some(
        (result) => result.outcome === 'added' || result.outcome === 'unpinned'
      )
    ) {
      consola.success(
        `${TARGET_STATE_REPO_PATH} already declares the rollout — no change`
      )
      return
    }
    writeFileSync(TARGET_STATE_REPO_PATH, `${JSON.stringify(state, null, 2)}\n`)
    consola.success(`${TARGET_STATE_REPO_PATH} updated`)
  },
})

if (isEntrypoint(import.meta.url)) runMain(main)
