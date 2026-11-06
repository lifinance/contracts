/**
 * Pure helpers for the AllBridge chainId -> allBridgeChainId mapping stored per diamond.
 * Import from the propose task or its tests; the CLI module itself runs on import,
 * so anything unit-testable belongs here.
 */

import fs from 'fs'
import path from 'path'

import {
  decodeErrorResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'

import { redactUrls } from '../utils/redactUrls'

export interface IAllBridgeChainIdMapping {
  chainId: bigint
  allBridgeChainId: number
}

/** One `allowFailure: true` multicall result, as viem returns it. */
export type MappingReadResult =
  | { status: 'success'; result: bigint }
  | { status: 'failure'; error: unknown }

export interface IMappingRepairCalls {
  targets: Address[]
  values: bigint[]
  payloads: Hex[]
}

export const SET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI = parseAbi([
  'function setChainIdToAllBridgeChainId((uint256 chainId, uint256 allBridgeChainId)[] chainIdConfigs)',
])

export const UNSET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI = parseAbi([
  'function unsetChainIdToAllBridgeChainId(uint256 _chainId)',
])

export const GET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI = parseAbi([
  'function getChainIdToAllBridgeChainId(uint256 chainId) view returns (uint256 allBridgeChainId)',
])

export const ALL_BRIDGE_ERRORS_ABI = parseAbi([
  'error UnsupportedAllBridgeChainId()',
])

/**
 * Validates and normalizes the `mappings` array of `config/allbridge.json`.
 * @param parsed - Parsed contents of an allbridge config file
 * @returns One `{ chainId, allBridgeChainId }` entry per config row
 * @throws When `mappings` is missing/empty or a row has a non-positive chainId or allBridgeChainId
 */
export function parseAllBridgeMappings(parsed: {
  mappings?: Array<{ chainId: unknown; allBridgeChainId: unknown }>
}): IAllBridgeChainIdMapping[] {
  if (!parsed.mappings || !Array.isArray(parsed.mappings))
    throw new Error('Invalid config file format: missing mappings')

  const mappings: IAllBridgeChainIdMapping[] = parsed.mappings.map((m, idx) => {
    const chainId = BigInt(String(m.chainId))
    const allBridgeChainId = Number(m.allBridgeChainId)

    if (chainId <= 0n)
      throw new Error(
        `Invalid mapping at index ${idx}: chainId=${String(m.chainId)}`
      )
    // AllBridge chain IDs start at 1; 0 is reserved for "unmapped"
    if (!Number.isInteger(allBridgeChainId) || allBridgeChainId <= 0)
      throw new Error(
        `Invalid mapping at index ${idx}: allBridgeChainId=${String(
          m.allBridgeChainId
        )}`
      )

    return { chainId, allBridgeChainId }
  })

  if (mappings.length === 0) throw new Error('No mappings found')

  return mappings
}

/**
 * Reads and validates `config/allbridge.json` from the current working directory.
 * @returns The configured chainId -> allBridgeChainId mappings
 * @throws When the file is missing, is not valid JSON, or fails `parseAllBridgeMappings`
 */
export function loadAllBridgeMappings(): IAllBridgeChainIdMapping[] {
  const filePath = path.join(process.cwd(), 'config', 'allbridge.json')
  return parseAllBridgeMappings(
    JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      mappings?: Array<{ chainId: unknown; allBridgeChainId: unknown }>
    }
  )
}

/**
 * Lists the keys an inverted seed (allBridgeChainId stored as the chainId key) would have
 * written that no correct config row overwrites.
 * @param mappings - The configured mappings
 * @returns Every allBridgeChainId that is not also a configured chainId, in config order
 */
export function getStaleAllBridgeKeys(
  mappings: IAllBridgeChainIdMapping[]
): bigint[] {
  const chainIds = new Set(mappings.map((m) => m.chainId))
  const stale: bigint[] = []
  for (const m of mappings) {
    const key = BigInt(m.allBridgeChainId)
    if (!chainIds.has(key) && !stale.includes(key)) stale.push(key)
  }
  return stale
}

/**
 * Extracts the raw revert bytes from a viem call error.
 * @param error - Error thrown or returned by a viem contract read
 * @returns The revert payload, or undefined when the failure carried none
 * @dev viem parks the raw bytes on `raw` when the call ABI does not declare the
 *      reverting error (then `data` holds the decoded result, which is undefined).
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

/**
 * Tells whether a failed read reverted with `UnsupportedAllBridgeChainId` (key unset).
 * @param error - Error from a failed `getChainIdToAllBridgeChainId` read
 * @returns True only for that revert
 */
