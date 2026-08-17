#!/usr/bin/env bun

/**
 * Purpose:
 *   - Remove facet(s) or unregister periphery contract(s) from the LiFiDiamond contract
 *   - Supports both interactive and headless CLI modes
 *   - Production with SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=false: proposes to Safe with timelock wrapping
 *   - SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true or staging: sends transaction directly to diamond (no proposal, no timelock)
 *
 * Usage without parameters:
 *  bun script/tasks/cleanUpProdDiamond.ts
 *
 * Usage (Facet Removal by name — resolved through the deploy log):
 *   bun script/tasks/cleanUpProdDiamond.ts --network mainnet --environment production --facets '["FacetA","FacetB"]'
 *
 * Usage (Facet Removal by address — the only way to target one of two
 * co-registered versions of the same facet):
 *   bun script/tasks/cleanUpProdDiamond.ts --network mainnet --environment production --facetAddresses '["0xAbC..."]'
 *
 * Usage (Periphery Removal):
 *   bun script/tasks/cleanUpProdDiamond.ts --network mainnet --environment production --periphery '["Executor","FeeCollector"]'
 */

import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress } from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../common/types'
import {
  computeFacetRemovalDiff,
  computeFacetRemovalsByName,
  computeTargetedFacetRemovals,
  type IFacetRemoval,
  type IRemovalDiff,
  type IRemovalTarget,
  type ITargetedRemovalResult,
} from '../deploy/safe/diamondRemovalDiff'
import { wrapWithTimelockSchedule } from '../deploy/safe/safe-utils'
import { sendOrPropose } from '../safe/safeScriptHelpers'
import {
  buildDiamondCutRemoveCalldata,
  buildUnregisterPeripheryCalldata,
  castEnv,
  getAllActiveNetworks,
  getContractAddressForNetwork,
  isTestnetNetwork,
  multiselectWithSearch,
  selectWithSearch,
} from '../utils/viemScriptHelpers'

/**
 * Wraps calldata in a timelock schedule call when proposing to Safe.
 * Direct-send paths (staging, testnet, SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true)
 * return the original calldata unchanged.
 * @param originalCalldata - The original calldata to wrap
 * @param diamondAddress - The diamond address (target for the scheduled call)
 * @param network - The network name
 * @param environment - The environment (staging/production)
 * @returns Object with target address and final calldata
 */
async function prepareTimelockCalldata(
  originalCalldata: `0x${string}`,
  diamondAddress: string,
  network: string,
  environment: EnvironmentEnum
): Promise<{ targetAddress: string; calldata: `0x${string}` }> {
  const sendDirectly = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true'
  const isTestnet = isTestnetNetwork(network)

  // Determine which option will be chosen
  if (environment === EnvironmentEnum.staging || sendDirectly || isTestnet) {
    const reason = isTestnet
      ? 'testnet (EOA-owned diamond, no Safe/Timelock)'
      : 'staging or SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true'
    consola.info(`🔧 Option chosen: Send directly to diamond (${reason})`)
    consola.info('📤 Final calldata (direct to diamond):')
    consola.info(originalCalldata)
    return {
      targetAddress: diamondAddress,
      calldata: originalCalldata,
    }
  }

  // Production: always wrap in timelock schedule.
  consola.info('🔧 Option chosen: Propose to Safe with timelock wrapping')

  const timelockAddress = await getContractAddressForNetwork(
    'LiFiTimelockController',
    network as SupportedChain,
    EnvironmentEnum.production // Timelock is always in production deployments
  )
  if (!timelockAddress || timelockAddress === '0x')
    throw new Error(
      `LiFiTimelockController not found in deployment logs for ${network}`
    )

  consola.info(
    `⏰ Using timelock controller at ${timelockAddress} for operation`
  )

  const wrappedTransaction = await wrapWithTimelockSchedule(
    network,
    '', // rpcUrl will fall back to chain.rpcUrls.default.http[0] in wrapWithTimelockSchedule
    timelockAddress as `0x${string}`,
    [diamondAddress as `0x${string}`],
    [originalCalldata]
  )

  return {
    targetAddress: wrappedTransaction.targetAddress,
    calldata: wrappedTransaction.calldata,
  }
}

