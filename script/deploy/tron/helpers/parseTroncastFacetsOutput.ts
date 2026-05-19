/**
 * Parse troncast facets output
 * Format: [[TAddr1 [0xsel1 0xsel2]] [TAddr2 [0xsel3]]]
 */
export function parseTroncastFacetsOutput(
  output: string
): Array<[string, string[]]> {
  // Remove outer brackets and clean up the string
  const cleaned = output.trim().slice(1, -1)

  // Regular expression to match [address [selectors]]
  const facetRegex = /\[([T][A-Za-z0-9]{33})\s+\[((?:0x[a-fA-F0-9]+\s*)*)\]\]/g
  const facets: Array<[string, string[]]> = []

  let match
  while ((match = facetRegex.exec(cleaned)) !== null) {
    const address = match[1] || ''
    const selectorsStr = match[2]?.trim() || ''
    const selectors = selectorsStr ? selectorsStr.split(/\s+/) : []
    if (address) facets.push([address, selectors])
  }

  return facets
}