export function isUnsupportedAllBridgeChainIdRevert(error: unknown): boolean {
  const revertData = getRevertData(error)
  if (!revertData) return false
  try {
    return (
      decodeErrorResult({ abi: ALL_BRIDGE_ERRORS_ABI, data: revertData })
        .errorName === 'UnsupportedAllBridgeChainId'
    )
  } catch {
    return false
  }
}

function describeReadFailure(key: bigint, error: unknown): Error {
  const message = redactUrls(
    error instanceof Error ? error.message : String(error)
  )
  return new Error(`Failed to read chainId ${key.toString()}: ${message}`)
}

/**
 * Picks the config rows the diamond does not hold correctly.
 * @param mappings - The configured mappings
 * @param results - One `getChainIdToAllBridgeChainId(chainId)` result per mapping, same order
 * @returns Rows that are unset or differ from config
 * @throws When a read failed for any reason other than `UnsupportedAllBridgeChainId`
 */
export function selectMappingsNeedingUpdate(
  mappings: IAllBridgeChainIdMapping[],
  results: MappingReadResult[]
): IAllBridgeChainIdMapping[] {
  if (results.length !== mappings.length)
    throw new Error(
      `Expected ${mappings.length} read results, got ${results.length}`
    )

  return mappings.filter((mapping, i) => {
    const result = results[i] as MappingReadResult
    if (result.status === 'success')
      return Number(result.result) !== mapping.allBridgeChainId
    if (isUnsupportedAllBridgeChainIdRevert(result.error)) return true
    throw describeReadFailure(mapping.chainId, result.error)
  })
}

/**
 * Picks the stale keys the diamond still resolves.
 * @param staleKeys - Output of `getStaleAllBridgeKeys`
 * @param results - One `getChainIdToAllBridgeChainId(key)` result per stale key, same order
 * @returns Keys that resolve and therefore need an unset
 * @throws When a read failed for any reason other than `UnsupportedAllBridgeChainId`
 */
export function selectResolvingStaleKeys(
  staleKeys: bigint[],
  results: MappingReadResult[]
): bigint[] {
  if (results.length !== staleKeys.length)
    throw new Error(
      `Expected ${staleKeys.length} read results, got ${results.length}`
    )

  return staleKeys.filter((key, i) => {
    const result = results[i] as MappingReadResult
    if (result.status === 'success') return true
    if (isUnsupportedAllBridgeChainIdRevert(result.error)) return false
    throw describeReadFailure(key, result.error)
  })
}

/**
 * ABI-encodes a `setChainIdToAllBridgeChainId` call for the given mappings.
 * @param mappings - Entries to write into the diamond's AllBridge storage
 * @returns Calldata targeting the LiFiDiamond
 */
export function encodeSetChainIdToAllBridgeChainId(
  mappings: IAllBridgeChainIdMapping[]
): Hex {
  return encodeFunctionData({
    abi: SET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI,
    functionName: 'setChainIdToAllBridgeChainId',
    args: [
      mappings.map((m) => ({
        chainId: m.chainId,
        allBridgeChainId: BigInt(m.allBridgeChainId),
      })),
    ],
  })
}

/**
 * ABI-encodes an `unsetChainIdToAllBridgeChainId` call.
 * @param key - The chainId key to delete from the diamond's AllBridge storage
 * @returns Calldata targeting the LiFiDiamond
 */
export function encodeUnsetChainIdToAllBridgeChainId(key: bigint): Hex {
  return encodeFunctionData({
    abi: UNSET_CHAIN_ID_TO_ALL_BRIDGE_CHAIN_ID_ABI,
    functionName: 'unsetChainIdToAllBridgeChainId',
    args: [key],
  })
}

/**
 * Builds the diamond calls of one repair batch: the set call first (when any row needs it),
 * then one unset per stale key.
 * @param params.diamondAddress - The LiFiDiamond every call targets
 * @param params.mappingsToSet - Rows to (re)write
 * @param params.staleKeysToUnset - Keys to delete
 * @returns Parallel target/value/payload arrays; empty when there is nothing to do
 */
export function buildMappingRepairCalls(params: {
  diamondAddress: Address
  mappingsToSet: IAllBridgeChainIdMapping[]
  staleKeysToUnset: bigint[]
}): IMappingRepairCalls {
  const { diamondAddress, mappingsToSet, staleKeysToUnset } = params

  const payloads: Hex[] = []
  if (mappingsToSet.length > 0)
    payloads.push(encodeSetChainIdToAllBridgeChainId(mappingsToSet))
  for (const key of staleKeysToUnset)
    payloads.push(encodeUnsetChainIdToAllBridgeChainId(key))

  return {
    targets: payloads.map(() => diamondAddress),
    values: payloads.map(() => 0n),
    payloads,
  }
}
