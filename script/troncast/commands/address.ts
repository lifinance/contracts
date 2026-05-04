import { defineCommand } from 'citty'
import { consola } from 'consola'

import {
  evmHexToTronBase58,
  tronAddressToHex,
} from '../../deploy/tron/tronAddressHelpers'
import { isValidAddress } from '../utils/parser'
import { initTronWeb } from '../utils/tronweb'

const toHexCommand = defineCommand({
  meta: {
    name: 'to-hex',
    description: 'Convert Tron base58 address(es) to EVM-compatible hex format',
  },
  args: {
    addresses: {
      type: 'positional',
      description:
        'Tron address(es) to convert. Comma-separated for multiple addresses.',
      required: true,
    },
  },
  async run({ args }) {
    try {
      // Initialize TronWeb (we only need it for address conversion, no RPC needed)
      const tronWeb = initTronWeb('mainnet')

      const inputAddresses = args.addresses.split(',').map((a) => a.trim())
      const results: string[] = []

      for (const addr of inputAddresses) {
        if (!isValidAddress(addr)) {
          consola.error(`Invalid address: ${addr}`)
          process.exit(1)
        }

        // If already hex, just output it (normalized)
        if (addr.startsWith('0x')) {
          results.push(addr.toLowerCase())
        } else if (addr.startsWith('41')) {
          // Hex without 0x prefix - normalize
          results.push('0x' + addr.substring(2).toLowerCase())
        } else {
          // Base58 - convert to hex
          results.push(tronAddressToHex(tronWeb, addr))
        }
      }

      // Output comma-separated hex addresses
      console.log(results.join(','))
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(errorMessage)
      process.exit(1)
    }
  },
})

const toBase58Command = defineCommand({
  meta: {
    name: 'to-base58',
    description: 'Convert hex address(es) to Tron base58 format',
  },
  args: {
    addresses: {
      type: 'positional',
      description:
        'Hex address(es) to convert. Comma-separated for multiple addresses.',
      required: true,
    },
  },
  async run({ args }) {
    try {
      // Initialize TronWeb (we only need it for address conversion, no RPC needed)
      const tronWeb = initTronWeb('mainnet')

      const inputAddresses = args.addresses.split(',').map((a) => a.trim())
      const results: string[] = []

      for (const addr of inputAddresses) {
        if (!isValidAddress(addr)) {
          consola.error(`Invalid address: ${addr}`)
          process.exit(1)
        }

        // If already base58, just output it
        if (addr.startsWith('T')) {
          results.push(addr)
        } else {
          // Hex - convert to base58
          results.push(evmHexToTronBase58(tronWeb, addr))
        }
      }

      // Output comma-separated base58 addresses
      console.log(results.join(','))
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(errorMessage)
      process.exit(1)
    }
  },
})

export const addressCommand = defineCommand({
  meta: {
    name: 'address',
    description: 'Address conversion utilities for Tron',
  },
  subCommands: {
    'to-hex': () => Promise.resolve(toHexCommand),
    'to-base58': () => Promise.resolve(toBase58Command),
  },
})
