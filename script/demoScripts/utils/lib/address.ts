/**
 * Utility functions for working with Ethereum addresses
 */

/**
 * Formats an address string to ensure it has the 0x prefix and is properly formatted
 * @param address The address to format
 * @returns The formatted address with 0x prefix
 */
export function formatAddress(address: string): `0x${string}` {
  // Ensure the address has the 0x prefix
  const prefixedAddress = address.startsWith('0x') ? address : `0x${address}`
  
  // Ensure the address is lowercase for consistency
  const formattedAddress = prefixedAddress.toLowerCase()
  
  // Return the address with the correct type
  return formattedAddress as `0x${string}`
}