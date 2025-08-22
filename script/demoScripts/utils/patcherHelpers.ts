import { randomBytes } from 'crypto'

import { encodeFunctionData, parseAbi, type Hex } from 'viem'

/**
 * Normalize calldata string by removing '0x' prefix if present
 * @param calldata - The calldata string to normalize
 * @returns Normalized calldata string without '0x' prefix
 */
export const normalizeCalldata = (calldata: string): string => {
  return calldata.startsWith('0x') ? calldata.slice(2) : calldata
}

/**
 * Find hex value positions
 * @param haystack The larger hex string (calldata) to search within
 * @param needle The hex pattern/value to search for within the haystack
 * @returns Array of byte offsets where the needle pattern is found in the haystack
 */
export const findHexValueOccurrences = (
  haystack: string,
  needle: string
): readonly number[] => {
  // Normalize both haystack and needle
  const cleanHaystack = normalizeCalldata(haystack)
  const cleanNeedle = normalizeCalldata(needle)

  const findRec = (
    startPos: number,
    acc: readonly number[]
  ): readonly number[] => {
    const foundPos = cleanHaystack.indexOf(cleanNeedle, startPos)

    if (foundPos === -1) return acc

    const byteOffset = foundPos / 2
    return findRec(foundPos + cleanNeedle.length, [...acc, byteOffset])
  }
  return findRec(0, [])
}

/**
 * Generate a random 32-byte hex needle for offset discovery
 */
export function generateNeedle(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex
}

/**
 * Find offset of a needle in calldata
 */
export function findNeedleOffset(calldata: string, needle: Hex): bigint {
  const positions = findHexValueOccurrences(calldata, needle)

  if (positions.length === 0)
    throw new Error(`Could not find needle ${needle} in calldata`)

  if (positions.length > 1)
    throw new Error(
      `Found multiple occurrences of needle ${needle} in calldata`
    )

  // At this point we know positions has exactly one element
  const firstPosition = positions[0]
  if (firstPosition === undefined)
    throw new Error('Unexpected undefined position')

  return BigInt(firstPosition)
}

/**
 * Generate calldata for executeWithDynamicPatches
 */
export function generateExecuteWithDynamicPatchesCalldata(
  valueSource: Hex,
  valueGetter: Hex,
  finalTarget: Hex,
  targetCalldata: Hex,
  offsets: bigint[],
  value = 0n,
  delegateCall = false
): Hex {
  const patcherAbi = parseAbi([
    'function executeWithDynamicPatches(address valueSource, bytes valueGetter, address finalTarget, uint256 value, bytes data, uint256[] offsets, bool delegateCall) returns (bool success, bytes returnData)',
  ])

  return encodeFunctionData({
    abi: patcherAbi,
    functionName: 'executeWithDynamicPatches',
    args: [
      valueSource,
      valueGetter,
      finalTarget,
      value,
      targetCalldata,
      offsets,
      delegateCall,
    ],
  }) as Hex
}

/**
 * Generate calldata for executeWithMultiplePatches
 */
export function generateExecuteWithMultiplePatchesCalldata(
  valueSources: Hex[],
  valueGetters: Hex[],
  finalTarget: Hex,
  targetCalldata: Hex,
  offsetGroups: bigint[][],
  value = 0n,
  delegateCall = false
): Hex {
  const patcherAbi = parseAbi([
    'function executeWithMultiplePatches(address[] valueSources, bytes[] valueGetters, address finalTarget, uint256 value, bytes data, uint256[][] offsetGroups, bool delegateCall) returns (bool success, bytes returnData)',
  ])

  return encodeFunctionData({
    abi: patcherAbi,
    functionName: 'executeWithMultiplePatches',
    args: [
      valueSources,
      valueGetters,
      finalTarget,
      value,
      targetCalldata,
      offsetGroups,
      delegateCall,
    ],
  }) as Hex
}

/**
 * Generate balanceOf calldata for use as valueGetter
 */
export function generateBalanceOfCalldata(account: Hex): Hex {
  return encodeFunctionData({
    abi: parseAbi([
      'function balanceOf(address account) view returns (uint256)',
    ]),
    functionName: 'balanceOf',
    args: [account],
  }) as Hex
}
