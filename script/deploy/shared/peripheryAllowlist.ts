/**
 * Which selectors a diamond-called periphery contract needs on the diamond's allowlist, and
 * whether one address has them.
 *
 * Pure, so the chain-side health check and a sign-time gate over a `registerPeripheryContract`
 * answer the same question from the same config the same way. The caller owns the reads.
 */
import type { Hex } from 'viem'

import { assertScopeContractsEligible } from '../../common/whitelistScope'

const SELECTOR_PATTERN = /^0x[0-9a-f]{8}$/

/** `config/global.json` → `whitelistPeripheryFunctions` and `whitelistPeripheryNetworks`, validated. */
export interface IPeripheryAllowlistRequirements {
  /** Contract name → deduplicated lowercased selectors, in config order. */
  selectors: ReadonlyMap<string, readonly Hex[]>
  /** Contract name → lowercased networks it is allowlisted on; absent = every network. */
  networkScope: ReadonlyMap<string, ReadonlySet<string>>
}

/** What one contract needs on one network. */
export type PeripheryAllowlistRequirement =
  | { kind: 'required'; selectors: readonly Hex[] }
  /** Diamond-called, but deliberately not allowlisted on this network. */
  | { kind: 'out-of-scope' }
  /** Not diamond-called: nothing to allowlist. */
  | { kind: 'not-diamond-called' }

/** One `isContractSelectorWhitelisted` answer, or why it could not be read. */
export type SelectorAllowlistRead = boolean | { failed: string }

/** Outcome of checking one address against one contract's requirement. */
export interface IPeripheryAllowlistVerdict {
  /** True only when every required selector read true and at least one is required. */
  allowlisted: boolean
  /** Selectors the chain answered `false` for. */
  missing: Hex[]
  /** Selectors with no usable answer; never counted as allowlisted. */
  undetermined: Array<{ selector: Hex; reason: string }>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parse and validate the two config sections the requirement is built from.
 *
 * @remarks A contract listed with no selectors, or with one that is not four bytes, would make
 *   the check vacuously pass for it, and a scope entry naming an unknown contract or holding a
 *   non-string network would silently widen or narrow it, so any of these refuses the whole
 *   config.
 * @param functions - the raw `whitelistPeripheryFunctions` value
 * @param networks - the raw `whitelistPeripheryNetworks` value; undefined = nothing is scoped
 * @returns the validated requirements
 * @throws when either section is malformed
 */
export function parsePeripheryAllowlistRequirements(
  functions: unknown,
  networks?: unknown
): IPeripheryAllowlistRequirements {
  if (!isPlainObject(functions))
    throw new Error(
      'whitelistPeripheryFunctions must be an object keyed by contract name'
    )

  const selectors = new Map<string, Hex[]>()
  for (const [name, entries] of Object.entries(functions)) {
    if (!Array.isArray(entries) || entries.length === 0)
      throw new Error(
        `whitelistPeripheryFunctions.${name} must list at least one selector`
      )
    const unique = new Set<Hex>()
    entries.forEach((entry: unknown, index) => {
      const selector = isPlainObject(entry) ? entry.selector : undefined
      if (
        typeof selector !== 'string' ||
        !SELECTOR_PATTERN.test(selector.toLowerCase())
      )
        throw new Error(
          `whitelistPeripheryFunctions.${name}[${index}].selector is not a 4-byte selector`
        )
      unique.add(selector.toLowerCase() as Hex)
    })
    selectors.set(name, [...unique])
  }

  const networkScope = new Map<string, Set<string>>()
  if (networks !== undefined) {
    if (!isPlainObject(networks))
      throw new Error(
        'whitelistPeripheryNetworks must be an object keyed by contract name'
      )
    const scope: Record<string, string[]> = {}
    for (const [name, list] of Object.entries(networks)) {
      if (
        !Array.isArray(list) ||
        !list.every((network) => typeof network === 'string')
      )
        throw new Error(
          `whitelistPeripheryNetworks.${name} must be a list of network names`
        )
      scope[name] = list as string[]
      networkScope.set(
        name,
        new Set((list as string[]).map((network) => network.toLowerCase()))
      )
    }
    assertScopeContractsEligible(scope, selectors.keys())
  }

  return { selectors, networkScope }
}

/**
 * What a contract needs allowlisted on one network.
 *
 * @param requirements - from {@link parsePeripheryAllowlistRequirements}
 * @param contractName - the PeripheryRegistry name
 * @param networkLower - the network key, any case
 * @returns the selectors to require, or why none are required here
 */
export function peripheryAllowlistRequirementOn(
  requirements: IPeripheryAllowlistRequirements,
  contractName: string,
  networkLower: string
): PeripheryAllowlistRequirement {
  const selectors = requirements.selectors.get(contractName)
  if (!selectors) return { kind: 'not-diamond-called' }
  const scope = requirements.networkScope.get(contractName)
  if (scope && !scope.has(networkLower.toLowerCase()))
    return { kind: 'out-of-scope' }
  return { kind: 'required', selectors }
}

/**
 * Decide whether an address has every required selector allowlisted.
 *
 * @param required - the contract's required selectors
 * @param reads - selector → the chain's answer for the address under test
 * @returns the verdict; a selector absent from `reads` is undetermined
 */
export function evaluatePeripheryAllowlist(
  required: readonly Hex[],
  reads: ReadonlyMap<Hex, SelectorAllowlistRead>
): IPeripheryAllowlistVerdict {
  const byLowercase = new Map<string, SelectorAllowlistRead>()
  for (const [selector, read] of reads)
    byLowercase.set(selector.toLowerCase(), read)

  const missing: Hex[] = []
  const undetermined: IPeripheryAllowlistVerdict['undetermined'] = []
  let confirmed = 0
  for (const selector of required) {
    const read = byLowercase.get(selector.toLowerCase())
    if (read === true) confirmed++
    else if (read === false) missing.push(selector)
    else
      undetermined.push({
        selector,
        reason: read === undefined ? 'not read' : read.failed,
      })
  }
  return {
    allowlisted: required.length > 0 && confirmed === required.length,
    missing,
    undetermined,
  }
}
