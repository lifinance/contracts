/**
 * Pure helpers for the Frax chainId -> LayerZero EID mapping stored per diamond.
 * Import from the propose task or its tests; the CLI module itself runs on import,
 * so anything unit-testable belongs here.
 */

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
 * @throws When `mappings` is missing/empty, a row has a zero chainId or lzEid, or a
 *         chainId arrived rounded because it exceeds the safe integer range
 */
export function parseFraxMappings(parsed: {
  mappings?: Array<{ chainId: unknown; lzEid: unknown }>
}): IFraxChainIdMapping[] {
  if (!parsed.mappings || !Array.isArray(parsed.mappings))
    throw new Error('Invalid config file format: missing mappings')

  const mappings: IFraxChainIdMapping[] = parsed.mappings.map((m, idx) => {
    // JSON.parse has already coerced to double, so a chainId past 2^53 arrives
    // silently rounded — BigInt(String(...)) would preserve the wrong value
    if (typeof m.chainId === 'number' && !Number.isSafeInteger(m.chainId))
      throw new Error(
        `Invalid mapping at index ${idx}: chainId=${String(
          m.chainId
        )} exceeds ` +
          `the safe integer range; quote it as a string in the config`
      )

    const chainId = BigInt(String(m.chainId))
    const lzEid = Number(m.lzEid)

    if (chainId <= 0n)
      throw new Error(
        `Invalid mapping at index ${idx}: chainId=${String(m.chainId)}`
      )
    // lzEid 0 is the facet's "unset" sentinel, so the facet rejects it on-chain;
    // the upper bound is the on-chain uint32, which viem would otherwise only
    // catch deep in the encoder, far from the config that caused it
    if (!Number.isInteger(lzEid) || lzEid <= 0 || lzEid > 0xffffffff)
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
 * @throws When the file is missing, is not valid JSON, or fails `parseFraxMappings`
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