/**
 * Displays environment configuration and determines execution mode
 * @param environment - The environment string
 * @param network - The network name (used to detect testnet)
 * @returns The execution mode string
 */
function displayEnvironmentConfiguration(
  environment: string,
  network: string
): string {
  const isTestnet = isTestnetNetwork(network)

  // Show environment variables and decision logic
  consola.log('\n🔧 Environment Configuration:')
  consola.log(`   Environment: ${environment}`)
  consola.log(`   Network: ${network} (${isTestnet ? 'testnet' : 'mainnet'})`)
  consola.log(
    `   SEND_PROPOSALS_DIRECTLY_TO_DIAMOND: ${
      process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND || 'false'
    }`
  )

  // Determine which option will be chosen
  const sendDirectly = process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true'

  let executionMode = ''
  if (isTestnet)
    executionMode =
      'Send directly to diamond (testnet — EOA-owned, no Safe/Timelock)'
  else if (environment === 'staging' || sendDirectly)
    executionMode =
      'Send directly to diamond (staging or SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true)'
  else executionMode = 'Propose to Safe with timelock wrapping (production)'

  consola.log(`   Execution Mode: ${executionMode}`)

  return executionMode
}

const command = defineCommand({
  meta: {
    name: 'Clean Up Production Diamonds',
    description: 'Removes facet(s) or periphery contract(s) from LiFiDiamond',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network (e.g. arbitrum, polygon, mainnet)',
    },
    environment: {
      type: 'string',
      description: 'Environment (staging | production)',
    },
    facets: {
      type: 'string',
      description:
        'JSON array of facet names (e.g. ["FacetA","FacetB"]); resolved via the deploy log, so it cannot target an older co-registered version — use --facetAddresses for that',
    },
    facetAddresses: {
      type: 'string',
      description:
        'JSON array of facet addresses to remove (e.g. ["0xAbC…"]) — unambiguous even when two versions of a facet are registered on the same diamond',
    },
    periphery: {
      type: 'string',
      description:
        'JSON array of periphery contract names (e.g. ["Executor","Receiver"])',
    },
    auto: {
      type: 'boolean',
      description:
        'Auto-detect stale facets (on-chain loupe ∖ _targetState.json) for the given --network and propose their removal',
    },
    allNetworks: {
      type: 'boolean',
      description:
        'Fleet sweep: run auto-detection across every active network (implies --auto)',
    },
    yes: {
      type: 'boolean',
      description:
        'Skip confirmation and actually propose/send. Without it: auto/sweep modes dry-run; headless --facets / --facetAddresses in a non-TTY exits non-zero (cannot confirm)',
    },
  },

  async run({ args }) {
    const { facets, facetAddresses, periphery, auto, allNetworks, yes } = args
    let { network, environment } = args
    const diamondName = 'LiFiDiamond'
    let calldata: `0x${string}`

    // --auto (target-state diff), --facets (names via the deploy log) and
    // --facetAddresses (addresses) drive different resolutions of the same
    // removal engine; refuse an ambiguous combination instead of letting one win.
    const selectionFlags = [
      auto && '--auto',
      facets && '--facets',
      facetAddresses && '--facetAddresses',
    ].filter(Boolean)
    if (selectionFlags.length > 1) {
      consola.error(`${selectionFlags.join(', ')} are mutually exclusive`)
      process.exit(1)
    }

    const selection: RemovalSelection | undefined = facetAddresses
      ? { kind: 'addresses', targets: parseFacetAddresses(facetAddresses) }
      : facets
      ? { kind: 'names', names: parseFacetNames(facets) }
      : undefined

    // ---------------- FLEET removals across all networks ----------------
    if (allNetworks) {
      if (!environment)
        environment = await selectWithSearch('Select environment', [
          'production',
          'staging',
        ])
      const env = castEnv(environment)
      if (selection)
        // Explicitly requested fleet removal (the deprecation-driven path).
        await runExplicitFleetRemoval(env, selection, Boolean(yes))
      // Nothing named → target-state-diff sweep (--all-networks implies --auto):
      // the backstop for orphans nobody named.
      else await runFleetRemoval(env, Boolean(yes))
      return
    }

    // select network (if not provided via parameter)
    if (!network) {
      const options = getAllActiveNetworks().map((n) => n.id)
      network = await selectWithSearch('Select network', options)
      consola.info(`Network selected: ${network}`)
    }

    // select environment (if not provided via parameter)
    if (!environment) {
      environment = await selectWithSearch('Select environment', [
        'production',
        'staging',
      ])
      consola.info(`Environment selected: ${environment}`)
    }

    const typedEnv = castEnv(environment)

    // ---------------- AUTO: auto-detected removals for a single network ----------------
    // Dry-run unless --yes, matching the fleet sweep and the --yes help text
    // (auto modes never submit without an explicit --yes).
    if (auto) {
      await runAutoRemoval(network, typedEnv, yes ? 'yes' : 'dry-run')
      return
    }

    // get diamond address from deploy log
    const diamondAddress = await getContractAddressForNetwork(
      diamondName,
      network as SupportedChain,
      typedEnv
    )

    if (!diamondAddress) {
      consola.error(`Could not find ${diamondName} in deploy log`)
      process.exit(1)
    }

    // ---------------- HEADLESS: explicit facet removal (single network) ----------------
    // Loupe-driven (not out/-based), so it works after `/deprecate-contract`
    // deletes the facet's source. Dry-run unless --yes (or interactive confirm).
    if (selection) {
      consola.box('Running headless facet removal')
      await runExplicitRemoval(
        network,
        typedEnv,
        selection,
        yes ? 'yes' : 'prompt'
      )
      return
    }

    // ---------------- HEADLESS: Periphery removal ----------------
    if (periphery) {
      consola.box('Running headless periphery removal')
      // parse periphery names into string array
      const names: string[] = JSON.parse(periphery)

      // for each periphery contract, build and send the calldata to remove it from the diamond
      for (const name of names) {
        // create the calldata
        calldata = buildUnregisterPeripheryCalldata(name)

        consola.info(`→ Removing periphery: ${name}`)

        // Show environment variables and decision logic
        displayEnvironmentConfiguration(environment, network)

        // Prepare calldata for timelock if needed
        const { targetAddress, calldata: finalCalldata } =
          await prepareTimelockCalldata(
            calldata,
            diamondAddress,
            network,
            typedEnv
          )

        consola.log('\n📦 Final Calldata:')
        consola.log(finalCalldata)

        // send it
        await sendOrPropose({
          calldata: finalCalldata,
          network,
          environment: typedEnv,
          diamondAddress: targetAddress,
        })
      }
      return
    }

    // ---------------- INTERACTIVE: Ask mode ----------------
    const action = await consola.prompt(
      `What do you want to remove from diamond ${diamondAddress}?`,
      {
        type: 'select',
        options: ['Facet(s)', 'Periphery(s)'],
      }
    )

    // ---------- Facet selection ----------
    if (action === 'Facet(s)') {
      // get a list of all facet names
      const facetDir = path.resolve('src/Facets/')
      const facetNames = fs
        .readdirSync(facetDir)
        .filter((f) => f.endsWith('.sol'))
        .map((f) => f.replace('.sol', ''))
        .sort((a, b) => a.localeCompare(b))

      // select one or more facets
      const selectedFacets = await multiselectWithSearch(
        'Select facets to remove',
        facetNames
      )

      if (!selectedFacets?.length) {
        consola.info('No facets selected – aborting.')
        process.exit(0)
      }

      // Goes through the same loupe-driven engine as the headless paths, so the
      // selectors removed are the ones the diamond currently routes to the
      // selected facet's logged address, and the live-facet guard applies.
      await runExplicitRemoval(
        network,
        typedEnv,
        { kind: 'names', names: selectedFacets },
        'prompt'
      )
      return
    }

    // ---------- Periphery selection ----------
    if (action === 'Periphery(s)') {
      // get a list of all periphery names
      const peripheryDir = path.resolve('src/Periphery/')
      const names = fs
        .readdirSync(peripheryDir)
        .filter((f) => f.endsWith('.sol'))
        .map((f) => f.replace('.sol', ''))

      // select one or more periphery contracts
      const selected = await multiselectWithSearch(
        'Select periphery contracts',
        names
      )

      // go through each contract, build the calldata and send/propose it
      for (const name of selected) {
        const data = buildUnregisterPeripheryCalldata(name)

        // Show environment variables and decision logic before confirmation
        displayEnvironmentConfiguration(environment, network)

        // Prepare calldata for timelock if needed
        const { targetAddress, calldata: finalCalldata } =
          await prepareTimelockCalldata(data, diamondAddress, network, typedEnv)

        consola.log(`\n📦 Final Calldata to unregister: ${name}`)
        consola.log(finalCalldata)

        const confirm = await consola.prompt(`Propose removal of ${name}?`, {
          type: 'confirm',
          initial: true,
        })

        // send/propose it if the user selected yes
        if (confirm)
          await sendOrPropose({
            calldata: finalCalldata,
            network,
            environment: typedEnv,
            diamondAddress: targetAddress,
          })
      }
      return
    }
  },
})

