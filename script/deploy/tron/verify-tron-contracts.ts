#!/usr/bin/env -S bunx tsx
/**
 * Verify deployed Tron contracts on TronScan via its (undocumented) HTTP
 * verification endpoint, replacing the manual browser upload at
 * https://tronscan.org/contracts/verify.
 *
 * TronScan exposes no official verification API and `forge verify-contract`
 * cannot target Tron, so this replays the multipart request the verify form
 * submits: a single flattened source file plus compiler settings. For each
 * address in `deployments/<network>.json`, the matching contract is flattened
 * on the fly with `forge flatten` (into a temp file that is deleted after use),
 * then submitted — or a pre-flattened directory can be supplied via
 * `--flattened-dir`.
 *
 * IMPORTANT: the source must correspond to the commit each contract was
 * deployed from. LI.FI's Tron deploys come from the `contracts-tron` fork
 * (which carries Tron-specific library deltas), so point `--repo-root` at that
 * checkout — flattening from a drifted `main` fails with a bytecode mismatch
 * even when the compiler settings are correct.
 *
 * Use when contracts on `tron`/`tronshasta` show as unverified on TronScan.
 */
import { readFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { sleep } from '../../utils/delay'
import { redactUrls } from '../../utils/redactUrls'
import { executeShellCommand } from '../../utils/utils'
import { flagIsOn } from '../safe/cli-flags'

import {
  assertSafePathSegment,
  flattenContractSource,
  resolveFlattenedPath,
  verifyContractOnTronscan,
  type IVerifyParams,
} from './helpers/tronscanVerify'

/**
 * Contracts already verified on TronScan by other means before this CLI existed,
 * whose source is not reliably reproducible from the current fork checkout — so
 * skipped by default (override with --only). Contracts verified *through* this
 * tool do NOT belong here: TronScan returns an "already verified" success that
 * the response parser handles, so re-running them is harmless.
 *
 * Being skipped, these never reach the record-flagging below, so their records
 * keep whatever `verified` they were last given — nothing else on the Tron path
 * writes that flag. Clearing that residue is a one-off `mark-verified` per
 * contract, not something a run will do on its own; see
 * docs/DeploymentLogs.md#flagging-a-record-as-explorer-verified.
 */
const ALREADY_VERIFIED = new Set(['AccessManagerFacet', 'LiFiDiamond'])

/**
 * Flags the deployment record as verified after a successful submission.
 *
 * TronScan and the deployment record are separate systems, so verifying here
 * otherwise leaves the record saying `verified: false` forever — nothing else
 * on the Tron path writes that flag, unlike the EVM path where
 * `deploySingleContract.sh` sets it inline.
 *
 * A failure is reported rather than thrown: the contract is verified on the
 * explorer either way, so the remaining contracts should still be submitted.
 * The caller collects the failures and the run ends non-zero, because a flag
 * nobody notices is a record that stays `verified: false` for good.
 *
 * @param contractName - Contract whose record to flag
 * @param network - Network key the record is filed under
 * @param address - Address just verified, spelled as the record spells it
 * @param environment - `production` or `staging`
 * @returns Whether the record was flagged
 */
async function markVerifiedInDeploymentLog(
  contractName: string,
  network: string,
  address: string,
  environment: string
): Promise<boolean> {
  const escapeShellArg = (arg: string) => `'${arg.replace(/'/g, "'\"'\"'")}'`
  try {
    await executeShellCommand(
      [
        'bunx tsx script/deploy/update-deployment-logs.ts mark-verified',
        `--env ${escapeShellArg(environment)}`,
        `--contract ${escapeShellArg(contractName)}`,
        `--network ${escapeShellArg(network)}`,
        `--address ${escapeShellArg(address)}`,
      ].join(' ')
    )
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    consola.warn(
      `${contractName}: verified on TronScan, but the deployment record was not flagged — ${redactUrls(
        message
      )}`
    )
    return false
  }
}

/**
 * Compiler settings used for the current Tron deployments. Defaults submitted
 * with every request, overridable via CLI flags. Sourced from the deployment
 * toolchain, NOT `config/networks.json` (whose `deployedWith*` values are stale
 * for Tron).
 */
const DEFAULT_COMPILER = 'v0.8.29+commit.ab55807c'
const DEFAULT_OPTIMIZER_RUNS = 1_000_000
const DEFAULT_VIA_IR = false
const DEFAULT_REPO_ROOT = '.'

/**
 * TronScan license enum (SPDX dropdown, Etherscan-compatible ordering).
 * LI.FI contracts are LGPL-3.0-only → GNU LGPLv3 = 7. License is metadata only
 * and does not affect bytecode matching.
 */
const DEFAULT_LICENSE = 7

/** Delay between submissions to stay friendly to the public TronScan API. */
const DELAY_BETWEEN_MS = 3_000

interface INetworkConfig {
  explorerApiUrl: string
}

interface IVerifyOutcome {
  contractName: string
  address: string
  ok: boolean
  message: string
}

const main = defineCommand({
  meta: {
    name: 'verify-tron-contracts',
    description: 'Verify deployed Tron contracts on TronScan',
  },
  args: {
    network: {
      type: 'string',
      description: 'Tron network key in config/networks.json',
      default: 'tron',
    },
    'repo-root': {
      type: 'string',
      description:
        'Checkout to flatten sources from (point at the contracts-tron fork; default: the current directory)',
    },
    'flattened-dir': {
      type: 'string',
      description:
        'Use pre-flattened <Contract>.sol sources from here instead of auto-flattening',
    },
    only: {
      type: 'string',
      description: 'Comma-separated contract names to verify (default: all)',
    },
    skip: {
      type: 'string',
      description: 'Comma-separated contract names to skip',
    },
    compiler: { type: 'string', default: DEFAULT_COMPILER },
    'optimizer-runs': {
      type: 'string',
      description: `Optimizer runs the sources were compiled with (default: ${DEFAULT_OPTIMIZER_RUNS})`,
    },
    'via-ir': { type: 'boolean' },
    license: { type: 'string', default: String(DEFAULT_LICENSE) },
    'dry-run': {
      type: 'boolean',
      description: 'Print planned requests without submitting',
    },
  },
  async run({ args }) {
    const network = args.network
    const repoRoot = args['repo-root'] ?? DEFAULT_REPO_ROOT
    const flattenedDir = args['flattened-dir']
    const optimizerRuns = Number(
      args['optimizer-runs'] ?? DEFAULT_OPTIMIZER_RUNS
    )
    const license = Number(args.license)
    const viaIR = flagIsOn(args['via-ir'], { whenAbsent: DEFAULT_VIA_IR })
    const dryRun = flagIsOn(args['dry-run'])

    if (Number.isNaN(optimizerRuns))
      throw new Error(
        `--optimizer-runs must be a number (got "${args['optimizer-runs']}")`
      )
    if (Number.isNaN(license))
      throw new Error(`--license must be a number (got "${args.license}")`)

    assertSafePathSegment(network, 'network')
    const networks = JSON.parse(
      readFileSync('config/networks.json', 'utf8')
    ) as Record<string, INetworkConfig>
    const netCfg = networks[network]
    if (!netCfg?.explorerApiUrl)
      throw new Error(`No explorerApiUrl for network "${network}"`)

    const deployments = JSON.parse(
      readFileSync(`deployments/${network}.json`, 'utf8')
    ) as Record<string, string>

    // Tied to the log read above rather than to the network or to the
    // environment variable the rest of the Tron tooling reads:
    // `deployments/<network>.json` is the production log for every network,
    // testnets included — staging lives in `<network>.staging.json` — so the
    // records to flag are always the production ones.
    const environment = 'production'

    const onlySet = args.only
      ? new Set(args.only.split(',').map((s) => s.trim()))
      : undefined
    // An explicit --only list is a deliberate request, so it overrides the
    // default "already verified" skips (still honouring an explicit --skip).
    const skipSet = new Set([
      ...(onlySet ? [] : ALREADY_VERIFIED),
      ...(args.skip ? args.skip.split(',').map((s) => s.trim()) : []),
    ])

    const outcomes: IVerifyOutcome[] = []
    const missing: string[] = []
    const unflagged: string[] = []

    for (const [contractName, address] of Object.entries(deployments)) {
      if (onlySet && !onlySet.has(contractName)) continue
      if (skipSet.has(contractName)) {
        consola.info(`skip ${contractName} (already verified / excluded)`)
        continue
      }

      assertSafePathSegment(contractName, 'contract name')

      // Source either comes pre-flattened from --flattened-dir, or we flatten
      // it on the fly from --repo-root (the default, deleting the temp file).
      let source: string
      try {
        if (flattenedDir) {
          const flattenedPath = resolveFlattenedPath(flattenedDir, contractName)
          if (!flattenedPath) {
            consola.warn(`no flattened source for ${contractName} — skipping`)
            missing.push(contractName)
            continue
          }
          source = readFileSync(flattenedPath, 'utf8')
        } else {
          source = await flattenContractSource(repoRoot, contractName)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        consola.warn(`${contractName}: ${message} — skipping`)
        missing.push(contractName)
        continue
      }

      const params: IVerifyParams = {
        explorerApiUrl: netCfg.explorerApiUrl,
        contractName,
        address,
        source,
        fileName: `${contractName}.sol`,
        compiler: args.compiler,
        optimizerRuns,
        viaIR,
        license,
      }

      if (dryRun) {
        consola.box(
          `${contractName} @ ${address}\n` +
            `  source: ${source.length} bytes  compiler: ${params.compiler}\n` +
            `  runs: ${optimizerRuns}  viaIR: ${viaIR}  license: ${license}`
        )
        continue
      }

      consola.start(`verifying ${contractName} @ ${address}`)
      try {
        const { ok, message } = await verifyContractOnTronscan(params)
        outcomes.push({ contractName, address, ok, message })
        if (ok) {
          consola.success(`${contractName}: ${message}`)
          const flagged = await markVerifiedInDeploymentLog(
            contractName,
            network,
            address,
            environment
          )
          if (!flagged) unflagged.push(contractName)
        } else consola.error(`${contractName}: ${message}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        outcomes.push({ contractName, address, ok: false, message })
        consola.error(`${contractName}: ${message}`)
      }

      await sleep(DELAY_BETWEEN_MS)
    }

    if (dryRun) return

    const verified = outcomes.filter((o) => o.ok)
    const failed = outcomes.filter((o) => !o.ok)
    consola.box(
      `Verified: ${verified.length}  Failed: ${failed.length}  ` +
        `Unflagged: ${unflagged.length}  Skipped: ${missing.length}`
    )
    if (failed.length)
      consola.warn(`Failed: ${failed.map((f) => f.contractName).join(', ')}`)
    if (missing.length)
      consola.warn(`Skipped (no source / flatten error): ${missing.join(', ')}`)
    if (unflagged.length)
      consola.warn(
        `Verified on TronScan but still unflagged in the deployment log: ` +
          `${unflagged.join(', ')}. Re-run this command once MongoDB is ` +
          `reachable, or flag each one with: bunx tsx ` +
          `script/deploy/update-deployment-logs.ts mark-verified --env ` +
          `${environment} --contract <name> --network ${network} --address <address>`
      )
    // Unflagged records exit non-zero too: nothing else on the Tron path writes
    // that flag, so a green run is the last chance anyone looks.
    if (failed.length || unflagged.length) process.exit(1)
  },
})

runMain(main)
