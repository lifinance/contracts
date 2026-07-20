/**
 * Guards the single source of truth for LayerZero endpoint IDs
 * (`config/layerzero.json`) against drift:
 *   1. the generated `mappings` in frax.json / superset.json match what
 *      `tasks/syncLayerZeroEids.ts` would produce, and
 *   2. the EIDs hardcoded in `AcrossV4SwapFacet._chainIdToLzEid` agree with it.
 *
 * This is what makes layerzero.json authoritative: any facet that carries its own
 * copy of an EID must match here, so a wrong/stale value (the class of bug this
 * file was introduced to kill) fails in CI instead of on-chain.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildMappings,
  CONSUMERS,
  getEids,
  readJson,
} from '../../tasks/syncLayerZeroEids'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LIFI_CHAIN_ID_SOLANA = '1151111081099710'

describe('layerzero.json is the single source of truth for EIDs', () => {
  const eids = getEids()
  const networks =
    readJson<Record<string, { chainId: number }>>('networks.json')

  it.each(CONSUMERS)(
    '$file mappings are in sync with layerzero.json',
    ({ file, networksKey }) => {
      const facetConfig = readJson<Record<string, unknown>>(file)
      const expected = buildMappings(networksKey, facetConfig, networks, eids)
      expect(facetConfig.mappings).toEqual(expected)
    }
  )

  it('AcrossV4SwapFacet hardcoded EIDs match layerzero.json', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'src/Facets/AcrossV4SwapFacet.sol'),
      'utf8'
    )
    const body = source.slice(source.indexOf('function _chainIdToLzEid'))

    // numeric `if (_chainId == <id>) return <eid>;` entries
    const numeric = [...body.matchAll(/_chainId == (\d+)\) return (\d+);/g)]
    expect(numeric.length).toBeGreaterThan(0)
    for (const m of numeric) {
      const chainId = m[1]
      const eid = m[2]
      if (!chainId || !eid) continue
      expect(`${chainId}:${eids[chainId]}`).toBe(`${chainId}:${Number(eid)}`)
    }

    // the Solana entry uses the LIFI_CHAIN_ID_SOLANA constant, not a literal
    const solana = body.match(/LIFI_CHAIN_ID_SOLANA\) return (\d+);/)
    if (!solana)
      throw new Error(
        'Solana EID not found in AcrossV4SwapFacet._chainIdToLzEid'
      )
    expect(eids[LIFI_CHAIN_ID_SOLANA]).toBe(Number(solana[1]))
  })
})
