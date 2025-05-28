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

    if (foundPos === -1) {
      return acc
    }

    const byteOffset = foundPos / 2
    return findRec(foundPos + cleanNeedle.length, [...acc, byteOffset])
  }
  return findRec(0, [])
}