/**
 * Prints the removal diff as a conspicuous banner. Facet removals are
 * irreversible timelock+Safe governance actions, so they are surfaced loudly,
 * alongside held-back selectors, unresolved addresses and any target-state bug.
 */
function printRemovalDiff(diff: IRemovalDiff): void {
  consola.box(
    `⚠️  IRREVERSIBLE FACET REMOVAL — ${diff.network} (${diff.environment})`
  )

  if (diff.removals.length === 0)
    consola.success(`[${diff.network}] no stale facets to remove`)
  else
    for (const r of diff.removals) {
      consola.warn(
        `✗ REMOVE  ${r.name}  @ ${r.address}  (${r.selectors.length} selectors)`
      )
      consola.log(`   selectors: ${r.selectors.join(', ')}`)
    }

  for (const held of diff.heldBackSelectors)
    consola.warn(
      `⏸  HELD BACK ${held.selectors.length} selector(s) of ${
        held.facet
      }: an active facet is expected to own them (re-point, don't remove). ${held.selectors.join(
        ', '
      )}`
    )

  if (diff.driftDetected.length > 0)
    consola.warn(
      `↔️  DRIFT: on-chain & absent from target state but source still exists — NOT removed (target state lags, or deprecate properly first): ${diff.driftDetected.join(
        ', '
      )}`
    )

  if (diff.unresolved.length > 0)
    consola.warn(
      `❓ UNRESOLVED on-chain facet address(es) not in the deploy log — NOT removed, review manually:\n   ${diff.unresolved.join(
        '\n   '
      )}`
    )

  if (diff.targetStateMissingProtected.length > 0)
    consola.error(
      `🛑 TARGET-STATE BUG: protected facet(s) missing from _targetState.json (kept, but fix target state): ${diff.targetStateMissingProtected.join(
        ', '
      )}`
    )
}

