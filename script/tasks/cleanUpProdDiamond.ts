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
    diamondAddress as `0x${string}`,
    originalCalldata
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
  },

  async run({ args }) {
    const { facets, periphery } = args
    let { network, environment } = args
    const diamondName = 'LiFiDiamond'
    let calldata: `0x${string}`

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

    // ---------------- HEADLESS: Facet removal ----------------
    if (facets) {
      consola.box('Running headless facet removal')
      // parse facetNames into string array
      let facetNames: string[]
      try {
        facetNames = JSON.parse(facets)
        if (
          !Array.isArray(facetNames) ||
          facetNames.some((n) => typeof n !== 'string')
        )
          throw new Error()
      } catch {
        consola.error(
          '❌  --facets must be a JSON array of strings, e.g. \'["FacetA","FacetB"]\''
        )
        process.exit(1)
      }

      // get function selectors for all facets
      const facetDefs = facetNames.map((name) => ({
        name,
        selectors: getFunctionSelectors(name),
      }))

      calldata = buildDiamondCutRemoveCalldata(facetDefs)

      consola.info(`📦 Built calldata to remove ${facetNames.length} facets`)

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

      await sendOrPropose({
        calldata: finalCalldata,
        network,
        environment: typedEnv,
        diamondAddress: targetAddress,
      })
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

      // get function selectors for each facet
      const facetDefs = selectedFacets.map((name) => ({
        name,
        selectors: getFunctionSelectors(name),
      }))

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
