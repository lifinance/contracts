import { defineCommand, runMain } from 'citty'
import { type SafeApiKitConfig } from '@safe-global/api-kit'
import type { Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import Safe, { EthersAdapter } from '@safe-global/protocol-kit'
import SafeApiKit from '@safe-global/api-kit'
import { ethers } from 'ethers'
import {
  OperationType,
  type SafeTransactionDataPartial,
} from '@safe-global/safe-core-sdk-types'
import * as chains from 'viem/chains'
import { safeApiUrls } from './config'

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
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
    privateKey: {
      type: 'string',
      description: 'Private key of the signer',
      required: true,
    },
    to: {
      type: 'string',
      description: 'To address',
      required: true,
    },
    calldata: {
      type: 'string',
      description: 'Calldata',
      required: true,
    },
  },
  async run({ args }) {
    const chain: Chain = chainMap[args.network]

    const account = privateKeyToAccount(
      ('0x' + args.privateKey) as `0x${string}`
    )

    const config: SafeApiKitConfig = {
      chainId: BigInt(chain.id),
      txServiceUrl: safeApiUrls[args.network.toLowerCase()],
    }

    console.log('Account', account.address)

    const safeService = new SafeApiKit(config)

    const resp = await safeService.getSafesByOwner(account.address)

    console.log('Safes', resp)

    const safeAddress = resp.safes[0]

    const provider = new ethers.JsonRpcProvider(chain.rpcUrls.default.http[0])
    const signer = new ethers.Wallet(args.privateKey, provider)

    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    })

    const protocolKit = await Safe.create({
      ethAdapter,
      safeAddress: safeAddress,
    })

    const nextNonce = await safeService.getNextNonce(safeAddress)
    const safeTransactionData: SafeTransactionDataPartial = {
      to: args.to,
      value: '0',
      data: args.calldata,
      operation: OperationType.Call,
      nonce: nextNonce,
    }

    const safeTransaction = await protocolKit.createTransaction({
      transactions: [safeTransactionData],
    })

    const senderAddress = await signer.getAddress()
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction)
    const signature = await protocolKit.signHash(safeTxHash)

    console.info('Signer Address', senderAddress)
    console.info('Safe Address', safeAddress)
    console.info('Network', args.network)
    console.info('Proosing transaction to', args.to)

    // Propose transaction to the service
    await safeService.proposeTransaction({
      safeAddress: await protocolKit.getAddress(),
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature: signature.data,
    })

    console.info('Transaction proposed')
  },
})

runMain(main)