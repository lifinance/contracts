// @ts-nocheck
import { defineCommand, runMain } from 'citty'
import consola from 'consola'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import networksConfig from '../../config/networks.json'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

import { getPrivateKey } from './safe/safe-utils'

const PUSH0_BYTECODE = '0x5f60005260006000f3' // PUSH0 + MSTORE + RETURN

enum EVMVersionEnum {
  Berlin = 0,
  London = 1,
  Shanghai = 2,
  Cancun = 3,
}

const evmVersionEnumLabels = {
  [EVMVersionEnum.Berlin]: 'Berlin or earlier',
  [EVMVersionEnum.London]: 'London or later',
  [EVMVersionEnum.Shanghai]: 'Shanghai or later',
  [EVMVersionEnum.Cancun]: 'Cancun',
}

const main = defineCommand({
  meta: {
    name: 'EVM Version Check',
    description: 'Detect EVM version based on block fields and PUSH0 opcode',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
    privateKey: {
      type: 'string',
      description: 'Optional override for deployer private key',
    },
  },
  async run({ args }) {
    const { network } = args

    console.log(`network: ${network}`)

    const chain = getViemChainForNetworkName(network.toLowerCase())
    const publicClient = createPublicClient({
      chain,
      transport: http(chain.rpcUrls.default.http),
    })

    consola.info(`Connected to ${network} via ${chain.rpcUrls.default.http}`)
    const block = await publicClient.getBlock()

    consola.info(`Latest block: ${block.number}`)
    consola.info(
      `Timestamp: ${new Date(Number(block.timestamp) * 1000).toISOString()}`
    )

    let inferredVersion: EVMVersionEnum = EVMVersionEnum.Berlin

    if ('baseFeePerGas' in block) inferredVersion = EVMVersionEnum.London
    if ('withdrawalsRoot' in block) inferredVersion = EVMVersionEnum.Shanghai
    if ('blobGasUsed' in block || 'excessBlobGas' in block)
      inferredVersion = EVMVersionEnum.Cancun

    consola.box(
      'Attempting PUSH0 opcode deployment to verify Shanghai support...'
    )
    let push0Supported = false

    try {
      const privateKey = getPrivateKey(`PRIVATE_KEY_PRODUCTION`)
      if (!privateKey) 
        consola.warn('No deployer private key found — skipping PUSH0 check.')
       else {
        const account = privateKeyToAccount(`0x${privateKey}`)
        console.log('account: ', account)
        const walletClient = createWalletClient({
          chain,
          transport: http(networksConfig[network].rpcUrl),

          account,
        })

        const hash = await walletClient.sendTransaction({
          data: PUSH0_BYTECODE,
        })
        consola.info(`Sent PUSH0 test tx: ${hash}`)

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status === 'reverted') 
          consola.warn('PUSH0 tx reverted — PUSH0 likely not supported')
         else {
          consola.success('PUSH0 opcode supported — confirms Shanghai+')
          push0Supported = true
        }
      }
    } catch (err: any) {
      if (
        err.message?.includes('invalid opcode') ||
        err.message?.includes('execution reverted')
      ) 
        consola.warn('PUSH0 caused invalid opcode — not supported')
       else 
        consola.error('Unexpected error testing PUSH0:', err)
      
    }

    // Adjust inferred version if PUSH0 failed
    if (!push0Supported && inferredVersion >= EVMVersionEnum.Shanghai) {
      consola.info('Cancun/Shanghai features ignored due to failed PUSH0 test.')
      inferredVersion = EVMVersionEnum.London
    }

    consola.success(
      `Likely EVM version: ${evmVersionEnumLabels[inferredVersion]}`
    )
  },
})

runMain(main)
