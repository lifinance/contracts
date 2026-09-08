/**
 * Decides whether a Safe deployment may proceed and whether the Safe it
 * produced matches repo config.
 *
 * Imported by `deploy-safe.ts`. The three decisions are pure so each refusal
 * can be exercised against the committed `config/global.json` and
 * `config/networks.json` without running a deployment.
 */

import { SAFE_THRESHOLD } from '../shared/constants'

/** Whether a deployment may replace the Safe address config already names. */
export interface ISafeOverrideVerdict {
  /** Whether config already names a non-zero Safe for this network. */
  occupied: boolean
  allowed: boolean
  /** Set exactly when `allowed` is false. */
  refusal?: string
}

/** Whether a threshold clears the fleet-wide floor. */
export interface ISafeThresholdVerdict {
  allowed: boolean
  floor: number
  /** Set exactly when `allowed` is false. */
  refusal?: string
}

/** How a deployed owner set relates to the one config declares. */
export interface IOwnerSetComparison {
  matchesConfig: boolean
  /** Configured owners the deployed Safe does not have, lowercase. */
  absent: string[]
  /** Deployed owners config does not declare, lowercase. */
  beyondConfig: string[]
}

const isZeroAddress = (address: string): boolean =>
  /^0x0{40}$/i.test(address.trim())

/**
 * Judges a deployment against the Safe address config already names.
 * @param input.network - target network name, named in the refusal
 * @param input.existing - `safeAddress` config currently names, if any
 * @param input.allowOverride - whether the operator asked to replace it
 * @returns Whether config is occupied and whether the deployment may proceed
 */
export const evaluateSafeAddressOverride = (input: {
  network: string
  existing?: string
  allowOverride: boolean
}): ISafeOverrideVerdict => {
  const occupied =
    typeof input.existing === 'string' &&
    input.existing.length > 0 &&
    !isZeroAddress(input.existing)

  if (!occupied || input.allowOverride) return { occupied, allowed: true }

  return {
    occupied,
    allowed: false,
    refusal: `${input.network} already has a Safe at ${input.existing}. Deploying another one and repointing config/networks.json at it moves governance of every contract this Safe owns to a Safe nobody has reviewed. Pass --allowOverride to state that this is what you intend.`,
  }
}

/**
 * Judges a threshold against {@link SAFE_THRESHOLD}.
 *
 * Testnets are exempt: they carry no Safe at all in committed config, their
 * diamonds are EOA-owned, and a Safe brought up there is a rehearsal that no
 * production contract obeys.
 * @param input.network - target network name, named in the refusal
 * @param input.threshold - confirmations the deployment would set
 * @param input.isTestnet - whether config types this network as a testnet
 * @returns Whether the threshold is allowed, and the floor it is judged against
 */
export const evaluateSafeThresholdFloor = (input: {
  network: string
  threshold: number
  isTestnet: boolean
}): ISafeThresholdVerdict => {
  const floor = input.isTestnet ? 1 : SAFE_THRESHOLD

  if (input.threshold >= floor) return { allowed: true, floor }

  return {
    allowed: false,
    floor,
    refusal: `--threshold ${input.threshold} is below the ${floor} confirmations required on ${input.network}. A Safe deployed under the floor can act on fewer signatures than the fleet's governance assumes.`,
  }
}

/**
 * Relates a deployed owner set to the one config declares.
 *
 * Comparison is by lowercase address, so a checksum difference between an
 * on-chain read and config is not divergence.
 * @param configured - owners `config/global.json` declares
 * @param deployed - owners the Safe reports
 * @returns The two directions of difference, each empty on a match
 */
export const compareOwnerSets = (
  configured: readonly string[],
  deployed: readonly string[]
): IOwnerSetComparison => {
  const configuredSet = new Set(configured.map((o) => o.trim().toLowerCase()))
  const deployedSet = new Set(deployed.map((o) => o.trim().toLowerCase()))

  const absent = [...configuredSet].filter((o) => !deployedSet.has(o))
  const beyondConfig = [...deployedSet].filter((o) => !configuredSet.has(o))

  return {
    matchesConfig: absent.length === 0 && beyondConfig.length === 0,
    absent,
    beyondConfig,
  }
}

/**
 * Renders an owner set that diverges from config as lines an operator reading a
 * deploy log cannot skim past.
 * @param input.network - network the Safe was deployed on
 * @param input.safeAddress - Safe whose owners were read
 * @param input.comparison - result of {@link compareOwnerSets}
 * @returns One line per finding, empty when the owner set matches config
 */
export const describeOwnerSetDivergence = (input: {
  network: string
  safeAddress: string
  comparison: IOwnerSetComparison
}): string[] => {
  if (input.comparison.matchesConfig) return []

  const lines = [
    `Owner set of the Safe deployed on ${input.network} (${input.safeAddress}) does not match config/global.json safeOwners.`,
  ]
  if (input.comparison.beyondConfig.length)
    lines.push(
      `  • Owners config does not declare: ${input.comparison.beyondConfig.join(
        ', '
      )}`
    )
  if (input.comparison.absent.length)
    lines.push(
      `  • Configured owners this Safe does not have: ${input.comparison.absent.join(
        ', '
      )}`
    )
  lines.push(
    'Treat this as a deliberate override: it is only correct if you meant to deploy a Safe whose owners differ from the fleet configuration.'
  )

  return lines
}

/**
 * Applies {@link evaluateSafeAddressOverride} before anything is deployed.
 * @param input - network, the Safe address config names, and the operator's flag
 * @returns The verdict, so the caller can see whether config names a Safe
 * @throws If config names a Safe and the override is not stated
 */
export const assertSafeAddressOverrideAllowed = (input: {
  network: string
  existing?: string
  allowOverride: boolean
}): ISafeOverrideVerdict => {
  const verdict = evaluateSafeAddressOverride(input)
  if (!verdict.allowed) throw new Error(verdict.refusal)
  return verdict
}

/**
 * Applies {@link evaluateSafeThresholdFloor} before anything is deployed.
 * @param input - network, requested threshold, and whether it is a testnet
 * @returns The verdict, so the caller can report the floor it cleared
 * @throws If the threshold is below the floor for this network
 */
export const assertSafeThresholdFloor = (input: {
  network: string
  threshold: number
  isTestnet: boolean
}): ISafeThresholdVerdict => {
  const verdict = evaluateSafeThresholdFloor(input)
  if (!verdict.allowed) throw new Error(verdict.refusal)
  return verdict
}
