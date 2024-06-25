import { defineCommand, runMain } from 'citty'
import {
  Hex,
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseAbi,
  type Chain,
} from 'viem'
import { ethers } from 'ethers6'
import * as chains from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

export const chainNameMappings: Record<string, string> = {
  zksync: 'zkSync',
  polygonzkevm: 'polygonZkEvm',
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

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
  },
  async run({ args }) {
    const { network, privateKey } = args

    const chainName = chainNameMappings[network] || network
    const chain: Chain = chainMap[chainName]

    // Fetch list of deployed contracts
    const deployedContracts = await import(
      `../../deployments/${network.toLowerCase()}.json`
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
    for (let i = 0; i < results.length; i++) {
      if (!results[i].result) {
        console.log('Function not approved:', sigs[i])
        sigsToApprove.push(sigs[i] as Hex)
      }
    }

    // Instantiate wallet (write enabled) client
    const account = privateKeyToAccount(`0x${privateKey}` as Hex)
    const walletClient = createWalletClient({
      chain,
      transport: http(),
      account,
    })

    // Approve function signatures
    console.log('Approving function signatures...')
    const tx = await walletClient.writeContract({
      address: deployedContracts['LiFiDiamond'],
      abi: parseAbi([
        'function batchSetFunctionApprovalBySignature(bytes4[],bool) external',
      ]),
      functionName: 'batchSetFunctionApprovalBySignature',
      args: [sigsToApprove, true],
      account,
    })

    console.log('Transaction:', tx)
  },
})

runMain(main)
