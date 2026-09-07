/**
 * Production deploy gate for Safe proposals: recovers the facets a proposal's
 * calldata would install and refuses the ones this checkout cannot vouch for.
 *
 * Imported by the proposal funnels — `propose-to-safe.ts` and
 * `propose-to-safe-tron.ts` — and by the TypeScript `sendOrPropose`
 * (`script/safe/safeScriptHelpers.ts`), which signs without either funnel.
 * `docs/MultisigSigningProcess.md` §4.2 records which propose paths reach it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { consola } from 'consola'
import {
  decodeFunctionData,
  getAddress,
  parseAbi,
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

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'

const DIAMOND_CUT_SELECTOR = toFunctionSelector(
  'diamondCut((address,uint8,bytes4[])[],address,bytes)'
).toLowerCase() as Hex

/**
 * `LiFiTimelockController` inherits OpenZeppelin's `TimelockController`, so the
 * singular `schedule` is callable by the Safe even though this repo's tooling
 * only ever emits `scheduleBatch`. Left undecoded it was a way to hand the
 * funnel a cut it could not see.
 */
const TIMELOCK_SCHEDULE_ABI = parseAbi([
  'function schedule(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt, uint256 delay)',
])

const TIMELOCK_SCHEDULE_SELECTOR = toFunctionSelector(
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)'
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
  /**
   * Checksummed addresses whose code the cut would run, in first-seen order:
   * the facets it installs, plus a non-zero `_init` delegatecall target.
   */
  addresses: Address[]
  /**
   * Indices of calls carrying a gated selector this cannot see all the way
   * through — arguments that do not decode, or `scheduleBatch` nested past
   * {@link MAX_UNWRAP_DEPTH}. Reported rather than skipped: a cut we cannot read
   * is a cut we cannot vouch for, and calldata is written by the proposer.
   */
  undecodable: number[]
}

const decodeCut = (
  data: Hex
): {
  cuts: readonly { facetAddress: Address; action: number }[]
  init: Address
} => {
  const { args } = decodeFunctionData({ abi: DIAMOND_CUT_ABI, data })
  return {
    cuts: args[0] as readonly { facetAddress: Address; action: number }[],
    init: args[1] as Address,
  }
}

const decodeScheduleBatch = (data: Hex): readonly Hex[] => {
  const { args } = decodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    data,
  })
  return args[2] as readonly Hex[]
}

const decodeSchedule = (data: Hex): readonly Hex[] => {
  const { args } = decodeFunctionData({ abi: TIMELOCK_SCHEDULE_ABI, data })
  return [args[2] as Hex]
}

/**
 * Recovers the addresses a proposal's calls would run code from — installed
 * facets and any non-zero `_init` delegatecall target — unwrapping a timelock
 * `scheduleBatch` on the way down.
 * @param calldatas - the proposal's calls, in the order they were passed
 * @returns those addresses, plus the indices of calls this could not read
 * through
 */
export const collectInstalledFacetAddresses = (
  calldatas: readonly Hex[]
): IInstalledFacets => {
  const seen = new Map<string, Address>()
  const undecodable = new Set<number>()

  const remember = (value: Address): void => {
    const address = getAddress(value)
    if (!seen.has(address.toLowerCase()))
      seen.set(address.toLowerCase(), address)
  }

  /** @returns whether a `diamondCut` was decoded anywhere under `data` */
  const walk = (data: Hex, index: number, depth: number): boolean => {
    const selector = data.slice(0, 10).toLowerCase()

    if (selector === DIAMOND_CUT_SELECTOR) {
      let decoded
      try {
        decoded = decodeCut(data)
      } catch {
        undecodable.add(index)
        return false
      }
      for (const entry of decoded.cuts) {
        if (!INSTALLING_ACTIONS.has(Number(entry.action))) continue
        remember(entry.facetAddress)
      }
      // `_init` is delegatecalled in the diamond's context by the same
      // transaction, so its code runs against the diamond's storage exactly as a
      // facet's would. It is non-zero only when the update carries init
      // calldata, and in every current caller it is then the facet's own
      // address (`UpdateScriptBase.update` passes `_resolveFacetAddress(name)`),
      // so attributing it costs nothing legitimate. A cut whose init target is
      // some other contract is refused rather than delegatecalled unexamined.
      if (decoded.init !== ZERO_ADDRESS) remember(decoded.init)
      return true
    }

    const unwrap =
      selector === TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()
        ? decodeScheduleBatch
        : selector === TIMELOCK_SCHEDULE_SELECTOR.toLowerCase()
        ? decodeSchedule
        : undefined

    if (unwrap) {
      if (depth >= MAX_UNWRAP_DEPTH) {
        undecodable.add(index)
        return false
      }
      let payloads
      try {
        payloads = unwrap(data)
      } catch {
        undecodable.add(index)
        return false
      }
      let sawCut = false
      for (const payload of payloads)
        if (walk(payload, index, depth + 1)) sawCut = true
      return sawCut
    }

    return false
  }

  calldatas.forEach((data, index) => {
    const sawCut = walk(data, index, 0)
    // Backstop against an envelope this does not know. Only the wrappers above
    // are unwrapped, so any other one — OZ `multiSend`, a bespoke batcher —
    // would otherwise yield an empty facet set and skip the gate silently, which
    // is the bypass the unwrapping exists to prevent. If the cut selector is in
    // the bytes and no cut came out, the call is unreadable, not innocent.
    if (!sawCut && data.toLowerCase().includes(DIAMOND_CUT_SELECTOR.slice(2)))
      undecodable.add(index)
  })

  return {
    addresses: [...seen.values()],
    undecodable: [...undecodable],
  }
}

/** Lookups the funnel gate needs, injectable so the policy is testable. */
export interface IFunnelGateDeps {
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
  // There is deliberately no environment predicate here. Reaching this funnel
  // means a Safe proposal, and every path that reaches it for a non-testnet
  // network is proposing to a production Safe and signs with the production
  // signer key — a staging deploy sends straight to the diamond instead. An
  // `ENVIRONMENT` check would therefore add nothing except an ambient
  // off-switch: no production caller exports that name, so its value would come
  // from whatever happens to be in the operator's shell.
  //
  // Testnets stay exempt: they carry no production Safe, and deploying an
  // unmerged facet there is how it is validated before its audit.
  if (deps.isTestnet(input.network)) {
    consola.info(
      `Production deploy gate skipped: ${input.network} is a testnet`
    )
    return
  }

  const { addresses, undecodable } = collectInstalledFacetAddresses(
    input.calldatas
  )

  if (undecodable.length > 0)
    throw new Error(
      `Production deploy gate: call ${undecodable.join(
        ', '
      )} carries a diamondCut or timelock scheduleBatch selector this could not read to the bottom — the arguments did not decode, or the batch is nested more than ${MAX_UNWRAP_DEPTH} deep — so the facets it installs cannot be checked. Re-encode the call as a plain diamondCut and let the funnel wrap it.`
    )

  // Nothing installs facet code (ownership transfers, whitelist updates, facet
  // removals), so there is nothing to compare and an empty facet list would make
  // the gate itself fail closed. Announced rather than silent: a skip an
  // operator cannot see is indistinguishable from a gate that is not wired.
  if (addresses.length === 0) {
    consola.info(
      'Production deploy gate skipped: no call in this proposal installs facet code'
    )
    return
  }

  let deployed
  try {
    deployed = await deps.deployedNames(input.network)
  } catch (error) {
    throw new Error(
      `Production deploy gate: could not read the production deployments for ${
        input.network
      }, so the cut's facet addresses cannot be attributed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

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
