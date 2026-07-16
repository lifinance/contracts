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
 * Usage (Facet Removal):
 *   bun script/tasks/cleanUpProdDiamond.ts --network mainnet --environment production --facets '["FacetA","FacetB"]'
 *
 * Usage (Periphery Removal):
 *   bun script/tasks/cleanUpProdDiamond.ts --network mainnet --environment production --periphery '["Executor","FeeCollector"]'
 */

import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { createPublicClient, getAddress, http, parseAbi, type Abi } from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../common/types'
import {
  computeFacetRemovalDiff,
  computeNamedFacetRemovals,
  type IFacetRemoval,
  type INamedRemovalResult,
  type IRemovalDiff,
} from '../deploy/safe/diamondRemovalDiff'
import { wrapWithTimelockSchedule } from '../deploy/safe/safe-utils'
import { sendOrPropose } from '../safe/safeScriptHelpers'
import {
  buildDiamondCutRemoveCalldata,
  buildUnregisterPeripheryCalldata,
  castEnv,
  getAllActiveNetworks,
  getContractAddressForNetwork,
  getFunctionSelectors,
  getViemChainForNetworkName,
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
      description: 'JSON array of facet names (e.g. ["FacetA","FacetB"])',
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
        'Skip confirmation and actually propose/send (auto/sweep modes are dry-run without it)',
    },
  },

  async run({ args }) {
    const { facets, periphery, auto, allNetworks, yes } = args
    let { network, environment } = args
    const diamondName = 'LiFiDiamond'
    let calldata: `0x${string}`

    // --auto (target-state diff) and --facets (explicit names) drive different
    // removal engines; refuse the ambiguous combination instead of silently
    // letting one win.
    if (auto && facets) {
      consola.error('--auto and --facets are mutually exclusive')
      process.exit(1)
    }

    // ---------------- FLEET removals across all networks ----------------
    if (allNetworks) {
      if (!environment)
        environment = await selectWithSearch('Select environment', [
          'production',
          'staging',
        ])
      const env = castEnv(environment)
      if (facets)
        // Named-facet fleet removal (the deprecation-driven path).
        await runNamedFleetRemoval(env, parseFacetNames(facets), Boolean(yes))
      // No names → target-state-diff sweep (--all-networks implies --auto):
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

    // ---------------- HEADLESS: named-facet removal (single network) ----------------
    // Loupe-driven (not out/-based), so it works after `/deprecate-contract`
    // deletes the facet's source. Dry-run unless --yes (or interactive confirm).
    if (facets) {
      consola.box('Running headless facet removal')
      await runNamedRemoval(
        network,
        typedEnv,
        parseFacetNames(facets),
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

      // Interactive selection only lists facets whose source exists under
      // src/Facets/, so their artifact should be present. If the build is
      // stale/incomplete the read throws — surface a clear message pointing at
      // the loupe-driven --facets path (which works for already-deprecated
      // facets) instead of a raw "artifact not found".
      const facetDefs = selectedFacets.map((name) => {
        try {
          return { name, selectors: getFunctionSelectors(name) }
        } catch {
          consola.error(
            `Could not read selectors for "${name}" from out/. Run "forge build", ` +
              `or use the headless --facets '["${name}"]' path (loupe-driven, works ` +
              `for already-deprecated facets whose artifact is gone).`
          )
          return process.exit(1)
        }
      })

      // -------------
      // make sure that all function selectors are indeed registered in the diamond
      await verifySelectorsExistInDiamond({
        diamondAddress,
        facetDefs,
        network,
        environment: typedEnv,
      })

      // -------------

      // build the (combined) calldata for removal of all selected facets
      calldata = buildDiamondCutRemoveCalldata(facetDefs)

      // Show environment variables and decision logic before confirmation
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

      const confirm = await consola.prompt('Send/propose this calldata?', {
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
      else {
        consola.info('Aborted.')
        process.exit(0)
      }
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
 * degrades to `'dry-run'` so a removal is never submitted without confirmation.
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

  const effectiveMode =
    confirmMode === 'prompt' && !process.stdin.isTTY ? 'dry-run' : confirmMode

  if (effectiveMode === 'dry-run') {
    consola.warn(
      `[${network}] dry-run — not proposing. Re-run with --yes to submit (or confirm interactively).`
    )
    return
  }

  if (effectiveMode === 'prompt') {
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

/** Prints the conspicuous banner for an explicit named-facet removal on one network. */
function printNamedRemoval(result: INamedRemovalResult): void {
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
      `[${result.network}] none of the named facets are registered here`
    )
  else
    for (const r of result.removals) {
      consola.warn(
        `✗ REMOVE  ${r.name}  @ ${r.address}  (${r.selectors.length} selectors)`
      )
      consola.log(`   selectors: ${r.selectors.join(', ')}`)
    }

  if (result.protectedSkipped.length > 0)
    consola.error(
      `🛑 REFUSED (never-remove allowlist — should never be deprecated): ${result.protectedSkipped.join(
        ', '
      )}`
    )

  if (result.notFoundOnChain.length > 0)
    consola.info(
      `ℹ️  not registered on ${result.network}: ${result.notFoundOnChain.join(
        ', '
      )}`
    )
}

/**
 * Removes an explicit set of named facets from one network's diamond
 * (deprecation-driven path). Selectors come from the on-chain loupe, so it works
 * after `/deprecate-contract` deleted the facet's source.
 */
async function runNamedRemoval(
  network: string,
  environment: EnvironmentEnum,
  facetNames: string[],
  confirmMode: 'yes' | 'prompt' | 'dry-run'
): Promise<void> {
  const result = await computeNamedFacetRemovals(
    network,
    environment,
    facetNames
  )

  printNamedRemoval(result)

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
 * Removes an explicit set of named facets across every active network (the
 * fleet form of the deprecation-driven path). Sequential to avoid per-network
 * Safe nonce races; dry-run unless `yes`. Per-network failures are collected so
 * survivors still run, then the sweep exits non-zero so a partial failure is
 * never reported as success.
 */
async function runNamedFleetRemoval(
  environment: EnvironmentEnum,
  facetNames: string[],
  yes: boolean
): Promise<void> {
  const networkIds = getAllActiveNetworks().map((n) => n.id)
  consola.box(
    `Fleet named-facet removal — [${facetNames.join(', ')}] across ${
      networkIds.length
    } networks (${environment})${yes ? '' : ' [DRY RUN]'}`
  )

  const failed: string[] = []
  for (const network of networkIds)
    try {
      await runNamedRemoval(
        network,
        environment,
        facetNames,
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

async function verifySelectorsExistInDiamond({
  diamondAddress,
  facetDefs,
  network,
  environment,
}: {
  diamondAddress: string
  facetDefs: { name: string; selectors: `0x${string}`[] }[]
  network: string
  environment: EnvironmentEnum
}): Promise<void> {
  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({
    chain,
    transport: http(),
  })

  // prepare multicalls
  const calls = await Promise.all(
    facetDefs.map(async (facet) => ({
      address: getAddress(diamondAddress),
      abi: parseAbi([
        'function facetFunctionSelectors(address _facet) view returns (bytes4[])',
      ]) satisfies Abi,
      functionName: 'facetFunctionSelectors',
      args: [
        getAddress(
          await getContractAddressForNetwork(
            facet.name,
            network as SupportedChain,
            environment
          )
        ),
      ],
    }))
  )

  // execute multicalls to obtain all registered facets/function selectors
  const results = await client.multicall({ contracts: calls })

  // go through all function selectors and check if they are present in the diamond
  for (let i = 0; i < facetDefs.length; i++) {
    const facet = facetDefs[i]
    if (!facet) throw new Error(`Missing facet at index ${i}`)
    const result = results[i]
    if (!result) throw new Error(`Missing result for facet ${facet.name}`)

    if (result.status !== 'success') {
      consola.error(
        `❌ Failed to fetch selectors for facet "${facet.name}". Multicall status: ${result.status}`
      )
      process.exit(1)
    }

    const selectorsOnChain = result.result as `0x${string}`[]
    const missing = facet.selectors.filter(
      (sel) => !selectorsOnChain.includes(sel)
    )

    if (missing.length > 0) {
      consola.error(
        `❌ The following selectors of facet "${facet.name}" are not registered in diamond ${diamondAddress}:\n` +
          missing.map((s) => `  ${s}`).join('\n')
      )
      process.exit(1)
    }
  }

  // All selectors present — return silently
}

runMain(command)