/** Parses and validates the `--facets` JSON array argument; exits on malformed input. */
function parseFacetNames(facets: string): string[] {
  try {
    const names = JSON.parse(facets)
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string'))
      throw new Error()
    return names
  } catch {
    consola.error(
      '❌  --facets must be a JSON array of strings, e.g. \'["FacetA","FacetB"]\''
    )
    process.exit(1)
  }
}

/**
 * Parses and validates the `--facetAddresses` JSON array argument into removal
 * targets; exits on malformed input or a non-address entry. Labels stay empty —
 * they are resolved from the deploy log where possible.
 */
function parseFacetAddresses(facetAddresses: string): IRemovalTarget[] {
  let raw: unknown
  try {
    raw = JSON.parse(facetAddresses)
    if (!Array.isArray(raw) || raw.some((a) => typeof a !== 'string'))
      throw new Error()
  } catch {
    consola.error(
      '❌  --facetAddresses must be a JSON array of strings, e.g. \'["0xAbC…"]\''
    )
    process.exit(1)
  }

  return (raw as string[]).map((address) => {
    try {
      return { address: getAddress(address) }
    } catch {
      consola.error(
        `❌  --facetAddresses contains an invalid address: ${address}`
      )
      return process.exit(1)
    }
  })
}

/**
 * Hard governance gate for automated facet removals: on a production mainnet a
 * removal is IRREVERSIBLE and must go through Safe + timelock, so a leftover
 * `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` (which `prepareTimelockCalldata`
 * would honour by broadcasting straight to the diamond) is refused here rather
 * than silently bypassing quorum and the timelock delay. Staging/testnet keep
 * their sanctioned direct-send.
 */
