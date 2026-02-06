import { defineCommand } from 'citty'
import { consola } from 'consola'

import type { Environment } from '../types'
import { isValidAddress } from '../utils/parser'
import { initTronWeb } from '../utils/tronweb'

export const codeCommand = defineCommand({
  meta: {
    name: 'code',
    description: 'Get contract bytecode from a Tron address',
  },
  args: {
    address: {
      type: 'positional',
      description: 'Contract address',
      required: true,
    },
    env: {
      type: 'string',
      description: 'Environment (mainnet or testnet)',
      default: 'mainnet',
    },
    rpcUrl: {
      type: 'string',
      description: 'Custom RPC URL (overrides environment variable)',
    },
  },
  async run({ args }) {
    try {
      // Validate inputs
      if (!isValidAddress(args.address))
        throw new Error(`Invalid contract address: ${args.address}`)

      const env = args.env as Environment
      if (env !== 'mainnet' && env !== 'testnet')
        throw new Error('Environment must be "mainnet" or "testnet"')

      // Initialize TronWeb with optional custom RPC URL
      const tronWeb = initTronWeb(env, undefined, args.rpcUrl)

      consola.debug(`Getting contract code for ${args.address}`)

      // Convert address to base58 format if it's in hex format
      // TronWeb.getContract expects base58 format
      let addressToCheck = args.address
      if (addressToCheck.startsWith('0x') || addressToCheck.startsWith('41')) {
        // Convert hex to base58
        addressToCheck = tronWeb.address.fromHex(
          addressToCheck.startsWith('0x')
            ? addressToCheck
            : `0x${addressToCheck}`
        )
        consola.debug(`Converted hex address to base58: ${addressToCheck}`)
      }

      // Get contract info using TronWeb
      let contractInfo
      try {
        contractInfo = await tronWeb.trx.getContract(addressToCheck)
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error'
        consola.debug('Get contract error details:', error)
        throw new Error(`Failed to get contract: ${errorMessage}`)
      }

      // Check if contract exists and has bytecode
      if (!contractInfo || !contractInfo.bytecode) {
        // No contract code - return empty (similar to cast code returning "0x")
        console.log('0x')
        return
      }

      // Return the bytecode (it's already in hex format)
      // TronWeb returns bytecode as hex string without 0x prefix, so add it
      const bytecode = contractInfo.bytecode.startsWith('0x')
        ? contractInfo.bytecode
        : `0x${contractInfo.bytecode}`

      console.log(bytecode)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(errorMessage)
      process.exit(1)
    }
  },
})
