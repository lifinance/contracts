/**
 * `config/global.json` → `attestableSelectors`: the bridge entrypoints `AttestedBridgeFacet` is
 * expected to dispatch, and the networks where that set is enabled.
 *
 * Pure: used by the health check, the Safe signer view and the config tests, which own the reads.
 */
import { type Hex, toFunctionSelector } from 'viem'

import { addressesMatch } from './immutableBindings'

const SELECTOR_PATTERN = /^0x[0-9a-f]{8}$/
const FACET_FUNCTION_PATTERN =
  /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*\(.*\))$/

/** One expected attestable selector: the facet it belongs to and its canonical signature. */
export interface IAttestableSelector {
  facet: string
  signature: string
}

/** `attestableSelectors`, validated. */
export interface IAttestableSelectorsConfig {
  /** Lowercased networks where every listed selector is expected to be enabled. */
  networks: ReadonlySet<string>
  /** Lowercased selector → its facet and signature, in config order. */
  selectors: ReadonlyMap<Hex, IAttestableSelector>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate the `attestableSelectors` block.
 *
 * @param raw - the value of `attestableSelectors` in `config/global.json`
 * @returns the networks and the selector → facet signature map
 * @throws Error naming the offending entry when the block is malformed, or when a signature does
 *   not hash to the selector it is listed under
 */
export function parseAttestableSelectors(
  raw: unknown
): IAttestableSelectorsConfig {
  if (!isPlainObject(raw))
    throw new Error('attestableSelectors must be an object')

  const { networks, selectors } = raw
  if (
    !Array.isArray(networks) ||
    !networks.every((network) => typeof network === 'string')
  )
    throw new Error('attestableSelectors.networks must be an array of strings')
  if (!isPlainObject(selectors))
    throw new Error(
      'attestableSelectors.selectors must be an object keyed by selector'
    )

  const parsed = new Map<Hex, IAttestableSelector>()
  for (const [key, value] of Object.entries(selectors)) {
    if (!SELECTOR_PATTERN.test(key))
      throw new Error(
        `attestableSelectors.selectors: "${key}" is not a lowercase 4-byte selector`
      )
    const match =
      typeof value === 'string' ? FACET_FUNCTION_PATTERN.exec(value) : null
    if (!match?.[1] || !match[2])
      throw new Error(
        `attestableSelectors.selectors.${key} must read "<Facet>.<signature>"`
      )
    const [, facet, signature] = match
    const actual = toFunctionSelector(signature)
    if (actual !== key)
      throw new Error(
        `attestableSelectors.selectors.${key}: ${signature} hashes to ${actual}`
      )
    parsed.set(key as Hex, { facet, signature })
  }

  return {
    networks: new Set(networks.map((network) => network.toLowerCase())),
    selectors: parsed,
  }
}

/** What one network's diamond reported, for {@link evaluateAttestableSelectors}. */
export interface IAttestableSelectorState {
  /** The selectors config expects enabled here; empty on a network config does not list. */
  expected: ReadonlyMap<Hex, IAttestableSelector>
  /** `isAttestableSelector` for every probed selector: each routed one and each expected one. */
  enabled: ReadonlyMap<Hex, boolean>
  /** Selector → the facet address the diamond routes it to; absent when nothing routes it. */
  routedTo: ReadonlyMap<Hex, string>
  /** Contract name → address, from the network's flat deploy log. */
  deployedContracts: Readonly<Record<string, string>>
}

/** Findings for one network: errors fail the check, warnings flag a rollout still pending. */
export interface IAttestableSelectorFindings {
  errors: string[]
  warnings: string[]
}

/**
 * Compare the diamond's attestable selectors with config.
 *
 * An enabled selector must be listed and must route to the address the deploy log records for its
 * facet: a facet cut since review, or a signature change that left the old flag set, both show up
 * here. A listed selector that is not enabled yet is only a warning, since config is merged before
 * the timelocked `setAttestableSelector` executes.
 *
 * @param state - the network's expectation and what its diamond reported
 * @returns the errors and warnings to report, empty when the diamond matches config
 */
export function evaluateAttestableSelectors(
  state: IAttestableSelectorState
): IAttestableSelectorFindings {
  const findings: IAttestableSelectorFindings = { errors: [], warnings: [] }
  for (const [selector, isEnabled] of state.enabled) {
    const entry = state.expected.get(selector)
    const route = state.routedTo.get(selector)
    if (!entry) {
      if (!isEnabled) continue
      findings.errors.push(
        route
          ? `${selector} is attestable but not listed in attestableSelectors for this network`
          : `${selector} is attestable but no facet routes it: a stale flag`
      )
      continue
    }

    const name = `${selector} (${entry.facet}.${entry.signature})`
    if (!isEnabled) {
      findings.warnings.push(`${name} is listed but not attestable yet`)
      continue
    }
    const deployed = state.deployedContracts[entry.facet]
    if (!route)
      findings.errors.push(
        `${name} is attestable but no facet routes it: the facet no longer has this signature`
      )
    else if (!deployed)
      findings.errors.push(
        `${name} is attestable but the deploy log has no ${entry.facet} to compare its route with`
      )
    else if (!addressesMatch(route, deployed))
      findings.errors.push(
        `${name} routes to ${route}, not to ${entry.facet} at ${deployed}`
      )
  }
  return findings
}
