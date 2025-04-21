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
  getViemChainForNetworkName,
} from '../utils/viemScriptHelpers'
import { Abi, createPublicClient, http, parseAbi, getAddress } from 'viem'

function castEnv(value: string): 'staging' | 'production' {
  if (value !== 'staging' && value !== 'production') {
    throw new Error(`Invalid environment: ${value}`)
  }
  return value
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
      let facetNames: string[]
      try {
        facetNames = JSON.parse(facets)
        if (
          !Array.isArray(facetNames) ||
          facetNames.some((n) => typeof n !== 'string')
        ) {
          throw new Error()
        }
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
        .sort((a, b) => a.localeCompare(b))

      // select one or more facets
      const selectedFacets = (await consola.prompt('Select facets to remove', {
        type: 'multiselect',
        options: facetNames,
      })) as string[]

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
        deployLog,
      })

      // -------------

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

async function verifySelectorsExistInDiamond({
  diamondAddress,
  facetDefs,
  network,
  deployLog,
}: {
  diamondAddress: string
  facetDefs: { name: string; selectors: `0x${string}`[] }[]
  network: string
  deployLog: Record<string, string>
}): Promise<void> {
  const chain = getViemChainForNetworkName(network)
  const client = createPublicClient({
    chain,
    transport: http(),
  })

  // prepare multicalls
  const calls = facetDefs.map((facet) => ({
    address: getAddress(diamondAddress),
    abi: parseAbi([
      'function facetFunctionSelectors(address _facet) view returns (bytes4[])',
    ]) satisfies Abi,
    functionName: 'facetFunctionSelectors',
    args: [getAddress(facetAddressFromName(deployLog, facet.name))],
  }))

  // execute multicalls to obtain all registered facets/function selectors
  const results = await client.multicall({ contracts: calls })

  // go through all function selectors and check if they are present in the diamond
  for (let i = 0; i < facetDefs.length; i++) {
    const facet = facetDefs[i]
    const result = results[i]

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

function facetAddressFromName(
  deployLog: Record<string, string>,
  name: string
): string {
  const facetAddress = deployLog[name]
  if (!facetAddress) {
    throw new Error(`No address found for facet in deploy log: ${name}`)
  }
  return facetAddress
}

runMain(command)
