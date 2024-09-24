import { defineCommand, runMain } from 'citty'
import { type SafeApiKitConfig } from '@safe-global/api-kit'
import { getAddress } from 'viem'
import Safe, { EthersAdapter } from '@safe-global/protocol-kit'
import SafeApiKit from '@safe-global/api-kit'
import { ethers } from 'ethers6'
import { getSafeUtilityContracts, safeAddresses, safeApiUrls } from './config'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

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
    const { network, privateKey } = args

    const chain = getViemChainForNetworkName(network)

    const config: SafeApiKitConfig = {
      chainId: BigInt(chain.id),
      txServiceUrl: safeApiUrls[network],
    }

    const safeService = new SafeApiKit(config)

    const safeAddress = getAddress(safeAddresses[network])

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