function assertGovernedProductionRemoval(
  network: string,
  environment: EnvironmentEnum
): void {
  if (
    environment === EnvironmentEnum.production &&
    !isTestnetNetwork(network) &&
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true'
  ) {
    consola.error(
      `🛑 SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true on a production removal (${network}). ` +
        'Facet removals are IRREVERSIBLE and must go through Safe + timelock. ' +
        'Unset the variable (or target staging/testnet) and re-run.'
    )
    process.exit(1)
  }
}

/**
 * Builds the removal cut, wraps it for the timelock and proposes/sends it,
 * reusing the existing plumbing. Shared by the auto (diff) and named
 * (deprecation-driven) paths. `confirmMode`: `'yes'` proposes without asking,
 * `'prompt'` asks interactively, `'dry-run'` only prints. A non-TTY `'prompt'`
 * (headless `--facets` without `--yes`) cannot be confirmed, so it exits non-zero
 * rather than silently no-op'ing — the missed removal stays visible to a runbook.
 */
async function proposeRemovals(
  network: string,
  environment: EnvironmentEnum,
  diamondAddress: string,
  removals: IFacetRemoval[],
  confirmMode: 'yes' | 'prompt' | 'dry-run'
): Promise<void> {
  if (removals.length === 0) return

  assertGovernedProductionRemoval(network, environment)

  displayEnvironmentConfiguration(environment, network)

  const removalCalldata = buildDiamondCutRemoveCalldata(removals)
  const { targetAddress, calldata: finalCalldata } =
    await prepareTimelockCalldata(
      removalCalldata,
      diamondAddress,
      network,
      environment
    )

  consola.log('\n📦 Final Calldata:')
  consola.log(finalCalldata)

  // A headless `--facets` run without `--yes` arrives here as `'prompt'`. In a
  // non-TTY there's no one to confirm, so we cannot submit — but silently
  // dry-running (exit 0) would hide a missed removal from a cron/runbook that
  // expected the old auto-submitting `--facets` path. Fail loudly instead.
  if (confirmMode === 'prompt' && !process.stdin.isTTY) {
    consola.error(
      `[${network}] non-interactive shell and no --yes: refusing to silently ` +
        `dry-run a headless facet removal. Re-run with --yes to submit, or in an ` +
        `interactive terminal to confirm.`
    )
    process.exit(1)
  }

  if (confirmMode === 'dry-run') {
    consola.warn(
      `[${network}] dry-run — not proposing. Re-run with --yes to submit (or confirm interactively).`
    )
    return
  }

  if (confirmMode === 'prompt') {
    const confirm = await consola.prompt(
      `Propose removal of ${removals.length} facet(s) on ${network}?`,
      { type: 'confirm', initial: false }
    )
    if (!confirm) {
      consola.info('Aborted.')
      return
    }
  }

  await sendOrPropose({
    calldata: finalCalldata,
    network,
    environment,
    diamondAddress: targetAddress,
  })
  consola.success(`[${network}] removal proposal submitted`)
}

