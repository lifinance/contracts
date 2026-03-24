import type { TronWeb } from 'tronweb'

import { ZERO_ADDRESS } from '../shared/constants'

import { TRON_ZERO_ADDRESS } from './constants'

/**
 * Tron base58 → EVM 20-byte hex (`0x` + 40 hex chars, lowercase before checksumming).
 */
export function tronAddressToHex(tronWeb: TronWeb, address: string): string {
  let hex = tronWeb.address.toHex(address)

  if (hex.startsWith('0x')) hex = hex.substring(2)

  if (hex.startsWith('41')) hex = hex.substring(2)

  if (hex.length > 40) hex = hex.substring(0, 40)
  else if (hex.length < 40) hex = hex.padStart(40, '0')

  const result = '0x' + hex.toLowerCase()

  if (result.length !== 42)
    throw new Error(
      `Invalid address conversion: expected 42 characters, got ${result.length}. ` +
        `Input: ${address}, Output: ${result}`
    )

  return result
}

/**
 * EVM hex (`0x` + 40 hex, or `41` + 40 hex without `0x`) → Tron base58.
 * EVM zero address maps to Tron’s native zero representation (`TRON_ZERO_ADDRESS`).
 */
export function evmHexToTronBase58(
  tronWeb: TronWeb,
  hexAddress: string
): string {
  if (hexAddress === ZERO_ADDRESS)
    return tronWeb.address.fromHex(TRON_ZERO_ADDRESS)

  let hex = hexAddress.startsWith('0x') ? hexAddress.slice(2) : hexAddress

  if (!hex.startsWith('41')) hex = '41' + hex

  return tronWeb.address.fromHex(hex)
}

/**
 * Normalize a Tron TVM `address` return value (e.g. `owner()`) to base58: already-base58,
 * `0x` + 20 bytes, or `41` + 40 hex without `0x` (truncation / padding handled like TronWeb callers expect).
 */
export function tronAddressLikeToBase58(
  tronWeb: TronWeb,
  value: unknown
): string {
  const ownerStr = String(value).trim()
  if (ownerStr.startsWith('T') && ownerStr.length >= 34) return ownerStr

  let hexForConversion = ownerStr
  if (hexForConversion.startsWith('0x'))
    hexForConversion = hexForConversion.substring(2)
  if (!hexForConversion.startsWith('41'))
    hexForConversion = '41' + hexForConversion
  if (hexForConversion.length > 42)
    hexForConversion = hexForConversion.substring(0, 42)
  else if (hexForConversion.length < 42)
    hexForConversion = hexForConversion.padEnd(42, '0')

  return tronWeb.address.fromHex(hexForConversion)
}

/**
 * Same as {@link tronAddressToHex} with a narrowed return type for viem `Address`-style fields.
 */
export function tronBase58ToEvm20Hex(
  tronWeb: TronWeb,
  base58: string
): `0x${string}` {
  return tronAddressToHex(tronWeb, base58) as `0x${string}`
}

/**
 * Strict: `0x` + 40 hex or 40 hex only → Tron base58 (e.g. Safe owners from `global.json`).
 */
export function evm20HexStringToTronBase58(
  tronWeb: TronWeb,
  evmAddress: string
): string {
  const hex = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress
  if (hex.length !== 40)
    throw new Error(`Invalid EVM address length: ${evmAddress}`)
  return evmHexToTronBase58(tronWeb, '0x' + hex)
}

/**
 * Base58 `T…`, `0x` + 20 bytes, or raw 20-byte hex → `0x` + 40 lowercase hex for ABI / registration params.
 */
export function tronRegistrationAddressToEvmHex(
  tronWeb: TronWeb,
  addr: string
): string {
  const a = addr.trim()
  if (a.startsWith('T')) return tronAddressToHex(tronWeb, a)
  if (a.startsWith('0x')) return a
  const stripped = a.replace(/^41/i, '').replace(/^0x/i, '')
  if (stripped.length >= 40) return `0x${stripped.slice(-40).toLowerCase()}`
  return `0x${stripped.padStart(40, '0').toLowerCase()}`
}

/**
 * DiamondLoupe `facets()` address field: Tron-hex → base58, or raw string on failure.
 */
export function tryTronFacetLoupeAddressToBase58(
  tronWeb: TronWeb,
  raw: unknown
): string {
  try {
    return tronWeb.address.fromHex(String(raw))
  } catch {
    return String(raw)
  }
}

/**
 * Proxy creation log / packed hex: `41` + 20 bytes or last 20 bytes → base58.
 */
export function tronProxyCreationHexToBase58(
  tronWeb: TronWeb,
  proxyHex: string
): string {
  const h = proxyHex.replace(/^0x/i, '').trim()
  const tronBody =
    h.startsWith('41') && h.length >= 42 ? h.slice(0, 42) : `41${h.slice(-40)}`
  return tronWeb.address.fromHex(tronBody)
}

/** Tron base58 form of the TVM zero address (`TRON_ZERO_ADDRESS` hex). */
export function tronZeroAddressBase58(tronWeb: TronWeb): string {
  return tronWeb.address.fromHex(TRON_ZERO_ADDRESS)
}
