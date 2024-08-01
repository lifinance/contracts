import { defineCommand, runMain } from 'citty'
import { type SafeApiKitConfig } from '@safe-global/api-kit'
import { type Chain, defineChain, getAddress } from 'viem'
import Safe, {
  ContractNetworksConfig,
  EthersAdapter,
} from '@safe-global/protocol-kit'
import SafeApiKit from '@safe-global/api-kit'
import { ethers } from 'ethers6'
import * as chains from 'viem/chains'
import {
  chainNameMappings,
  getSafeUtilityContracts,
  safeAddresses,
  safeApiUrls,
} from './config'

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

const main = defineCommand({
  meta: {
    name: 'propose-to-safe',
    description: 'Propose a transaction to a Gnosis Safe',
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
      description: 'Private key of the signer',
      required: true,
    },
    owners: {
      type: 'string',
      description: 'List of new owners to add to the safe separated by commas',
      required: true,
    },
  },
  async run({ args }) {
    // const chainName = chainNameMappings[args.network] || args.network
    // const chain: Chain = chainMap[chainName]

    const chainName = 'immutablezkevm'
    const chain = defineChain({
      id: 13371,
      name: 'Immutable zkEVM',
      nativeCurrency: {
        decimals: 18,
        name: 'IMX',
        symbol: 'IMX',
      },
      rpcUrls: {
        default: {
          http: ['https://rpc.immutable.com'], // [pre-commit-checker: not a secret]
          webSocket: ['wss://immutable-zkevm.drpc.org'],
        },
      },
      blockExplorers: {
        default: { name: 'Explorer', url: 'https://explorer.immutable.com/' },
      },
      contracts: {
        // multicall3: {
        //   address: '0x4f6F1CeE578C0B201c65CCaaBFF1D924377F622D',
        //   blockCreated: 2863004,
        // },
        multicall3: {
          address: '0xcA11bde05977b3631167028862bE2a173976CA11',
          blockCreated: 3680945,
        },
      },
    })

    const config: SafeApiKitConfig = {
      chainId: BigInt(chain.id),
      txServiceUrl: safeApiUrls[chainName.toLowerCase()],
    }

    const safeService = new SafeApiKit(config)

    const safeAddress = getAddress(safeAddresses[chainName.toLowerCase()])

    const rpcUrl = args.rpcUrl || chain.rpcUrls.default.http[0]
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const signer = new ethers.Wallet(args.privateKey, provider)

    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    })

    const protocolKit = await Safe.create({
      ethAdapter,
      safeAddress: safeAddress,
      contractNetworks: getSafeUtilityContracts(chain.id),
    })

    const owners = String(args.owners).split(',')

    let nextNonce = await safeService.getNextNonce(safeAddress)
    const info = safeService.getSafeInfo(safeAddress)
    for (const o of owners) {
      const owner = getAddress(o)
      const existingOwners = await protocolKit.getOwners()
      if (existingOwners.includes(owner)) {
        console.info('Owner already exists', owner)
        continue
      }

      const safeTransaction = await protocolKit.createAddOwnerTx(
        {
          ownerAddress: owner,
          threshold: (await info).threshold,
        },
        {
          nonce: nextNonce,
        }
      )

      const senderAddress = await signer.getAddress()
      const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
      const signature = await protocolKit.signHash(safeTxHash)

      console.info('Adding owner', owner)
      console.info('Signer Address', senderAddress)
      console.info('Safe Address', safeAddress)
      console.info('Network', chainName)

      // Propose transaction to the service
      await safeService.proposeTransaction({
        safeAddress: await protocolKit.getAddress(),
        safeTransactionData: safeTransaction.data,
        safeTxHash,
        senderAddress,
        senderSignature: signature.data,
      })

      console.info('Transaction proposed')
      nextNonce++
    }
  },
})

runMain(main)
