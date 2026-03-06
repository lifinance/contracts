import { defineCommand } from 'citty'
import { consola } from 'consola'

import { isValidAddress } from '../utils/parser'
import { initTronWeb } from '../utils/tronweb'

/**
 * Convert a Tron base58 address to EVM-compatible hex format
 * Removes the '41' Tron prefix and adds '0x'
 */
function tronAddressToHex(
  tronWeb: ReturnType<typeof initTronWeb>,
  address: string
): string {
  let hex = tronWeb.address.toHex(address)

  // Remove '0x' prefix if present
  if (hex.startsWith('0x')) hex = hex.substring(2)

  // Remove '41' prefix (Tron address prefix) if present
  // Tron addresses in hex format start with '41', but EVM-style calls need 20-byte addresses
  if (hex.startsWith('41')) hex = hex.substring(2)

  // Ensure exactly 40 hex characters (20 bytes)
  if (hex.length > 40) hex = hex.substring(0, 40)
  else if (hex.length < 40) hex = hex.padStart(40, '0')

  return '0x' + hex.toLowerCase()
}

/**
 * Convert a hex address to Tron base58 format
 * Adds the '41' Tron prefix before converting to base58
 */
function hexToTronAddress(
  tronWeb: ReturnType<typeof initTronWeb>,
  hexAddress: string
): string {
  // Remove 0x prefix if present
  let hex = hexAddress.startsWith('0x') ? hexAddress.substring(2) : hexAddress

  // Add '41' prefix if not present (Tron's address prefix)
  if (!hex.startsWith('41')) hex = '41' + hex

  return tronWeb.address.fromHex(hex)
}

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
          results.push(hexToTronAddress(tronWeb, addr))
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
