/**
 * Production deploy gate, evaluated in the Safe proposal funnel.
 *
 * Every Safe proposal passes through `propose-to-safe.ts` (EVM) or
 * `propose-to-safe-tron.ts` (Tron), so gating there covers a new caller without
 * anyone remembering to add it — which the previous homes, one shell task and one
 * TS proposer, could not. The price is that the funnel is handed calldata rather
 * than facet names, so the facet set has to be recovered from the cut itself.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { consola } from 'consola'
import {
  decodeFunctionData,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { isTestnetNetwork } from '../../utils/viemScriptHelpers'
import { verifyDeployGateForRepo } from '../github/verify-approvals'
import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_SCHEDULE_BATCH_SELECTOR,
} from '../safe/timelock-abi'

import { DIAMOND_CUT_ABI } from './constants'

const DIAMOND_CUT_SELECTOR = toFunctionSelector(
  'diamondCut((address,uint8,bytes4[])[],address,bytes)'
)

/**
 * `LibDiamond.FacetCutAction`: Add=0, Replace=1, Remove=2. Only the first two
 * point the diamond at new code, so only they have something to compare against
 * `main`; a Remove cut carries the zero address and is deliberately out of scope.
 */
const INSTALLING_ACTIONS = new Set([0, 1])

/**
 * How many `scheduleBatch` layers to unwrap. The funnel wraps a cut itself, so a
 * caller handing in a pre-wrapped payload is the shape this has to see through;
 * the bound stops a self-referential payload from spinning.
 */
const MAX_UNWRAP_DEPTH = 4

/** What a proposal's calls turned out to contain. */
export interface IInstalledFacets {
  /** Checksummed facet addresses the cut installs, in first-seen order. */
  addresses: Address[]
  /**
   * Indices of calls that carry a gated selector but could not be decoded.
   * Reported rather than skipped: an undecodable cut is a cut we cannot vouch
   * for, and calldata is written by the proposer.
   */
  undecodable: number[]
}

const decodeCut = (
  data: Hex
): readonly { facetAddress: Address; action: number }[] => {
  const { args } = decodeFunctionData({ abi: DIAMOND_CUT_ABI, data })
  return args[0] as readonly { facetAddress: Address; action: number }[]
}

const decodeScheduleBatch = (data: Hex): readonly Hex[] => {
  const { args } = decodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    data,
  })
  return args[2] as readonly Hex[]
}

/**
 * Recovers the facet addresses a proposal's calls would install, unwrapping any
 * timelock `scheduleBatch` on the way down.
 * @param calldatas - the proposal's calls, in the order they were passed
 * @returns installing facet addresses, plus the indices of calls that carry a
 * gated selector but did not decode
 */
export const collectInstalledFacetAddresses = (
  calldatas: readonly Hex[]
): IInstalledFacets => {
  const seen = new Map<string, Address>()
  const undecodable: number[] = []

  const walk = (data: Hex, index: number, depth: number): void => {
    const selector = data.slice(0, 10).toLowerCase()

    if (selector === DIAMOND_CUT_SELECTOR.toLowerCase()) {
      let cuts
      try {
        cuts = decodeCut(data)
      } catch {
        undecodable.push(index)
        return
      }
      for (const entry of cuts) {
        if (!INSTALLING_ACTIONS.has(Number(entry.action))) continue
        const address = getAddress(entry.facetAddress)
        if (!seen.has(address.toLowerCase()))
          seen.set(address.toLowerCase(), address)
      }
      return
    }

    if (selector === TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()) {
      if (depth >= MAX_UNWRAP_DEPTH) {
        undecodable.push(index)
        return
      }
      let payloads
      try {
        payloads = decodeScheduleBatch(data)
      } catch {
        undecodable.push(index)
        return
      }
      for (const payload of payloads) walk(payload, index, depth + 1)
    }
  }

  calldatas.forEach((data, index) => walk(data, index, 0))

  return {
    addresses: [...seen.values()],
    undecodable: [...new Set(undecodable)],
  }
}

/**
 * Decides whether the funnel is proposing for production.
 *
 * Deliberately not `getEnvironment()`, which reads only `PRODUCTION` and would
 * skip the gate for `multiNetworkExecution.sh`, whose exported
 * `ENVIRONMENT=production` is the only signal it sets. The shell gate this
 * replaces matched `ENVIRONMENT != "staging"`, so an unset environment has to
 * mean production here too — and does anyway, because the funnel signs with
 * `PRIVATE_KEY_PRODUCTION` whatever the environment says.
 * @param env - process environment to read
 */
export const resolveGateEnvironment = (
  env: Record<string, string | undefined>
): EnvironmentEnum =>
  env.ENVIRONMENT === EnvironmentEnum.staging
    ? EnvironmentEnum.staging
    : EnvironmentEnum.production

/** Lookups the funnel gate needs, injectable so the policy is testable. */
export interface IFunnelGateDeps {
  environment: () => EnvironmentEnum
  isTestnet: (network: string) => boolean
  currentBranch: () => string
  /** lowercase address → deployed contract name, for the network's production log */
  deployedNames: (network: string) => Promise<Map<string, string>>
  facetSourceExists: (name: string) => boolean
  runGate: (input: {
    environment: EnvironmentEnum
    branch: string
    facets: string[]
  }) => Promise<string[]>
}