/**
 * Auto-detects stale facets for one network via the target-state diff engine and
 * proposes their removal. `confirmMode` is forwarded to {@link proposeRemovals}.
 */
async function runAutoRemoval(
  network: string,
  environment: EnvironmentEnum,
  confirmMode: 'yes' | 'prompt' | 'dry-run'
): Promise<void> {
  const diff = await computeFacetRemovalDiff(network, environment)

  if (!diff.diamondAddress) {
    consola.info(
      `[${network}] no LiFiDiamond in ${environment} deploy log — skipping`
    )
    return
  }

  printRemovalDiff(diff)
  await proposeRemovals(
    network,
    environment,
    diff.diamondAddress,
    diff.removals,
    confirmMode
  )
}

/**
 * Exits the process non-zero when a fleet sweep left any network unprocessed, so
 * a partial sweep surfaces as a failed CI check / non-zero shell status instead
 * of a green "done". No-op when every network succeeded.
 */
function exitOnFleetFailures(failed: string[]): void {
  if (failed.length === 0) return
  consola.error(
    `Fleet sweep completed with ${failed.length} failure(s): ${failed.join(
      ', '
    )}. Re-run the failed network(s) individually.`
  )
  process.exit(1)
}

/**
 * Runs {@link runAutoRemoval} across every active network sequentially (per-network
 * Safe proposals must not race on nonces). Without `yes` the whole sweep is a
 * dry-run that only prints per-network diffs. Per-network failures are collected
 * so survivors still run; the sweep then exits non-zero so a partial failure
 * (networks that got no proposal) is never reported as success.
 */
