import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import {
  Hex,
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseAbi,
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
// @ts-ignore
for (const [k, v] of Object.entries(chains)) chainMap[k] = v

const main = defineCommand({
  meta: {
    name: 'diamond-sync-sigs',
    description: 'Sync approved function signatures',
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

    console.log(`Checking signature for ${chain.name}`)

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

    // Instantiate readonly dex manager contract
    const dexManagerReader = getContract({
      address: deployedContracts['LiFiDiamond'],
      abi: parseAbi([
        'function isFunctionApproved(bytes4) external view returns (bool)',
      ]),
      client: publicClient,
    })

    // Check if function signatures are approved
    const { sigs } = await import(`../../config/sigs.json`)
    const calls = sigs.map((sig: string) => {
      return {
        ...dexManagerReader,
        functionName: 'isFunctionApproved',
        args: [sig],
      }
    })
    const results = await publicClient.multicall({ contracts: calls })

    // Get list of function signatures to approve
    const sigsToApprove: Hex[] = []
    let multicallSuccess = true
    for (let i = 0; i < results.length; i++)
      if (results[i].status === 'success') {
        if (!results[i].result) {
          console.log('Function not approved:', sigs[i])
          sigsToApprove.push(sigs[i] as Hex)
        }
      } else multicallSuccess = false

    if (!multicallSuccess) {
      consola.error(
        `The multicall failed, could not check all currently registered signatures. Please use a different RPC for this network and try to run the script again.`
      )
      // returning a success code here cause otherwise the wrapping bash script will always run the "old approach"
      // and we still end up re-approving all signatures again and again
      process.exit(0)
    }

    // Instantiate wallet (write enabled) client
    const account = privateKeyToAccount(`0x${privateKey}` as Hex)
    const walletClient = createWalletClient({
      chain,
      transport: http(),
      account,
    })

    if (sigsToApprove.length > 0) {
      // Approve function signatures
      console.log('Approving function signatures...')
      let tx
      try {
        tx = await walletClient.writeContract({
          address: deployedContracts['LiFiDiamond'],
          abi: parseAbi([
            'function batchSetFunctionApprovalBySignature(bytes4[],bool) external',
          ]),
          functionName: 'batchSetFunctionApprovalBySignature',
          args: [sigsToApprove, true],
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
      console.log('All Signatures are already approved.')
      process.exit(0)
    }
  },
})

runMain(main)
