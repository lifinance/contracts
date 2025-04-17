#!/usr/bin/env bun

/**
 * Purpose:
 *   - Remove facet(s) or unregister periphery contract(s) from the LiFiDiamond contract
 *   - Supports both interactive and headless CLI modes
 *   - In production, or when SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true in .env, it proposes calldata to our Safe (using SAFE_SIGNER_PRIVATE_KEY from .env)
 *   - In staging or when SEND_PROPOSALS_DIRECTLY_TO_DIAMOND!=true (or not set), it sends the transaction directly to the diamond (using PRIVATE_KEY from .env)
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

import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import path from 'path'
import fs from 'fs'

import {
  getDeployLogFile,
  getFunctionSelectors,
  buildDiamondCutRemoveCalldata,
  buildUnregisterPeripheryCalldata,
  getAllActiveNetworks,
  sendOrPropose,
} from '../utils/viemScriptHelpers'

function castEnv(value: string): 'staging' | 'production' {
  if (value !== 'staging' && value !== 'production') {
    throw new Error(`Invalid environment: ${value}`)
  }
  return value
}

const command = defineCommand({
  meta: {
    name: 'remove',
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
      network = await consola.prompt('Select network', {
        type: 'select',
        options,
      })
    }

    // select environment (if not provided via parameter)
    if (!environment) {
      environment = await consola.prompt('Select environment', {
        type: 'select',
        options: ['production', 'staging'],
      })
    }
    const typedEnv = castEnv(environment)

    // get diamond address from deploy log
    const deployLog = getDeployLogFile(network, typedEnv)
    const diamondAddress = deployLog[diamondName]

    if (!diamondAddress) {
      consola.error(`Could not find ${diamondName} in deploy log`)
      process.exit(1)
    }

    // ---------------- HEADLESS: Facet removal ----------------
    if (facets) {
      consola.box('Running headless facet removal')
      // parse facetNames into string array
      const facetNames: string[] = JSON.parse(facets)

      // get function selectors for all facets
      const facetDefs = facetNames.map((name) => ({
        name,
        selectors: getFunctionSelectors(name),
      }))

      calldata = buildDiamondCutRemoveCalldata(facetDefs)

      consola.info(`📦 Built calldata to remove ${facetNames.length} facets`)

      await sendOrPropose({
        calldata,
        network,
        environment: typedEnv,
        diamondAddress,
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

        // send it
        await sendOrPropose({
          calldata,
          network,
          environment: typedEnv,
          diamondAddress,
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

      // select one or more facets
      const selectedFacets = await consola.prompt('Select facets to remove', {
        type: 'multiselect',
        options: facetNames,
      })

      // get function selectors for each facet
      const facetDefs = selectedFacets.map((name) => ({
        name,
        selectors: getFunctionSelectors(name),
      }))

      // build the (combined) calldata for removal of all selected facets
      calldata = buildDiamondCutRemoveCalldata(facetDefs)

      consola.log('\n📦 Calldata:')
      consola.log(calldata)

      const confirm = await consola.prompt('Send/propose this calldata?', {
        type: 'confirm',
        initial: true,
      })

      // send/propose it if the user selected yes
      if (confirm) {
        await sendOrPropose({
          calldata,
          network,
          environment: typedEnv,
          diamondAddress,
        })
      } else {
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
      const selected = await consola.prompt('Select periphery contracts', {
        type: 'multiselect',
        options: names,
      })

      // go through each contract, build the calldata and send/propose it
      for (const name of selected) {
        const data = buildUnregisterPeripheryCalldata(name)
        consola.log(`\n📦 Calldata to unregister: ${name}`)
        consola.log(data)

        const confirm = await consola.prompt(`Propose removal of ${name}?`, {
          type: 'confirm',
          initial: true,
        })

        // send/propose it if the user selected yes
        if (confirm) {
          await sendOrPropose({
            calldata: data,
            network,
            environment: typedEnv,
            diamondAddress,
          })
        }
      }
      return
    }
  },
})

runMain(command)