async function runFleetRemoval(
  environment: EnvironmentEnum,
  yes: boolean
): Promise<void> {
  const networkIds = getAllActiveNetworks().map((n) => n.id)
  consola.box(
    `Fleet facet-removal sweep — ${
      networkIds.length
    } networks (${environment})${yes ? '' : ' [DRY RUN]'}`
  )

  const failed: string[] = []
  for (const network of networkIds)
    try {
      await runAutoRemoval(network, environment, yes ? 'yes' : 'dry-run')
    } catch (err) {
      failed.push(network)
      consola.error(
        `[${network}] failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

  exitOnFleetFailures(failed)
}

/**
 * An explicitly requested removal: either facet addresses (unambiguous) or facet
 * names, which are resolved through the deploy log and therefore cannot express
 * "the old one of two co-registered versions".
 */
type RemovalSelection =
  | { kind: 'addresses'; targets: IRemovalTarget[] }
  | { kind: 'names'; names: string[] }

/** One-line description of a selection for banners. */
function describeSelection(selection: RemovalSelection): string {
  return selection.kind === 'addresses'
    ? selection.targets.map((t) => t.address).join(', ')
    : selection.names.join(', ')
}

/** Prints the conspicuous banner for an explicitly requested removal on one network. */
function printExplicitRemoval(result: ITargetedRemovalResult): void {
  consola.box(
    `⚠️  IRREVERSIBLE FACET REMOVAL — ${result.network} (${result.environment})`
  )

  if (!result.diamondAddress) {
    consola.info(
      `[${result.network}] no LiFiDiamond in ${result.environment} deploy log — skipping`
    )
    return
  }

  if (result.removals.length === 0)
    consola.success(
      `[${result.network}] none of the requested facets are registered here`
    )
  else
    for (const r of result.removals) {
      consola.warn(
        `✗ REMOVE  ${r.name}  @ ${r.address}  (${r.selectors.length} selectors)`
      )
      consola.log(`   selectors: ${r.selectors.join(', ')}`)
    }

  for (const p of result.protectedSkipped)
    consola.error(
      `🛑 REFUSED ${p.name} @ ${p.address} — ${
        p.reason === 'allowlisted-name'
          ? 'on the never-remove allowlist (should never be deprecated)'
          : 'owns diamond-machinery selectors; removing it would brick the diamond'
      }`
    )

  for (const live of result.liveInTargetState)
    consola.error(
      `🛑 REFUSED ${live.name} @ ${live.address} — this is the deploy-log address of ` +
        `a facet _targetState.json still expects, i.e. the LIVE deployment. If you meant ` +
        `an older co-registered version, pass its address via --facetAddresses.`
    )

  if (result.unresolvedNames.length > 0)
    consola.info(
      `ℹ️  no ${
        result.network
      } deploy-log entry for: ${result.unresolvedNames.join(
        ', '
      )} — pass --facetAddresses if the facet is registered at an unlogged address`
    )

  if (result.notFoundOnChain.length > 0)
    consola.info(
      `ℹ️  not registered on ${result.network}: ${result.notFoundOnChain
        .map((t) => `${t.label ?? 'unknown'} @ ${t.address}`)
        .join(', ')}`
    )

  for (const pruned of result.prunedButRouted)
    consola.warn(
      `⚠️  ${pruned.address} is routed on-chain but absent from the ${result.network} ` +
        `deploy log — removing it anyway (the loupe is authoritative), but reconcile the log`
    )

  if (result.unresolved.length > 0)
    consola.warn(
      `⚠️  ${result.unresolved.length} on-chain facet(s) not in the ${result.network} ` +
        `deploy log — the log has drifted from chain:\n` +
        result.unresolved.map((a) => `   ${a}`).join('\n')
    )
}

/**
 * Removes an explicitly requested set of facets from one network's diamond
 * (deprecation-driven path). Selectors come from the on-chain loupe, so it works
 * after `/deprecate-contract` deleted the facet's source.
 */
async function runExplicitRemoval(
  network: string,
  environment: EnvironmentEnum,
  selection: RemovalSelection,
  confirmMode: 'yes' | 'prompt' | 'dry-run'
): Promise<void> {
  const result =
    selection.kind === 'addresses'
      ? await computeTargetedFacetRemovals(
          network,
          environment,
          selection.targets
        )
      : await computeFacetRemovalsByName(network, environment, selection.names)

  printExplicitRemoval(result)

  if (!result.diamondAddress) return
  await proposeRemovals(
    network,
    environment,
    result.diamondAddress,
    result.removals,
    confirmMode
  )
}

/**
 * Removes an explicitly requested set of facets across every active network (the
 * fleet form of the deprecation-driven path). Sequential to avoid per-network
 * Safe nonce races; dry-run unless `yes`. Per-network failures are collected so
 * survivors still run, then the sweep exits non-zero so a partial failure is
 * never reported as success.
 */
async function runExplicitFleetRemoval(
  environment: EnvironmentEnum,
  selection: RemovalSelection,
  yes: boolean
): Promise<void> {
  const networkIds = getAllActiveNetworks().map((n) => n.id)
  consola.box(
    `Fleet facet removal — [${describeSelection(selection)}] across ${
      networkIds.length
    } networks (${environment})${yes ? '' : ' [DRY RUN]'}`
  )

  const failed: string[] = []
  for (const network of networkIds)
    try {
      await runExplicitRemoval(
        network,
        environment,
        selection,
        yes ? 'yes' : 'dry-run'
      )
    } catch (err) {
      failed.push(network)
      consola.error(
        `[${network}] failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

  exitOnFleetFailures(failed)
}

runMain(command)
