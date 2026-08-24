import fs from 'fs'
import path from 'path'

import { encodeFunctionData, parseAbi, type Hex } from 'viem'

export interface IFraxChainIdMapping {
  chainId: bigint
  lzEid: number
}

export const SET_FRAX_CHAIN_ID_TO_EID_ABI = parseAbi([
  'function setFraxChainIdToEid((uint256 chainId, uint32 lzEid)[] chainIdConfigs)',
])

export const GET_FRAX_CHAIN_ID_TO_EID_ABI = parseAbi([
  'function getFraxChainIdToEid(uint256 chainId) view returns (uint32 lzEid)',
])

/**
 * Validates and normalizes the `mappings` array of `config/frax.json`.
 * @param parsed - Parsed contents of a frax config file
 * @returns One `{ chainId, lzEid }` entry per config row
 * @throws When `mappings` is missing/empty or any row has a zero chainId or lzEid
 */
export function parseFraxMappings(parsed: {
  mappings?: Array<{ chainId: unknown; lzEid: unknown }>
}): IFraxChainIdMapping[] {
  if (!parsed.mappings || !Array.isArray(parsed.mappings))
    throw new Error('Invalid config file format: missing mappings')

  const mappings: IFraxChainIdMapping[] = parsed.mappings.map((m, idx) => {
    const chainId = BigInt(String(m.chainId))
    const lzEid = Number(m.lzEid)

    if (chainId <= 0n)
      throw new Error(
        `Invalid mapping at index ${idx}: chainId=${String(m.chainId)}`
      )
    // lzEid 0 is the facet's "unset" sentinel, so the facet rejects it on-chain
    if (!Number.isInteger(lzEid) || lzEid <= 0)
      throw new Error(
        `Invalid mapping at index ${idx}: lzEid=${String(m.lzEid)}`
      )

    return { chainId, lzEid }
  })

  if (mappings.length === 0) throw new Error('No mappings found')

  return mappings
}

/**
 * Reads and validates `config/frax.json` from the current working directory.
 * @returns The configured chainId -> LayerZero EID mappings
 */
export function loadFraxMappings(): IFraxChainIdMapping[] {
  const filePath = path.join(process.cwd(), 'config', 'frax.json')
  return parseFraxMappings(
    JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      mappings?: Array<{ chainId: unknown; lzEid: unknown }>
    }
  )
}

/**
 * ABI-encodes a `setFraxChainIdToEid` call for the given mappings.
 * @param mappings - Entries to write into the diamond's Frax storage
 * @returns Calldata targeting the LiFiDiamond
 */
export function encodeSetFraxChainIdToEid(
  mappings: IFraxChainIdMapping[]
): Hex {
  return encodeFunctionData({
    abi: SET_FRAX_CHAIN_ID_TO_EID_ABI,
    functionName: 'setFraxChainIdToEid',
    args: [mappings.map((m) => ({ chainId: m.chainId, lzEid: m.lzEid }))],
  })
}

/**
 * Extracts the raw revert bytes from a viem call error.
 * @param error - Error thrown or returned by a viem contract read
 * @returns The revert payload, or undefined when the failure carried none
 * @dev viem parks the raw bytes on `raw` when the call ABI does not declare the
 *      reverting error (then `data` holds the decoded result, which is undefined).
 *      Needed to recognise errors like UnsupportedChainId.
 */
export function getRevertData(error: unknown): Hex | undefined {
  if (!error || typeof error !== 'object') return undefined

  if ('data' in error && typeof error.data === 'string')
    return error.data as Hex

  if ('raw' in error && typeof (error as { raw?: unknown }).raw === 'string')
    return (error as { raw: string }).raw as Hex

  if ('cause' in error) return getRevertData(error.cause)

  return undefined
}