/**
 * Applies the production deploy gate to a proposal about to be signed.
 *
 * Ordered before the signature, the Safe client and Mongo, so a refusal costs
 * the operator a second and leaves nothing behind — the facet itself is already
 * deployed by the time a cut is proposed, and a contract nobody cut in is inert.
 * @param input - the network and the proposal's calls
 * @param deps - git / deployments / gate lookups
 * @throws If a call installs code this checkout cannot vouch for, or the gate rejects
 */
export const assertFunnelDeployGate = async (
  input: { network: string; calldatas: readonly Hex[] },
  deps: IFunnelGateDeps
): Promise<void> => {
  if (deps.environment() !== EnvironmentEnum.production) return
  // testnets carry no production Safe and are where an unmerged facet is
  // validated before its audit, matching the exemption the shell gate had
  if (deps.isTestnet(input.network)) return

  const { addresses, undecodable } = collectInstalledFacetAddresses(
    input.calldatas
  )

  if (undecodable.length > 0)
    throw new Error(
      `Production deploy gate: call ${undecodable.join(
        ', '
      )} carries a diamondCut or timelock scheduleBatch selector whose arguments could not be decoded, so the facets it installs cannot be checked. Re-encode the call, or propose it from a checkout whose facet sources match origin/main.`
    )

  // Nothing installs facet code (ownership transfers, whitelist updates, facet
  // removals), so there is nothing to compare and an empty facet list would make
  // the gate itself fail closed.
  if (addresses.length === 0) return

  const deployed = await deps.deployedNames(input.network)

  const facets: string[] = []
  const unattributable: string[] = []
  for (const address of addresses) {
    const name = deployed.get(address.toLowerCase())
    if (name === undefined) {
      unattributable.push(
        `${address} is not recorded in the production deployments for ${input.network}`
      )
      continue
    }
    if (!deps.facetSourceExists(name)) {
      unattributable.push(
        `${address} resolves to ${name}, which has no facet source at src/Facets/${name}.sol`
      )
      continue
    }
    if (!facets.includes(name)) facets.push(name)
  }

  if (unattributable.length > 0)
    throw new Error(
      `Production deploy gate: the cut installs code this checkout cannot attribute to a facet, so main-equivalence cannot be judged:\n  - ${unattributable.join(
        '\n  - '
      )}`
    )

  const branch = deps.currentBranch()
  const failures = await deps.runGate({
    environment: EnvironmentEnum.production,
    branch,
    facets,
  })

  if (failures.length > 0)
    throw new Error(
      `Production deploy gate failed for branch "${branch}" - aborting before anything is proposed to the Safe:\n  - ${failures.join(
        '\n  - '
      )}`
    )

  consola.info(`Production deploy gate passed (${facets.join(', ')})`)
}

/**
 * Reads an address as a 20-byte EVM hex address, or returns undefined when the
 * value is not one. The default for EVM deployment logs, which already store
 * that form.
 * @param value - deployment-log value to interpret
 */
export const evmHexAddress = (value: string): string | undefined =>
  /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : undefined

/**
 * Inverts a deployment log into EVM-hex address → contract name.
 *
 * `toEvmHex` exists because a cut's calldata always carries 20-byte hex
 * addresses while the log does not: Tron's log stores base58, so its funnel has
 * to supply the conversion or every Tron facet would look unattributable.
 * @param entries - deployment log, contract name → address
 * @param toEvmHex - reads a log value as a lowercase 20-byte hex address
 */
export const indexDeploymentsByAddress = (
  entries: Record<string, unknown>,
  toEvmHex: (value: string) => string | undefined = evmHexAddress
): Map<string, string> => {
  const byAddress = new Map<string, string>()
  for (const [name, value] of Object.entries(entries)) {
    if (name === 'default' || typeof value !== 'string') continue
    const address = toEvmHex(value)
    if (address === undefined) continue
    // first entry wins, so a later alias cannot rename the contract it points at
    if (!byAddress.has(address)) byAddress.set(address, name)
  }
  return byAddress
}

/**
 * Wires the funnel gate to the real checkout.
 *
 * Always reads the production deployment log: a cut reaching a Safe installs
 * production code, and a staging log would attribute an address to a name whose
 * source has nothing to do with what is being installed.
 * @param options.repoRoot - repository root whose working tree is compared against `main`
 * @param options.toEvmHex - address reader for this network's log (Tron passes base58)
 */
export const createFunnelGateDeps = (
  options: {
    repoRoot?: string
    toEvmHex?: (value: string) => string | undefined
  } = {}
): IFunnelGateDeps => {
  const repoRoot = options.repoRoot ?? process.cwd()
  return {
    environment: () => resolveGateEnvironment(process.env),
    isTestnet: isTestnetNetwork,
    currentBranch: () =>
      execFileSync('git', ['branch', '--show-current'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim(),
    deployedNames: async (network) => {
      const deployments = await getDeployments(
        network as SupportedChain,
        EnvironmentEnum.production
      )
      // JSON modules expose the log under `default` in Node ESM and inline it in
      // Bun; reading both keeps the map populated under either loader
      return indexDeploymentsByAddress(
        deployments.default ?? deployments,
        options.toEvmHex
      )
    },
    facetSourceExists: (name) =>
      existsSync(join(repoRoot, 'src', 'Facets', `${name}.sol`)),
    runGate: (gateInput) => verifyDeployGateForRepo(gateInput, repoRoot),
  }
}
