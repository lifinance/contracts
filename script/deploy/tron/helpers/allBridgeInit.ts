/**
 * AllBridgeFacet post-cut initializer encoder (Tron).
 *
 * The TS/Tron deploy path has no equivalent of the Foundry update scripts, so
 * this mirrors `script/deploy/facets/UpdateAllBridgeFacet.s.sol` — both
 * `getCallData()` (encode `initAllBridge` from `config/allbridge.json`'s
 * `mappings`) and `getExcludes()` (keep `initAllBridge` off the diamond).
 *
 * Without this the facet would land on the Tron diamond with
 * `chainMappingsInitialized == false`, and every
 * `startBridgeTokensViaAllBridge` from Tron would revert
 * `UnsupportedAllBridgeChainId`. It is not repairable afterwards:
 * `setChainIdToAllBridgeChainId` itself reverts `NotInitialized`, so only the
 * owner-only `initAllBridge` can bootstrap the storage.
 *
 * Pure and dependency-free (no TronWeb, no filesystem) so it is unit-testable.
 */
import { encodeFunctionData, toFunctionSelector, type Hex } from 'viem'

/** Minimal ABI for `AllBridgeFacet.initAllBridge(ChainIdConfig[])`. */
export const ALLBRIDGE_INIT_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'chainId', type: 'uint256' },
          { name: 'allBridgeChainId', type: 'uint256' },
        ],
        name: 'chainIdConfigs',
        type: 'tuple[]',
      },
    ],
    name: 'initAllBridge',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/**
 * Selector of `initAllBridge(ChainIdConfig[])`, excluded from the registered
 * selectors exactly as `UpdateAllBridgeFacet.getExcludes()` does on EVM: the
 * diamond delegatecalls it once during the cut, and leaving it reachable
 * through the diamond afterwards would diverge from every EVM deployment.
 */
export const ALLBRIDGE_INIT_SELECTOR = toFunctionSelector(
  'initAllBridge((uint256,uint256)[])'
)

export interface IAllBridgeChainIdConfig {
  readonly chainId: bigint
  readonly allBridgeChainId: bigint
}

/** Id fields read from the JSON source text rather than the parsed double. */
const ID_FIELDS = new Set(['chainId', 'allBridgeChainId'])

/**
 * Parses the config file, reviving the chain-id fields straight from their JSON
 * source text.
 *
 * LI.FI's synthetic non-EVM chain ids reach past IEEE-754 exact-integer range —
 * `config/allbridge.json` already carries 9270000000000000, above
 * `Number.MAX_SAFE_INTEGER` — so `JSON.parse` alone would hand back a double
 * that is not guaranteed to equal what the file says. The Foundry path
 * has no such hazard — `stdJson.parseRaw` decodes straight to `uint256`. The
 * third reviver argument (`context.source`) carries the untouched number
 * literal, so `BigInt` conversion is exact; it also rejects fractional ids for
 * free, since `BigInt('1.5')` throws.
 */
function parseConfigWithBigIntIds(configJson: string): unknown {
  return JSON.parse(
    configJson,
    // The 3-argument reviver (ES2025 JSON.parse source access) is not in the
    // TS lib types yet, hence the casts
    ((key: string, value: unknown, context?: { source?: string }): unknown => {
      if (typeof value !== 'number' || !ID_FIELDS.has(key)) return value

      if (context?.source === undefined)
        throw new Error(
          `Cannot read "${key}" without precision loss: this runtime's JSON.parse does not expose the number source text`
        )

      try {
        return BigInt(context.source)
      } catch {
        throw new Error(`"${key}" must be an integer, got ${context.source}`)
      }
    }) as unknown as (key: string, value: unknown) => unknown
  )
}

/**
 * Validates and normalizes the `mappings` array of `config/allbridge.json`.
 *
 * Mirrors the on-chain guards in `initAllBridge`: it rejects an empty array and
 * any zero id (0 is the reserved "unmapped" sentinel in the facet's storage).
 * Failing here costs nothing; the same input reaching the chain would revert
 * `InvalidConfig` only after signing and the full timelock delay.
 *
 * @param configJson - Raw text of `config/allbridge.json`
 * @returns Chain-id configs in file order, as bigints
 * @throws If `mappings` is missing/empty, an entry is malformed, an id is
 *   absent, non-integral or zero, or a `chainId` appears twice
 */
export function parseAllBridgeMappings(
  configJson: string
): IAllBridgeChainIdConfig[] {
  const config = parseConfigWithBigIntIds(configJson)

  const mappings =
    typeof config === 'object' && config !== null
      ? (config as Record<string, unknown>).mappings
      : undefined

  if (!Array.isArray(mappings) || mappings.length === 0)
    throw new Error(
      'config/allbridge.json has no non-empty "mappings" array — AllBridgeFacet v2.2.0+ seeds its chain-id mappings from it (added in lifinance/contracts#2075). Is this checkout on a main that includes it?'
    )

  const seen = new Set<bigint>()

  return mappings.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`mappings[${i}] is not an object`)

    const { chainId, allBridgeChainId } = entry as Record<string, unknown>

    const toId = (value: unknown, field: string): bigint => {
      if (typeof value !== 'bigint')
        throw new Error(
          `mappings[${i}].${field} must be a JSON number, got ${JSON.stringify(
            value
          )}`
        )
      if (value <= 0n)
        throw new Error(
          `mappings[${i}].${field} must be > 0 (0 is the reserved "unmapped" sentinel), got ${value}`
        )
      return value
    }

    const mapping = {
      chainId: toId(chainId, 'chainId'),
      allBridgeChainId: toId(allBridgeChainId, 'allBridgeChainId'),
    }

    // A duplicate chainId means the later entry silently wins on-chain, so the
    // deployed mapping would not match what a reviewer reads in the config
    if (seen.has(mapping.chainId))
      throw new Error(`mappings[${i}].chainId ${mapping.chainId} is duplicated`)
    seen.add(mapping.chainId)

    return mapping
  })
}

/**
 * Encodes the `initAllBridge` call passed as the diamondCut's init calldata.
 *
 * @param mappings - Chain-id configs from {@link parseAllBridgeMappings}
 * @returns Encoded `initAllBridge(ChainIdConfig[])` calldata
 */
export function encodeAllBridgeInitCalldata(
  mappings: IAllBridgeChainIdConfig[]
): Hex {
  if (mappings.length === 0)
    throw new Error('Cannot encode initAllBridge with zero mappings')

  return encodeFunctionData({
    abi: ALLBRIDGE_INIT_ABI,
    functionName: 'initAllBridge',
    args: [mappings],
  })
}
