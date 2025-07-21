import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseAbi,
  type Hex,
  type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'

import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

export const chainNameMappings: Record<string, string> = {
  zksync: 'zkSync',
  polygonzkevm: 'polygonZkEvm',
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) chainMap[k] = v

const main = defineCommand({
  meta: {
    name: 'diamond-sync-selectors',
    description: 'Sync approved function selectors',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL',
    },
    privateKey: {
      type: 'string',
      description: 'Private key',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'PROD (production) or STAGING (staging) environment',
      required: true,
    },
  },
  async run({ args }) {
    const { network, privateKey, environment } = args

    const chain = getViemChainForNetworkName(network)

    console.log(`Checking selector for ${chain.name}`)

    // Fetch list of deployed contracts
    const deployedContracts = await import(
      `../../deployments/${network.toLowerCase()}${
        environment === 'staging' ? '.staging' : ''
      }.json`
    )

    const rpcUrl = args.rpcUrl || chain.rpcUrls.default.http[0]

    // Instantiate public client for reading
    const publicClient = createPublicClient({
      batch: { multicall: true },
      chain,
      transport: http(rpcUrl),
    })

    // Instantiate readonly whitelist manager contract
    const whitelistManagerReader = getContract({
      address: deployedContracts['LiFiDiamond'],
      abi: parseAbi([
        'function isFunctionSelectorWhitelisted(bytes4) external view returns (bool)',
      ]),
      client: publicClient,
    })

    // Check if function selectors are approved
    const { selectors } = await import(`../../config/whitelistedSelectors.json`)
    const calls = selectors.map((selector: string) => {
      return {
        ...whitelistManagerReader,
        functionName: 'isFunctionSelectorWhitelisted',
        args: [selector],
      }
    })
    const results = await publicClient.multicall({ contracts: calls })

    // Get list of function selectors to approve
    const selectorsToApprove: Hex[] = []
    let multicallSuccess = true
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (!result) throw new Error(`Missing result at index ${i}`)
      if (result.status === 'success') {
        if (!result.result) {
          console.log('Function not approved:', selectors[i])
          selectorsToApprove.push(selectors[i] as Hex)
        }
      } else multicallSuccess = false
    }

    if (!multicallSuccess) {
      consola.error(
        `The multicall failed, could not check all currently registered selectors. Please use a different RPC for this network and try to run the script again.`
      )
      // returning a success code here cause otherwise the wrapping bash script will always run the "old approach"
      // and we still end up re-approving all selectors again and again
      process.exit(0)
    }

    // Instantiate wallet (write enabled) client
    const account = privateKeyToAccount(`0x${privateKey}`)
    const walletClient = createWalletClient({
      chain,
      transport: http(),
      account,
    })

    if (selectorsToApprove.length > 0) {
      // Approve function selectors
      console.log('Approving function selectors...')
      let tx
      try {
        tx = await walletClient.writeContract({
          address: deployedContracts['LiFiDiamond'],
          abi: parseAbi([
            'function batchSetFunctionWhitelistBySelectors(bytes4[],bool) external',
          ]),
          functionName: 'batchSetFunctionWhitelistBySelectors',
          args: [selectorsToApprove, true],
          account,
        })

        await publicClient.waitForTransactionReceipt({ hash: tx })
      } catch (err) {
        consola.error(JSON.stringify(err, null, 2))
        process.exit(1)
      }

      console.log('Transaction:', tx)
      process.exit(0)
    } else {
      console.log('All selectors are already approved.')
      process.exit(0)
    }
  },
})

runMain(main)
