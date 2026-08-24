/**
 * Declarative invariant registry for the LI.FI Diamond health check.
 *
 * Each production diamond must satisfy a fixed set of on-chain invariants (facets
 * deployed & registered, periphery wired correctly, ownership handed to the right
 * wallets/timelock, whitelist synced, etc.). This module encodes every one of those
 * invariants as a named `{ name, description, severity, scope, run() }` descriptor in
 * `HEALTH_CHECK_INVARIANTS`, plus a `runHealthCheckInvariants()` runner that iterates
 * them against a single {@link IHealthCheckContext}.
 *
 * Import this from the `healthCheck.ts` command (which builds the context and reports
 * the result) and from tests. Adding a new check is a registry edit — append one
 * descriptor — not a change to bespoke control flow.
 */
import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  formatEther,
  getAddress,
  getContract,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import {
  EnvironmentEnum,
  type IWhitelistConfig,
  type TargetState,
} from '../common/types'
import { normalizeSelector } from '../utils/utils'

import {
  diffFacets,
  getExpectedFacetNames,
  getProtectedNames,
  cachedSourceContractNames,
  type IFacetRemoval,
} from './safe/diamondRemovalDiff'
import { SAFE_THRESHOLD } from './shared/constants'
import {
  evaluateFacetPeripheryCouplings,
  getFacetPeripheryCouplings,
  identifyFacetBySelectorSet,
  loadCompiledFacetSelectors,
  resolveLiveFacets,
} from './shared/facetPeripheryCouplings'
import { getCorePeriphery } from './shared/globalContractLists'
import { isRateLimitError } from './shared/rateLimit'
import { parseTroncastFacetsOutput } from './tron/helpers/parseTroncastFacetsOutput'
import { getTronCorePeriphery } from './tron/helpers/tronContractLists'
import {
  callTronContract,
  callTronContractBoolean,
  checkIsDeployedTron,
  checkOwnershipTron,
  ensureTronAddress,
  parseTronAddressOutput,
  parseTroncastArrayOutput,
} from './tron/tronUtils'

/** Severity of a failed invariant: `error` fails the run (exit 1); `warning` is reported but non-fatal. */
export type HealthCheckSeverity = 'error' | 'warning'

/** Coarse applicability gate for an invariant; finer branching lives inside `run()`. */
export interface IHealthCheckScope {
  /** Environments the invariant applies to. Omitted = both production and staging. */
  environments?: Array<'production' | 'staging'>
  /** Chain family the invariant applies to. Omitted = both EVM and Tron. */
  chains?: 'evm-only' | 'tron-only' | 'both'
  /** Skip on testnet networks (EOA-owned diamond, no Safe/Timelock). */
  skipTestnet?: boolean
  /** Only run when the network supports the GasZip integration. */
  requiresGasZip?: boolean
}

/** Subset of `config/global.json` the invariants read (structurally compatible with the full config). */
export interface IHealthCheckGlobalConfig {
  approvedSelectorsForRefundWallet: Array<{ selector: string; name: string }>
  safeOwners: string[]
  whitelistPeripheryFunctions: Record<string, unknown>
}

/** A single registered facet with its selector list, as read from `LiFiDiamond.facets()`. */
export interface IOnChainFacet {
  address: string
  selectors: string[]
}

/**
 * Everything an invariant needs to evaluate one network. Built once per run by the
 * `healthCheck.ts` command; mutable fields (`onChainFacets`, `errors`, `warnings`) are
 * populated as invariants execute so later checks can reuse earlier reads.
 */
export interface IHealthCheckContext {
  network: string
  networkLower: string
  environment: string
  isTron: boolean
  isTestnet: boolean
  supportsGasZip: boolean
  deployedContracts: Record<string, Address | string>
  globalConfig: IHealthCheckGlobalConfig
  targetState: TargetState
  networkConfig: { rpcUrl?: string; safeAddress?: string }
  publicClient?: PublicClient
  tronWeb?: TronWeb
  tronRpcUrl?: string
  diamondAddress: string
  coreFacetsToCheck: string[]
  nonCoreFacets: string[]
  deployerWallet: string
  refundWallet: string
  pauserWallet: string
  /** Populated by the `facets-registered` invariant; reused by selector/facet-set invariants. */
  onChainFacets: IOnChainFacet[]
  /**
   * Periphery names recorded in `deployments/<network>.diamond.json`. Undefined = read from disk
   * (the default); injectable so the registry/log sync check is testable without fixture files.
   */
  diamondLogPeripheryNames?: string[]
  /**
   * Facet name → compiled selector set, used to identify an on-chain facet the deploy log cannot
   * name. Undefined = read from the build output (the default); injectable so both invariants
   * that consume it are testable without a Foundry build.
   */
  compiledFacetSelectors?: Record<string, string[]>
  /**
   * Run-wide memo of PeripheryRegistry reads, shared by every invariant that resolves a periphery
   * address. Optional because tests build partial contexts; absent simply means uncached reads.
   */
  peripheryRegistryCache?: Map<string, Promise<string | null>>
  errors: string[]
  warnings: string[]
  logError: (msg: string) => void
  logWarn: (msg: string) => void
}

/** A named, self-contained health-check invariant. */
export interface IHealthCheckInvariant {
  name: string
  description: string
  severity: HealthCheckSeverity
  scope: IHealthCheckScope
  /** When this invariant fails, skip all remaining invariants (e.g. diamond not deployed). */
  haltIfFailed?: boolean
  /**
   * Reads `ctx.onChainFacets` (populated by `facets-registered`). The runner defers these to
   * a second phase so the first phase's concurrent reads finish (and populate it) first.
   */
  readsOnChainFacets?: boolean
  /** Actionable fix shown after this invariant fails (e.g. the command to re-sync). */
  remediation?: string
  run: (ctx: IHealthCheckContext) => Promise<void>
}

/**
 * A deliberate, documented carve-out: skip one invariant on one network. Use ONLY when an
 * invariant genuinely does not apply to a chain (e.g. an integration is deprecated there) —
 * NOT to silence a real failure you should fix. Every entry MUST carry a `reason`, which is
 * printed when the invariant is skipped so the carve-out is never invisible, and every entry
 * is validated in tests to reference a real invariant name and a real network.
 */
export interface IInvariantExclusion {
  /** `name` of the invariant to skip (must exist in HEALTH_CHECK_INVARIANTS). */
  invariant: string
  /** Network key to skip it on (as in config/networks.json; compared case-insensitively). */
  network: string
  /** Why this invariant does not apply on this network. Shown in the run output. */
  reason: string
}

/**
 * Per-network invariant carve-outs. Empty by default — the correct response to a failing
 * invariant is almost always to fix the on-chain/config drift, not to exclude the check.
 * Add an entry only for a genuine, permanent non-applicability, and link the ticket that
 * documents the decision in `reason`.
 *
 * Example (do not uncomment without a real case):
 *   {
 *     invariant: 'executor-erc20proxy-binding',
 *     network: 'somechain',
 *     reason: 'ERC20Proxy path deprecated on somechain; token pulls route via Permit2 (EXSC-000)',
 *   },
 */
export const HEALTH_CHECK_EXCLUSIONS: IInvariantExclusion[] = []

/**
 * Return the carve-out for a given invariant on a given network, or undefined if the
 * invariant is not excluded there. Pure; network match is case-insensitive.
 */
export function getInvariantExclusion(
  invariantName: string,
  network: string,
  exclusions: IInvariantExclusion[] = HEALTH_CHECK_EXCLUSIONS
): IInvariantExclusion | undefined {
  const networkLower = network.toLowerCase()
  return exclusions.find(
    (e) =>
      e.invariant === invariantName && e.network.toLowerCase() === networkLower
  )
}

/**
 * A core facet that became core AFTER some networks were already live, together with the
 * networks that predate it. This is how a facet is made core "going forward": it stays in
 * `config/global.json` → `coreFacets`, so every NEWLY onboarded network must have it (a new
 * chain is absent from `networks` below and is therefore enforced by default — the safe
 * direction), while the listed pre-existing networks are exempt until they are backfilled.
 *
 * Deliberately narrower than {@link IInvariantExclusion}: that carve-out disables a whole
 * invariant on a network (losing coverage for every other facet), whereas this drops one
 * facet from the expected core set and leaves the rest of `core-facets-deployed` and
 * `facets-registered` fully enforced.
 *
 * The `networks` list is a shrinking to-do, not a permanent state: remove a network the moment
 * the facet is deployed and registered there, and delete the whole entry once the list is
 * empty. Exemptions apply to the health check only — `deployCoreFacets.sh` still reads
 * `coreFacets` from global.json, so deploying the facet everywhere remains a one-command job.
 */
export interface ICoreFacetExemption {
  /** Facet name as listed in `config/global.json` → `coreFacets`. */
  facet: string
  /** Why these networks are exempt, including the ticket that documents the decision. */
  reason: string
  /** Network keys (as in config/networks.json) that predate the facet becoming core. */
  networks: string[]
}

/**
 * Per-network core-facet grandfathering. See {@link ICoreFacetExemption}.
 *
 * Every entry is validated in `healthCheckInvariants.test.ts`: the facet must really be in
 * `coreFacets`, every network must exist in `config/networks.json`, and the reason must be
 * non-empty — so a stale exemption fails CI rather than silently hiding a real gap.
 */
export const CORE_FACET_EXEMPTIONS: ICoreFacetExemption[] = [
  {
    facet: 'LiFiIntentEscrowFacetV2',
    reason:
      'LiFiIntentEscrowFacetV2 supersedes LiFiIntentEscrowFacet and is core going forward (V2-227, #1997), deployed to the chains named there. The networks below predate that decision and are exempt until the facet is backfilled — remove a network here once the facet is deployed and registered on it.',
    networks: [
      '0g',
      'abstract',
      'apechain',
      'arbitrumnova',
      'arbitrumsepolia',
      'arctestnet',
      'avalanche',
      'basesepolia',
      'berachain',
      'blast',
      'bob',
      'boba',
      'celo',
      'cronos',
      'etherlink',
      'flare',
      'flow',
      'fraxtal',
      'fuse',
      'gnosis',
      'gravity',
      'hemi',
      'hyperevm',
      'immutablezkevm',
      'injective',
      'ink',
      'kaia',
      'lens',
      'linea',
      'lisk',
      'mantle',
      'metis',
      'mode',
      'monad',
      'morph',
      'nibiru',
      'opbnb',
      'optimismsepolia',
      'plasma',
      'plume',
      'ronin',
      'rootstock',
      'scroll',
      'sei',
      'somnia',
      'soneium',
      'sonic',
      'stable',
      'telos',
      'tempo',
      'tron',
      'tronshasta',
      'unichain',
      'vana',
      'viction',
      'worldchain',
      'xdc',
      'xlayer',
      'zksync',
    ],
  },
  {
    facet: 'LiFiIntentEscrowFacetV2',
    reason:
      'Intent escrow settlers are not deployed on Jovay and BE confirmed the chain is not supported for intents — do not require LiFiIntentEscrowFacetV2 until product enables it.',
    networks: ['jovay'],
  },
]

/**
 * Core facets the given network is exempt from, with the reason for each. Pure; network match
 * is case-insensitive. A network absent from every entry gets an empty list, i.e. the full
 * core set is enforced — so new chains are covered without touching this table.
 */
export function getExemptCoreFacets(
  network: string,
  exemptions: ICoreFacetExemption[] = CORE_FACET_EXEMPTIONS
): Array<{ facet: string; reason: string }> {
  const networkLower = network.toLowerCase()
  return exemptions
    .filter((e) => e.networks.some((n) => n.toLowerCase() === networkLower))
    .map((e) => ({ facet: e.facet, reason: e.reason }))
}

/**
 * Decide whether an invariant applies to the given context. Pure: depends only on the
 * invariant scope and the environment/chain/testnet/gaszip flags in the context.
 */
export function isInvariantApplicable(
  invariant: IHealthCheckInvariant,
  ctx: Pick<
    IHealthCheckContext,
    'environment' | 'isTron' | 'isTestnet' | 'supportsGasZip'
  >
): boolean {
  const { scope } = invariant

  if (
    scope.environments &&
    !scope.environments.includes(ctx.environment as 'production' | 'staging')
  )
    return false

  if (scope.chains === 'evm-only' && ctx.isTron) return false
  if (scope.chains === 'tron-only' && !ctx.isTron) return false

  if (scope.skipTestnet && ctx.isTestnet) return false

  if (scope.requiresGasZip && !ctx.supportsGasZip) return false

  return true
}

/**
 * Find selectors registered by more than one facet. A diamond selector must map to
 * exactly one facet; duplicates indicate a broken `diamondCut` and are a critical
 * invariant violation. Pure over the on-chain facet list.
 *
 * @returns One entry per offending selector, with the facet addresses that claim it.
 */
export function findDuplicateSelectors(
  onChainFacets: IOnChainFacet[]
): Array<{ selector: string; addresses: string[] }> {
  const bySelector = new Map<string, Set<string>>()
  for (const facet of onChainFacets) {
    for (const selector of facet.selectors) {
      const key = selector.toLowerCase()
      const set = bySelector.get(key) ?? new Set<string>()
      set.add(facet.address.toLowerCase())
      bySelector.set(key, set)
    }
  }

  const duplicates: Array<{ selector: string; addresses: string[] }> = []
  for (const [selector, addresses] of bySelector)
    if (addresses.size > 1)
      duplicates.push({ selector, addresses: [...addresses] })

  return duplicates
}

/** ABI fragment for reading a contract owner. */
const OWNABLE_ABI = parseAbi([
  'function owner() external view returns (address)',
])

const getOwnableContract = (address: Address, client: PublicClient) =>
  getContract({ address, abi: OWNABLE_ABI, client })

/**
 * Assert an EVM contract's `owner()` equals `expectedOwner`. No-op when the contract is
 * absent from the deploy log (mirrors the historical behaviour of the ownership checks).
 */
const checkOwnership = async (
  name: string,
  expectedOwner: Address | string,
  ctx: IHealthCheckContext,
  publicClient: PublicClient
) => {
  const contractAddress = ctx.deployedContracts[name]
  if (contractAddress) {
    const owner = await getOwnableContract(
      contractAddress as Address,
      publicClient
    ).read.owner()
    if (getAddress(owner) !== getAddress(expectedOwner as Address))
      ctx.logError(
        `${name} owner is ${getAddress(owner)}, expected ${getAddress(
          expectedOwner as Address
        )}`
      )
    else consola.success(`${name} owner is correct`)
  }
}

const checkIsDeployed = async (
  contract: string,
  deployedContracts: Record<string, Address | string>,
  publicClient: PublicClient
): Promise<boolean> => {
  const address = deployedContracts[contract]
  if (!address) return false

  const code = await publicClient.getCode({ address: address as Address })
  if (code === '0x') return false

  return true
}

/**
 * Check if a contract is deployed (Tron or EVM) and log success or error.
 * @param label - Optional prefix for messages (e.g. 'Facet', 'Periphery contract').
 */
async function checkAndLogDeployment(
  name: string,
  ctx: IHealthCheckContext,
  label?: string
): Promise<boolean> {
  let isDeployed: boolean
  if (ctx.isTron && ctx.tronWeb)
    isDeployed = await checkIsDeployedTron(
      name,
      ctx.deployedContracts,
      ctx.tronWeb
    )
  else if (ctx.publicClient)
    isDeployed = await checkIsDeployed(
      name,
      ctx.deployedContracts,
      ctx.publicClient
    )
  else isDeployed = false

  if (!isDeployed) {
    ctx.logError(
      label ? `${label} ${name} not deployed` : `${name} not deployed`
    )
    return false
  }
  consola.success(label ? `${label} ${name} deployed` : `${name} deployed`)
  return true
}

/**
 * Expand config into the set of (contract, selector) pairs the diamond whitelist should hold.
 * Exported for testing.
 */
export const getExpectedPairs = async (
  network: string,
  deployedContracts: Record<string, Address | string>,
  whitelistConfig: IWhitelistConfig,
  logError: (msg: string) => void,
  logWarn: (msg: string) => void,
  isTron = false
): Promise<Array<{ contract: string; selector: Hex }>> => {
  try {
    const expectedPairs: Array<{ contract: string; selector: Hex }> = []

    for (const dex of (whitelistConfig.DEXS as Array<{
      contracts?: Record<
        string,
        Array<{ address: string; functions?: Record<string, string> }>
      >
    }>) || []) {
      for (const contract of dex.contracts?.[network.toLowerCase()] || []) {
        const contractAddr = isTron
          ? contract.address
          : getAddress(contract.address)
        const functions = contract.functions || {}

        if (Object.keys(functions).length === 0) {
          expectedPairs.push({
            contract: isTron ? contractAddr : contractAddr.toLowerCase(),
            selector: '0xffffffff' as Hex,
          })
        } else {
          for (const selector of Object.keys(functions)) {
            expectedPairs.push({
              contract: isTron ? contractAddr : contractAddr.toLowerCase(),
              selector: selector.toLowerCase() as Hex,
            })
          }
        }
      }
    }

    const peripheryConfig = whitelistConfig.PERIPHERY
    if (peripheryConfig) {
      const networkPeripheryContracts = peripheryConfig[network.toLowerCase()]
      if (networkPeripheryContracts) {
        // How many entries share each name on this network. A name used more than once
        // cannot be resolved against `deployedContracts` (one address per name), so the
        // staleness comparison below has to sit out those entries.
        const entriesPerName = new Map<string, number>()
        for (const { name } of networkPeripheryContracts)
          entriesPerName.set(name, (entriesPerName.get(name) ?? 0) + 1)

        for (const peripheryContract of networkPeripheryContracts) {
          // The address in whitelist.json is authoritative: this check asks "does the
          // diamond's whitelist match config", and not every whitelisted periphery
          // contract is deployed by this repo (e.g. Composer is whitelisted only).
          // Resolving by name from the deployments file instead would silently drop
          // every such entry — and could not represent the several distinct addresses
          // that share one name on a given network.
          const configAddr = peripheryContract.address
          const deployedAddr = deployedContracts[peripheryContract.name]
          const contractAddr = configAddr || deployedAddr

          if (!contractAddr) {
            logWarn(
              `Whitelist periphery entry "${peripheryContract.name}" has no address in config and is not in the deployments file; its selectors are excluded from the expected-pair set (reduced coverage).`
            )
            continue
          }

          // A config address that disagrees with a contract we did deploy means the
          // whitelist entry is stale — diamondSyncWhitelist would whitelist the wrong
          // address. Surface it, but keep config as the source of truth for this check.
          // Skipped when the name is not unique on this network: `deployedContracts` holds
          // one address per name, so at most one of the entries could ever match it and
          // the rest would warn spuriously.
          if (
            configAddr &&
            deployedAddr &&
            entriesPerName.get(peripheryContract.name) === 1 &&
            String(configAddr).toLowerCase() !==
              String(deployedAddr).toLowerCase()
          )
            logWarn(
              `Whitelist config lists ${peripheryContract.name} at ${configAddr} but deployments has ${deployedAddr}; config/whitelist.json may be stale.`
            )

          for (const selectorInfo of peripheryContract.selectors || []) {
            expectedPairs.push({
              contract: isTron
                ? String(contractAddr)
                : getAddress(contractAddr as Address).toLowerCase(),
              selector: selectorInfo.selector.toLowerCase() as Hex,
            })
          }
        }
      }
    }

    return expectedPairs
  } catch (error) {
    logError(`Failed to get expected pairs: ${error}`)
    return []
  }
}

/**
 * Check whitelist integrity by comparing config against on-chain state.
 */
async function checkWhitelistIntegrity(
  network: string,
  environment: string,
  expectedPairs: Array<{ contract: string; selector: Hex }>,
  logError: (msg: string) => void,
  diamondAddress: string,
  context: {
    tronContext?: { tronRpcUrl: string; tronWeb: TronWeb }
    evmContext?: { publicClient: PublicClient }
  }
): Promise<void> {
  const tronRpcUrl = context.tronContext?.tronRpcUrl
  const tronWeb = context.tronContext?.tronWeb
  const publicClient = context.evmContext?.publicClient

  const hasTronContext = !!tronRpcUrl && !!tronWeb
  const hasEvmContext = !!publicClient

  consola.box('Checking Whitelist Integrity (Config vs. On-Chain State)...')

  if (expectedPairs.length === 0) {
    consola.warn('No expected pairs in config. Skipping all checks.')
    return
  }

  consola.info('Preparing expected data sets from config...')
  const uniqueContracts = new Set(
    expectedPairs.map((p) => p.contract.toLowerCase())
  )
  const uniqueSelectors = new Set(
    expectedPairs.map((p) => p.selector.toLowerCase())
  )
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${uniqueContracts.size} unique contracts, and ${uniqueSelectors.size} unique selectors.`
  )

  let onChainPairSet: Set<string>

  if (hasTronContext) {
    consola.start('Fetching on-chain whitelist data (Tron)...')
    const onChainDataOutput = await callTronContract(
      diamondAddress,
      'getAllContractSelectorPairs()',
      [],
      'address[],bytes4[][]',
      tronRpcUrl
    )

    const parsed = parseTroncastArrayOutput(onChainDataOutput)

    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error('Unexpected troncast output format')
    }

    const addresses = (parsed[0] as unknown[]) || []
    const selectorsArrays = (parsed[1] as unknown[]) || []
    onChainPairSet = new Set<string>()
    for (let i = 0; i < addresses.length; i++) {
      const contract = String(addresses[i]).toLowerCase()
      const selectors = (selectorsArrays[i] as unknown[]) || []
      if (Array.isArray(selectors)) {
        for (const selector of selectors) {
          onChainPairSet.add(`${contract}:${String(selector).toLowerCase()}`)
        }
      }
    }
  } else if (hasEvmContext) {
    consola.start('Fetching on-chain whitelist data (EVM)...')
    const whitelistManager = getContract({
      address: diamondAddress as Address,
      abi: parseAbi([
        'function getAllContractSelectorPairs() external view returns (address[],bytes4[][])',
        'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)',
      ]),
      client: publicClient,
    })

    const [onChainContracts, onChainSelectors] =
      await whitelistManager.read.getAllContractSelectorPairs()

    onChainPairSet = new Set<string>()
    for (let i = 0; i < onChainContracts.length; i++) {
      const contract = onChainContracts[i]?.toLowerCase()
      const selectors = onChainSelectors[i]
      if (contract && selectors) {
        for (const selector of selectors) {
          onChainPairSet.add(`${contract}:${selector.toLowerCase()}`)
        }
      }
    }
  } else {
    consola.warn(
      'No Tron or EVM context provided. Skipping whitelist integrity check.'
    )
    return
  }

  consola.info(`On-chain has ${onChainPairSet.size} total pairs.`)

  try {
    consola.start('Step 1/2: Checking Config vs. On-Chain Functions...')
    let granularFails = 0

    if (hasTronContext) {
      for (const expectedPair of expectedPairs) {
        try {
          const isWhitelisted = await callTronContractBoolean(
            tronWeb,
            diamondAddress,
            'isContractSelectorWhitelisted(address,bytes4)',
            [
              { type: 'address', value: expectedPair.contract },
              { type: 'bytes4', value: expectedPair.selector },
            ],
            'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)'
          )
          if (!isWhitelisted) {
            logError(
              `Source of Truth FAILED: ${expectedPair.contract} / ${expectedPair.selector} is 'false'.`
            )
            granularFails++
          }
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logError(
            `Failed to check ${expectedPair.contract}/${expectedPair.selector}: ${errorMessage}`
          )
          granularFails++
        }
      }
    } else if (hasEvmContext) {
      const abi = parseAbi([
        'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)',
      ])
      const hasMulticall3 =
        publicClient.chain?.contracts?.multicall3 !== undefined

      if (hasMulticall3) {
        // One multicall over ALL pairs (viem auto-chunks) instead of a round-trip per pair.
        const results = await publicClient.multicall({
          contracts: expectedPairs.map((pair) => ({
            address: diamondAddress as Address,
            abi,
            functionName: 'isContractSelectorWhitelisted' as const,
            args: [pair.contract as Address, pair.selector] as const,
          })),
          allowFailure: true,
        })
        expectedPairs.forEach((pair, i) => {
          const result = results[i]
          if (!result || result.status !== 'success') {
            logError(
              `Failed to check ${pair.contract}/${pair.selector}: ${
                result?.error?.message ?? 'call failed'
              }`
            )
            granularFails++
          } else if (!result.result) {
            logError(
              `Source of Truth FAILED: ${pair.contract} / ${pair.selector} is 'false'.`
            )
            granularFails++
          }
        })
      } else {
        // No multicall3 on this chain: fire the reads concurrently (still one round-trip each,
        // but parallel) rather than sequentially.
        const manager = getContract({
          address: diamondAddress as Address,
          abi,
          client: publicClient,
        })
        await Promise.all(
          expectedPairs.map(async (pair) => {
            try {
              const isWhitelisted =
                await manager.read.isContractSelectorWhitelisted([
                  pair.contract as Address,
                  pair.selector,
                ])
              if (!isWhitelisted) {
                logError(
                  `Source of Truth FAILED: ${pair.contract} / ${pair.selector} is 'false'.`
                )
                granularFails++
              }
            } catch (error: unknown) {
              const errorMessage =
                error instanceof Error ? error.message : String(error)
              logError(
                `Failed to check ${pair.contract}/${pair.selector}: ${errorMessage}`
              )
              granularFails++
            }
          })
        )
      }
    }

    if (granularFails === 0) {
      consola.success(
        'Source of Truth (isContractSelectorWhitelisted) is synced.'
      )
    }

    consola.start('Step 2/2: Checking Config vs. Getter Arrays...')

    const expectedPairSet = new Set<string>()
    for (const pair of expectedPairs) {
      expectedPairSet.add(
        `${pair.contract.toLowerCase()}:${pair.selector.toLowerCase()}`
      )
    }

    const missingPairsList: string[] = []
    for (const expectedPair of expectedPairs) {
      const key = `${expectedPair.contract.toLowerCase()}:${expectedPair.selector.toLowerCase()}`
      if (!onChainPairSet.has(key)) {
        missingPairsList.push(key)
      }
    }

    const stalePairsList: string[] = []
    for (const onChainPair of onChainPairSet) {
      if (!expectedPairSet.has(onChainPair)) {
        stalePairsList.push(onChainPair)
      }
    }

    if (missingPairsList.length === 0 && stalePairsList.length === 0) {
      consola.success(
        `Pair Array (getAllContractSelectorPairs) is synced. (${onChainPairSet.size} pairs)`
      )
    } else {
      // Use the executed wrapper, not `source diamondSyncWhitelist.sh && …`: the latter runs
      // the #!/bin/bash script's body in the caller's interactive shell, and its `read -ra`
      // (a bash builtin option) fails under zsh — the macOS default — leaving the network list
      // empty. syncWhitelistToNetworks.sh runs under its own bash shebang.
      const syncCmd = `./script/tasks/syncWhitelistToNetworks.sh ${network}${
        environment === 'production' ? ' --production' : ''
      }`
      if (missingPairsList.length > 0) {
        logError(
          `Pair Array is missing ${missingPairsList.length} pairs from config:`
        )
        missingPairsList.slice(0, 10).forEach((pair) => {
          const [contract, selector] = pair.split(':')
          logError(`  Missing: ${contract} / ${selector}`)
        })
        if (missingPairsList.length > 10) {
          logError(`  ... and ${missingPairsList.length - 10} more`)
        }
        consola.warn(`\n💡 To fix missing pairs, run: ${syncCmd}`)
      }
      if (stalePairsList.length > 0) {
        logError(
          `Pair Array has ${stalePairsList.length} stale pairs not in config:`
        )
        stalePairsList.slice(0, 10).forEach((pair) => {
          const [contract, selector] = pair.split(':')
          logError(`  Stale: ${contract} / ${selector}`)
        })
        if (stalePairsList.length > 10) {
          logError(`  ... and ${stalePairsList.length - 10} more`)
        }
        consola.warn(`\n💡 To fix stale pairs, run: ${syncCmd}`)
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logError(`Failed during whitelist integrity checks: ${errorMessage}`)
  }
}

/**
 * Every Receiver periphery contract in service, and the getter exposing its bound Executor.
 *
 * The one list of receivers this file checks, for both the Executor binding and ownership.
 *
 * A receiver with no `src/Periphery` source and no target-state entry belongs nowhere in here,
 * even while instances stay registered on chain: an invariant that asserts a retired contract's
 * owner can only ever report state nobody intends to change. Same call the file already makes for
 * FeeCollector below.
 */
export const RECEIVER_EXECUTOR_GETTERS: Array<{
  name: string
  getter: string
}> = [
  { name: 'ReceiverAcrossV4', getter: 'EXECUTOR' },
  { name: 'ReceiverChainflip', getter: 'executor' },
  { name: 'ReceiverOIF', getter: 'EXECUTOR' },
  { name: 'ReceiverStargateV2', getter: 'executor' },
]

/** getPeripheryContract on an unregistered name returns address(0); on Tron that encodes to this. */
const TRON_ZERO_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'

/**
 * Read one periphery contract's address from the diamond's on-chain PeripheryRegistry.
 *
 * @param name - the periphery contract name to look up
 * @param ctx - the health-check context (supplies the diamond address and RPC client)
 * @returns the registered address (checksummed hex on EVM, base58 on Tron), or null when the
 *   registry holds the zero address — i.e. nothing is registered under that name
 * @throws when the read fails, returns malformed output, or no client is configured, so callers
 *   can tell "not registered" (null) apart from "could not determine" (throw)
 */
async function readPeripheryRegistryUncached(
  name: string,
  ctx: IHealthCheckContext
): Promise<string | null> {
  if (ctx.isTron) {
    if (!ctx.tronRpcUrl) throw new Error('no Tron RPC URL configured')
    const parsed = parseTronAddressOutput(
      await callTronContract(
        ctx.diamondAddress,
        'getPeripheryContract(string)',
        [name],
        'address',
        ctx.tronRpcUrl
      )
    )
    if (!parsed.startsWith('T') || parsed.length !== 34)
      throw new Error(`malformed Tron address for ${name}: ${parsed}`)
    return parsed === TRON_ZERO_ADDRESS ? null : parsed
  }

  if (!ctx.publicClient) throw new Error('no EVM client configured')
  const registry = getContract({
    address: ctx.diamondAddress as Address,
    abi: parseAbi([
      'function getPeripheryContract(string) external view returns (address)',
    ]),
    client: ctx.publicClient,
  })
  const address = await registry.read.getPeripheryContract([name])
  return address === zeroAddress ? null : getAddress(address)
}

/** Network keys compose into a path, so anything outside this shape is refused outright. */
function isValidNetworkName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * Read the periphery names recorded in `deployments/<network>.diamond.json`.
 *
 * Only the names are taken: this is a source of candidates to probe, not a comparison target — the
 * diamond log is a snapshot with different semantics from the flat log, and reconciling the two is
 * a separate concern. An unreadable or absent log costs coverage, never the run.
 *
 * @param networkLower - canonical lowercase network key
 * @returns the recorded periphery names, or an empty list when the log cannot be read
 */
function loadDiamondLogPeripheryNames(networkLower: string): string[] {
  if (!isValidNetworkName(networkLower)) return []
  const deploymentsDir = path.resolve(process.cwd(), 'deployments')
  const logPath = path.resolve(deploymentsDir, `${networkLower}.diamond.json`)
  const relativeToDir = path.relative(deploymentsDir, logPath)
  if (relativeToDir.startsWith('..') || path.isAbsolute(relativeToDir))
    return []
  if (!existsSync(logPath)) return []

  try {
    const parsed = JSON.parse(readFileSync(logPath, 'utf8')) as {
      LiFiDiamond?: { Periphery?: Record<string, string> }
    }
    return Object.keys(parsed.LiFiDiamond?.Periphery ?? {})
  } catch {
    return []
  }
}

/**
 * `getAddress` that yields null instead of throwing: deploy-log entries are hand-editable, and one
 * malformed entry must never abort a whole per-contract loop.
 */
function tryGetAddress(value: string): Address | null {
  try {
    return getAddress(value as Address)
  } catch {
    return null
  }
}

/**
 * Does this read failure come from the chain rather than the transport?
 *
 * A revert - or a call to an address holding no code - is deterministic: it reproduces on every
 * retry, so it is evidence the contract itself is wrong (a registry entry pointing at something
 * that is not the expected contract) and belongs in the error channel. Transport failures are not
 * evidence of anything, so anything not clearly chain-level is treated as transient; a misjudged
 * network blip must never redden the fleet.
 *
 * One case this cannot decide alone: when the batched multicall's own `eth_call` fails with a
 * message containing "execution reverted" - including a provider envelope that merely embeds the
 * phrase - viem reports that to every read in the batch, so all of them look deterministic. The
 * re-verify pass is what clears it, since the retry re-batches and a transport blip does not
 * reproduce.
 */
export function isDeterministicReadFailure(error: unknown): boolean {
  const seen = new Set<unknown>()
  for (let current = error; current && !seen.has(current); ) {
    seen.add(current)
    const candidate = current as {
      name?: unknown
      message?: unknown
      cause?: unknown
    }
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    if (
      name === 'ContractFunctionRevertedError' ||
      name === 'ContractFunctionZeroDataError'
    )
      return true
    const message =
      typeof candidate.message === 'string'
        ? candidate.message.toLowerCase()
        : ''
    if (
      message.includes('execution reverted') ||
      message.includes('returned no data')
    )
      return true
    current = candidate.cause
  }
  return false
}

/**
 * Report a failed contract read at the level its cause warrants, never throwing.
 *
 * Classification runs inside a `catch`, so it must not raise: an exotic error whose property
 * access throws would otherwise abort the surrounding loop and leave the remaining contracts
 * unchecked - the exact silent gap the per-read guard exists to prevent.
 */
function report(
  ctx: IHealthCheckContext,
  error: unknown,
  message: string
): void {
  let deterministic = false
  try {
    deterministic = isDeterministicReadFailure(error)
  } catch {
    deterministic = false
  }
  if (deterministic) ctx.logError(message)
  else ctx.logWarn(message)
}

/**
 * Read one PeripheryRegistry entry through the run-wide cache on `ctx`.
 *
 * Registry state does not change during a run, but four invariants now probe overlapping name
 * sets; uncached that multiplies the RPC reads per network and feeds the rate limits that degrade
 * other checks. The promise is cached before it settles so concurrent invariants share one
 * in-flight read, and a failed read is evicted so a retry reaches the RPC again.
 */
async function readPeripheryRegistry(
  name: string,
  ctx: IHealthCheckContext
): Promise<string | null> {
  const cache = ctx.peripheryRegistryCache
  if (!cache) return readPeripheryRegistryUncached(name, ctx)

  // Keyed by diamond as well as name: the context owns one cache per network today, but a caller
  // that ever reused one across networks would otherwise be served another chain's address.
  const key = `${ctx.diamondAddress.toLowerCase()}:${name}`
  const cached = cache.get(key)
  if (cached) return cached

  const pending = readPeripheryRegistryUncached(name, ctx).catch(
    (error: unknown) => {
      // Evict only our own entry: the key may already hold a fresh healthy promise, and a stale
      // rejection must not tear that one down.
      if (cache.get(key) === pending) cache.delete(key)
      throw error
    }
  )
  cache.set(key, pending)
  return pending
}

/**
 * Resolve a periphery contract's address from the on-chain registry first, deploy log second.
 *
 * The deploy log can be incomplete, so resolving through it alone silently exempts a log-absent
 * contract from every check that depends on this lookup. A failed registry read falls back to the
 * log rather than aborting: a read failure is not evidence of absence.
 *
 * @returns the address, or undefined when the contract is absent from both sources
 */
async function resolvePeripheryAddress(
  name: string,
  ctx: IHealthCheckContext
): Promise<string | undefined> {
  try {
    const registered = await readPeripheryRegistry(name, ctx)
    if (registered) return registered
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    ctx.logWarn(
      `Could not read the PeripheryRegistry for ${name} (falling back to the deploy log): ${errorMessage}`
    )
  }
  const logged = ctx.deployedContracts[name]
  return logged ? String(logged) : undefined
}

/**
 * Facets that are routed by the diamond but should no longer exist: absent from
 * target state, not on the never-remove allowlist, and with no `.sol` source left
 * under `src/` — i.e. deprecated by `/deprecate-contract` whose removal never
 * actually landed on this chain.
 *
 * Returns `[]` when the network/environment has no target-state `LiFiDiamond`
 * block: an absent entry is not "expects zero facets", and diffing it would
 * classify every routed facet as deprecated.
 *
 * A facet routed at an address the deploy log cannot name is NOT reported here —
 * that is `no-unexpected-facets`' job. This check answers the complementary
 * question that invariant cannot: *should* a known facet still be here?
 *
 * @param params.deployedContracts - Deploy-log `{name: address}` map, inverted here
 *   to resolve loupe addresses to names (works for both hex and Tron base58).
 * @param params.expectedNames - Target-state `LiFiDiamond` contract names, or
 *   `undefined` when the network/environment has no entry at all.
 * @returns The deprecated-but-routed facets, each with the selectors the loupe
 *   currently routes to it.
 */
export function findDeprecatedLiveFacets(params: {
  networkLower: string
  environment: EnvironmentEnum
  onChainFacets: IOnChainFacet[]
  deployedContracts: Record<string, Address | string>
  expectedNames: Set<string> | undefined
  protectedNames: Set<string>
  sourceNames: Set<string>
}): IFacetRemoval[] {
  const { expectedNames } = params
  if (!expectedNames) return []

  const addressToName: Record<string, string> = {}
  for (const [name, address] of Object.entries(params.deployedContracts))
    addressToName[String(address).toLowerCase()] = name

  return diffFacets({
    network: params.networkLower,
    environment: params.environment,
    onChainFacets: params.onChainFacets.map((f) => ({
      address: f.address as Address,
      selectors: f.selectors as Hex[],
    })),
    addressToName,
    expectedNames,
    protectedNames: params.protectedNames,
    // Detection only, so nothing is held back: with an empty active-selector set
    // `removals` is exactly the deprecated-but-routed facet set. Populating it
    // would require compiled artifacts and throws when they are stale — never
    // acceptable in a health check, and the actual removal path
    // (`cleanUpProdDiamond`) computes the real held-back set anyway.
    activeSelectors: new Set<string>(),
    sourceNames: params.sourceNames,
  }).removals
}

/**
 * Splits deprecated-but-routed facets into the ones an open parked task actually
 * covers and the ones nothing is tracking.
 *
 * Coverage is matched by ADDRESS, like the drain and the reconcile. A name maps to
 * exactly one deploy-log address, so a task whose address is not the stale facet
 * on-chain covers nothing the drain would remove — counting it as coverage would
 * silence this backstop for the very facet it exists to surface (two co-registered
 * versions under one name, EXSC-750/EXSC-775).
 *
 * @param deprecated - Deprecated facets the loupe still routes.
 * @param openParkedAddresses - Lowercased `facetAddress` of every open parked task.
 * @returns The covered (`parked`) and uncovered (`unparked`) partitions.
 */
export function splitByParkedCoverage(
  deprecated: IFacetRemoval[],
  openParkedAddresses: Set<string>
): { parked: IFacetRemoval[]; unparked: IFacetRemoval[] } {
  const isParked = (facet: IFacetRemoval): boolean =>
    openParkedAddresses.has(facet.address.toLowerCase())
  return {
    parked: deprecated.filter(isParked),
    unparked: deprecated.filter((f) => !isParked(f)),
  }
}

/**
 * Open parked tasks fleet-wide, fetched once per process and grouped by network
 * (lowercased `facetAddress` sets). The health check evaluates dozens of networks
 * concurrently in one process, and a Mongo connect/index-check/teardown per stale
 * network would hammer the shared cluster; one shared read serves them all.
 * A failed fetch degrades that network to a coverage warning instead of a false
 * alarm, and clears the cache so the next network retries — one transient blip
 * at process start must not blind the whole run. In-flight callers share the
 * failing promise, so a hard outage costs at most one attempt per network.
 */
let openParkedByNetworkPromise:
  | Promise<Map<string, Set<string>> | { unreachable: string }>
  | undefined
function fetchOpenParkedAddressesByNetwork(): Promise<
  Map<string, Set<string>> | { unreachable: string }
> {
  return (openParkedByNetworkPromise ??= (async () => {
    try {
      const { getParkedTasksCollection, listParkedTasks, OPEN_STATUSES } =
        await import('./safe/parked-tasks')
      const { client, parkedTasks } = await getParkedTasksCollection()
      try {
        const open = await listParkedTasks(parkedTasks, {
          environment: EnvironmentEnum.production,
          status: OPEN_STATUSES,
        })
        const byNetwork = new Map<string, Set<string>>()
        for (const task of open) {
          const set = byNetwork.get(task.network) ?? new Set<string>()
          set.add(task.facetAddress.toLowerCase())
          byNetwork.set(task.network, set)
        }
        return byNetwork
      } finally {
        await client.close()
      }
    } catch (error: unknown) {
      openParkedByNetworkPromise = undefined
      return {
        unreachable: error instanceof Error ? error.message : String(error),
      }
    }
  })())
}

/**
 * Ordered registry of every health-check invariant. The order matches historical log
 * output; earlier invariants may populate mutable context fields (e.g. `onChainFacets`)
 * that later ones reuse.
 */
export const HEALTH_CHECK_INVARIANTS: IHealthCheckInvariant[] = [
  {
    name: 'diamond-deployed',
    description: 'LiFiDiamond is deployed',
    severity: 'error',
    scope: {},
    haltIfFailed: true,
    run: async (ctx) => {
      await checkAndLogDeployment('LiFiDiamond', ctx)
    },
  },
  {
    name: 'core-facets-deployed',
    description: 'All core facets are deployed',
    severity: 'error',
    scope: {},
    run: async (ctx) => {
      for (const facet of ctx.coreFacetsToCheck)
        await checkAndLogDeployment(facet, ctx, 'Facet')
    },
  },
  {
    name: 'non-core-facets-deployed',
    description: 'All non-core (target-state) facets are deployed',
    severity: 'error',
    scope: { environments: ['production'] },
    run: async (ctx) => {
      for (const facet of ctx.nonCoreFacets)
        await checkAndLogDeployment(facet, ctx, 'Facet')
    },
  },
  {
    name: 'facets-registered',
    description: 'All expected facets are registered in the diamond',
    severity: 'error',
    scope: {},
    remediation:
      'Add/verify the facet via diamondCut (see script/deploy/facets) and confirm it is verified on the explorer.',
    run: async (ctx) => {
      let registeredFacets: string[] = []
      let facetCheckSkipped = false
      // Populated in place so the shared ctx.onChainFacets reference (see runner) is visible
      // to the phase-2 selector/facet-set invariants.
      const setOnChainFacets = (facets: IOnChainFacet[]) => {
        ctx.onChainFacets.length = 0
        ctx.onChainFacets.push(...facets)
      }
      const configFacetsByAddress = Object.fromEntries(
        Object.entries(ctx.deployedContracts).map(
          ([name, address]: [string, unknown]) => [
            String(address).toLowerCase(),
            name,
          ]
        )
      )
      try {
        if (ctx.isTron && ctx.tronRpcUrl) {
          const rawString = await callTronContract(
            ctx.diamondAddress,
            'facets()',
            [],
            '(address,bytes4[])[]',
            ctx.tronRpcUrl
          )
          const onChainFacets = parseTroncastFacetsOutput(rawString)

          if (Array.isArray(onChainFacets)) {
            setOnChainFacets(
              onChainFacets.map(([address, selectors]: [string, unknown]) => ({
                address: String(address),
                selectors: (Array.isArray(selectors) ? selectors : []).map(
                  (s) => String(s)
                ),
              }))
            )
            registeredFacets = ctx.onChainFacets
              .map((f) => configFacetsByAddress[f.address.toLowerCase()])
              .filter((name): name is string => typeof name === 'string')
          }
        } else if (ctx.publicClient) {
          // viem read (not `cast`): folds into the batched multicall client and drops a subprocess.
          const diamond = getContract({
            address: ctx.diamondAddress as Address,
            abi: parseAbi([
              'function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])',
            ]),
            client: ctx.publicClient,
          })
          const facets = await diamond.read.facets()
          setOnChainFacets(
            facets.map((f) => ({
              address: f.facetAddress,
              selectors: [...f.functionSelectors],
            }))
          )
          registeredFacets = ctx.onChainFacets
            .map((f) => configFacetsByAddress[f.address.toLowerCase()])
            .filter((name): name is string => typeof name === 'string')
        }
      } catch (error: unknown) {
        facetCheckSkipped = true
        // Record a warning (not a silent consola.warn): a failed facets() read leaves
        // ctx.onChainFacets empty, so the phase-2 selector/facet-set invariants
        // (no-duplicate-selectors, no-unexpected-facets) skip. Surfacing it here lands the
        // network in the `warned` list so the reduced coverage is visible in the sweep report
        // instead of posting a green status while the drift checks silently didn't run.
        if (isRateLimitError(error))
          ctx.logWarn(
            'RPC rate limit reached (429) - facet registration + phase-2 selector/facet-set checks skipped'
          )
        else {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          ctx.logWarn(
            `Unable to read facets() - facet registration + phase-2 selector/facet-set checks skipped: ${errorMessage}`
          )
        }
      }

      if (!facetCheckSkipped) {
        for (const facet of [...ctx.coreFacetsToCheck, ...ctx.nonCoreFacets])
          if (!registeredFacets.includes(facet))
            ctx.logError(
              `Facet ${facet} not registered in Diamond or possibly unverified`
            )
          else consola.success(`Facet ${facet} registered in Diamond`)
      }
    },
  },
  {
    name: 'core-periphery-deployed',
    description: 'All core periphery contracts are deployed',
    severity: 'error',
    scope: { environments: ['production'] },
    run: async (ctx) => {
      let peripheryToCheck = ctx.isTron
        ? getTronCorePeriphery()
        : getCorePeriphery()
      if (!ctx.supportsGasZip)
        peripheryToCheck = peripheryToCheck.filter(
          (contract) => contract !== 'GasZipPeriphery'
        )
      if (ctx.isTestnet)
        peripheryToCheck = peripheryToCheck.filter(
          (contract) => contract !== 'LiFiTimelockController'
        )

      for (const contract of peripheryToCheck)
        await checkAndLogDeployment(contract, ctx, 'Periphery contract')
    },
  },
  {
    name: 'executor-erc20proxy-binding',
    description:
      'Executor is bound to the deployed ERC20Proxy and that proxy authorizes it (bug bounty #292)',
    severity: 'error',
    scope: { environments: ['production'] },
    remediation:
      'Executor bound to a stale proxy: redeploy the Executor against the deployed ERC20Proxy, re-register it, and authorize it on the proxy.',
    run: async (ctx) => {
      const erc20ProxyAddress = ctx.deployedContracts['ERC20Proxy']
      const executorAddress = ctx.deployedContracts['Executor']
      if (!erc20ProxyAddress || !executorAddress) {
        ctx.logError(
          'ERC20Proxy or Executor missing from deploy log; cannot verify binding'
        )
        return
      }

      if (ctx.isTron && ctx.tronWeb && ctx.tronRpcUrl) {
        try {
          // 1. Executor.erc20Proxy() must point at the deployed ERC20Proxy.
          const boundProxyRaw = await callTronContract(
            String(executorAddress),
            'erc20Proxy()',
            [],
            'address',
            ctx.tronRpcUrl
          )
          // callTronContract returns the address as base58 (T...) — mirror the parsing
          // used by the periphery-registration check rather than lowercasing/hex-guessing.
          const cleaned = parseTronAddressOutput(boundProxyRaw)
          const boundProxy =
            cleaned.startsWith('T') && cleaned.length === 34 ? cleaned : null
          const expectedProxy = String(erc20ProxyAddress)

          if (!boundProxy || boundProxy !== expectedProxy) {
            ctx.logError(
              `Executor.erc20Proxy() is ${
                boundProxy ?? `unparseable (${cleaned})`
              }, expected deployed ERC20Proxy ${expectedProxy}`
            )
            return
          }
          consola.success('Executor is bound to the deployed ERC20Proxy')

          // 2. The bound proxy must authorize the Executor.
          const isAuthorized = await callTronContractBoolean(
            ctx.tronWeb,
            boundProxy,
            'authorizedCallers(address)',
            [{ type: 'address', value: String(executorAddress) }],
            'function authorizedCallers(address) external view returns (bool)'
          )
          if (!isAuthorized)
            ctx.logError('Executor is not authorized in its bound ERC20Proxy')
          else consola.success('Executor is authorized in its bound ERC20Proxy')
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          ctx.logError(
            `Failed to verify Executor↔ERC20Proxy binding: ${errorMessage}`
          )
        }
        return
      }

      if (!ctx.publicClient) return

      const expectedProxy = getAddress(erc20ProxyAddress as Address)
      const executor = getAddress(executorAddress as Address)

      // 1. Executor.erc20Proxy() must point at the deployed ERC20Proxy.
      const executorContract = getContract({
        address: executor,
        abi: parseAbi([
          'function erc20Proxy() external view returns (address)',
        ]),
        client: ctx.publicClient,
      })
      const boundProxy = getAddress(await executorContract.read.erc20Proxy())

      if (boundProxy !== expectedProxy)
        ctx.logError(
          `Executor.erc20Proxy() is ${boundProxy}, expected deployed ERC20Proxy ${expectedProxy} (Executor bound to a stale proxy — bug bounty #292)`
        )
      else consola.success('Executor is bound to the deployed ERC20Proxy')

      // 2. The proxy the Executor is actually bound to must authorize it.
      const boundProxyContract = getContract({
        address: boundProxy,
        abi: parseAbi([
          'function authorizedCallers(address) external view returns (bool)',
        ]),
        client: ctx.publicClient,
      })
      const isAuthorized = await boundProxyContract.read.authorizedCallers([
        executor,
      ])
      if (!isAuthorized)
        ctx.logError(
          `Bound ERC20Proxy ${boundProxy} does not authorize Executor ${executor}`
        )
      else consola.success('Executor is authorized in its bound ERC20Proxy')
    },
  },
  {
    name: 'receiver-executor-binding',
    description: 'Every deployed Receiver is bound to the deployed Executor',
    severity: 'error',
    scope: { environments: ['production'], chains: 'evm-only' },
    run: async (ctx) => {
      if (!ctx.publicClient) return
      // Resolved the same way as the receivers below: comparing a registry-resolved receiver
      // against a log-only Executor would flag drift between the two sources as a binding error.
      const executorAddress = await resolvePeripheryAddress('Executor', ctx)
      if (!executorAddress) {
        ctx.logError(
          'Executor could not be resolved from the PeripheryRegistry or the deploy log; cannot verify Receivers'
        )
        return
      }
      const expectedExecutor = getAddress(executorAddress as Address)

      // Registry-first: a receiver live on chain but absent from the deploy log must not escape
      // the only check that verifies its Executor binding. Resolved in one pass so the batched
      // multicall client can coalesce the reads instead of seeing them one await at a time.
      const resolvedReceivers = await Promise.all(
        RECEIVER_EXECUTOR_GETTERS.map(async ({ name, getter }) => ({
          name,
          getter,
          receiverAddress: await resolvePeripheryAddress(name, ctx),
        }))
      )

      for (const { name, getter, receiverAddress } of resolvedReceivers) {
        if (!receiverAddress) continue

        const receiver = getContract({
          address: getAddress(receiverAddress as Address),
          abi: parseAbi([
            `function ${getter}() external view returns (address)`,
          ]),
          client: ctx.publicClient,
        })
        const readExecutor = (
          receiver.read as Record<string, (() => Promise<Address>) | undefined>
        )[getter]
        if (!readExecutor) continue
        let boundExecutor: Address
        try {
          boundExecutor = getAddress(await readExecutor())
        } catch (error: unknown) {
          // Report and move on either way: one failing receiver must not abandon the ones not yet
          // checked. A chain-level failure is still an error, though - a receiver whose binding
          // getter reverts is broken, not flaky.
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          report(
            ctx,
            error,
            `Could not read ${name}.${getter}(): ${errorMessage}`
          )
          continue
        }

        if (boundExecutor !== expectedExecutor)
          ctx.logError(
            `${name}.${getter}() is ${boundExecutor}, expected deployed Executor ${expectedExecutor}`
          )
        else consola.success(`${name} is bound to the deployed Executor`)
      }
    },
  },
  {
    name: 'periphery-registered',
    description: 'Periphery contracts are registered in the PeripheryRegistry',
    severity: 'error',
    scope: { environments: ['production'] },
    run: async (ctx) => {
      const targetStateContracts =
        ctx.targetState[ctx.networkLower]?.production?.LiFiDiamond || {}
      let contractsToCheck = Object.keys(targetStateContracts).filter(
        (contract) =>
          (ctx.isTron ? getTronCorePeriphery() : getCorePeriphery()).includes(
            contract
          ) ||
          Object.keys(ctx.globalConfig.whitelistPeripheryFunctions).includes(
            contract
          )
      )
      if (!ctx.supportsGasZip)
        contractsToCheck = contractsToCheck.filter(
          (contract) => contract !== 'GasZipPeriphery'
        )

      if (contractsToCheck.length === 0) return

      if (ctx.isTron && ctx.tronWeb && ctx.tronRpcUrl) {
        for (const periphery of contractsToCheck) {
          const peripheryAddress = ctx.deployedContracts[periphery]
          if (!peripheryAddress) {
            ctx.logError(`Periphery contract ${periphery} not deployed`)
            continue
          }
          if (periphery === 'LiFiTimelockController') continue

          try {
            const registeredAddressOutput = await callTronContract(
              ctx.diamondAddress,
              'getPeripheryContract(string)',
              [periphery],
              'address',
              ctx.tronRpcUrl
            )

            // Use the shared parser, not an ad-hoc trim: callTronContract's output carries
            // TronWeb diagnostic lines ahead of the return value.
            const cleanedAddress = parseTronAddressOutput(
              registeredAddressOutput
            )
            const registeredAddress =
              cleanedAddress.startsWith('T') && cleanedAddress.length === 34
                ? cleanedAddress
                : null
            const expectedAddress = String(peripheryAddress).toLowerCase()

            if (
              !registeredAddress ||
              registeredAddress.toLowerCase() !== expectedAddress
            )
              ctx.logError(
                `Periphery contract ${periphery} not registered in Diamond (expected: ${peripheryAddress}, got: ${
                  registeredAddress || 'null'
                })`
              )
            else
              consola.success(
                `Periphery contract ${periphery} registered in Diamond`
              )
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : String(error)
            ctx.logError(
              `Failed to check periphery registration for ${periphery}: ${errorMessage}`
            )
          }
        }
      } else if (ctx.publicClient) {
        const peripheryRegistry = getContract({
          address: ctx.diamondAddress as Address,
          abi: parseAbi([
            'function getPeripheryContract(string) external view returns (address)',
          ]),
          client: ctx.publicClient,
        })

        const addresses = await Promise.all(
          contractsToCheck.map((c) =>
            peripheryRegistry.read.getPeripheryContract([c])
          )
        )

        for (const periphery of contractsToCheck) {
          const peripheryAddress = ctx.deployedContracts[periphery]
          if (!peripheryAddress)
            ctx.logError(`Periphery contract ${periphery} not deployed `)
          else if (!addresses.includes(getAddress(peripheryAddress))) {
            if (periphery === 'LiFiTimelockController') continue
            ctx.logError(
              `Periphery contract ${periphery} not registered in Diamond`
            )
          } else
            consola.success(
              `Periphery contract ${periphery} registered in Diamond`
            )
        }
      }
    },
  },
  {
    name: 'periphery-registry-log-sync',
    description:
      'Every known periphery contract registered in the diamond is recorded in the deploy log',
    // Warning, not error: a log that lags the chain is a bookkeeping failure, not a broken
    // diamond, and an error gate here would turn the whole fleet sweep red over drift nobody can
    // fix in the same change. periphery-registered remains the error gate for the log -> chain
    // direction.
    severity: 'warning',
    scope: { environments: ['production'] },
    remediation:
      'Add the missing entry to deployments/<network>.json (or correct the stale address) so the deploy log matches the on-chain PeripheryRegistry.',
    run: async (ctx) => {
      // The registry is a mapping(string => address) with no enumerator, so the on-chain side can
      // only be discovered by probing names - which bounds this check to names some source already
      // knows. Both deploy logs contribute, because a contract can be recorded in one and not the
      // other. Receivers reach this list twice over - as coupling companions and via
      // RECEIVER_EXECUTOR_GETTERS - so no receiver in service depends on a log naming it first.
      // Facets are excluded because probing every facet name would multiply the RPC reads for
      // lookups that can only ever return the zero address.
      // Target state only names facets that are still current, so a retired facet lingering in the
      // flat log would otherwise be probed - a fifth of all probes on a real network, for lookups
      // that can only ever return the zero address. Matching on `includes` mirrors
      // deriveNonCoreFacets and catches the packed/versioned variants; no periphery name contains
      // "Facet".
      const notPeriphery = (name: string): boolean =>
        name.includes('Facet') ||
        name.startsWith('LiFiDiamond') ||
        ctx.coreFacetsToCheck.includes(name) ||
        ctx.nonCoreFacets.includes(name)
      const candidates = [
        ...new Set([
          ...(ctx.isTron ? getTronCorePeriphery() : getCorePeriphery()),
          ...Object.keys(ctx.globalConfig.whitelistPeripheryFunctions),
          ...Object.values(getFacetPeripheryCouplings()).map(
            (coupling) => coupling.requires
          ),
          ...RECEIVER_EXECUTOR_GETTERS.map((receiver) => receiver.name),
          ...Object.keys(ctx.deployedContracts),
          ...(ctx.diamondLogPeripheryNames ??
            loadDiamondLogPeripheryNames(ctx.networkLower)),
        ]),
      ]
        .filter((name) => !notPeriphery(name))
        .sort()

      // EVM reads fold into the batched multicall client; Tron reads stay sequential because each
      // one spawns a troncast subprocess with its own retry backoff, and firing the whole candidate
      // list at once would burst dozens of them at a rate-limited RPC.
      const registered: Array<PromiseSettledResult<string | null>> = []
      if (ctx.isTron)
        for (const name of candidates)
          registered.push(
            await readPeripheryRegistry(name, ctx).then(
              (value): PromiseSettledResult<string | null> => ({
                status: 'fulfilled',
                value,
              }),
              (reason: unknown): PromiseSettledResult<string | null> => ({
                status: 'rejected',
                reason,
              })
            )
          )
      else
        registered.push(
          ...(await Promise.allSettled(
            candidates.map((name) => readPeripheryRegistry(name, ctx))
          ))
        )

      // A rate-limited RPC would otherwise emit a warning per candidate - dozens per network - so
      // those collapse into one line, the way the facets() read handles the same failure. Only
      // rate-limit rejections collapse: any other failure is a distinct problem and keeps its own
      // named warning.
      const rateLimitedCount = registered.filter(
        (result) =>
          result.status === 'rejected' && isRateLimitError(result.reason)
      ).length
      if (rateLimitedCount > 0)
        ctx.logWarn(
          `RPC rate limit reached while reading the PeripheryRegistry; ${rateLimitedCount} of ${candidates.length} periphery name(s) went unchecked on this network`
        )

      let inSync = 0
      candidates.forEach((name, index) => {
        const result = registered[index]
        if (result?.status !== 'fulfilled') {
          if (result?.status === 'rejected' && isRateLimitError(result.reason))
            return
          const reason =
            result?.status === 'rejected' ? String(result.reason) : 'no result'
          ctx.logWarn(
            `Could not read the registry entry for ${name}: ${reason}`
          )
          return
        }
        // Not registered here: whether it SHOULD be is periphery-registered's question, not this
        // invariant's - this one only reconciles what the chain already says.
        if (result.value === null) return

        const onChain = result.value
        const logged = ctx.deployedContracts[name]
        if (!logged) {
          ctx.logWarn(
            `${name} is registered on chain (${onChain}) but missing from the deploy log - add it to deployments/${ctx.networkLower}.json`
          )
          return
        }
        // Tron addresses are base58 and case-sensitive; only EVM hex gets checksum-normalized.
        const normalize = (address: string): string =>
          ctx.isTron ? address : tryGetAddress(address) ?? address
        if (normalize(String(logged)) !== normalize(onChain))
          ctx.logWarn(
            `${name}: the deploy log has ${String(
              logged
            )} but the on-chain registry has ${onChain}`
          )
        else inSync++
      })

      if (inSync > 0)
        consola.success(
          `${inSync} registered periphery contract(s) match the deploy log`
        )
    },
  },
  {
    name: 'facet-required-periphery',
    description:
      'Every live facet with a declared companion periphery contract has one registered in the diamond',
    severity: 'error',
    scope: { environments: ['production'] },
    readsOnChainFacets: true,
    remediation:
      'Deploy the missing companion contract on this network and register it via diamondUpdatePeriphery, or - if destination calls genuinely do not apply here - add a reasoned notRequiredOn entry to config/global.json -> facetPeripheryCouplings.',
    run: async (ctx) => {
      // Triggers on facets live in the diamond, not on target state: the failure this guards against
      // is a facet being live while its companion is absent, and target state itself was missing the
      // receiver in the incident that motivated the check (Robinhood, EXSC-682).
      if (ctx.onChainFacets.length === 0) {
        ctx.logWarn(
          'On-chain facet list unavailable - facet/periphery coupling check skipped'
        )
        return
      }

      // A facet is live iff the diamond registers it under its deploy-log address or - when the log
      // cannot name it - under a selector set only one compiled facet accounts for. The log alone
      // is not enough: a facet live on chain but missing or stale there would have its coupling
      // silently unevaluated.
      const couplings = getFacetPeripheryCouplings()
      const liveFacets = resolveLiveFacets(
        ctx.onChainFacets,
        ctx.deployedContracts as Record<string, string>,
        Object.keys(couplings),
        ctx.compiledFacetSelectors ?? loadCompiledFacetSelectors()
      )

      const { required, skipped } = evaluateFacetPeripheryCouplings(
        liveFacets,
        ctx.networkLower,
        couplings
      )

      for (const carveOut of skipped)
        consola.info(
          `⏭  ${carveOut.facet}: ${carveOut.companion} not required here — ${carveOut.reason}`
        )

      if (required.length === 0) return

      const wanted = required.map((requirement) => requirement.companion)
      // A companion is present iff the registry returns a non-null (non-zero) address. A read that
      // fails or returns malformed output is undetermined, never treated as absence - one flaky RPC
      // (or troncast output drift) must not raise a false "destination calls disabled" gate.
      const registered = new Map<string, boolean>()
      const unresolved = new Set<string>()
      const markUnresolved = (companion: string, reason: unknown): void => {
        ctx.logWarn(
          `Failed to read periphery registration for ${companion}: ${String(
            reason
          )}`
        )
        unresolved.add(companion)
      }

      // EVM reads fold into the batched multicall client (concurrent); Tron reads stay sequential
      // to avoid spawning a troncast subprocess per companion at once.
      if (ctx.isTron)
        for (const companion of wanted)
          try {
            registered.set(
              companion,
              (await readPeripheryRegistry(companion, ctx)) !== null
            )
          } catch (error: unknown) {
            markUnresolved(companion, error)
          }
      else {
        const results = await Promise.allSettled(
          wanted.map((companion) => readPeripheryRegistry(companion, ctx))
        )
        wanted.forEach((companion, index) => {
          const result = results[index]
          if (result?.status === 'fulfilled')
            registered.set(companion, result.value !== null)
          else markUnresolved(companion, result?.reason ?? 'no result')
        })
      }

      for (const { companion, triggeredBy } of required) {
        if (unresolved.has(companion)) {
          ctx.logWarn(
            `${triggeredBy.join(
              ', '
            )}: could not determine whether ${companion} is registered (lookup failed)`
          )
          continue
        }

        if (registered.get(companion)) {
          consola.success(
            `${companion} registered for ${triggeredBy.join(', ')}`
          )
          continue
        }

        ctx.logError(
          `${triggeredBy.join(
            ', '
          )} live but companion ${companion} not registered in Diamond - destination calls for this integration are disabled on this network`
        )
      }
    },
  },
  {
    name: 'whitelist-integrity',
    description:
      'Diamond whitelist matches config (source of truth + getter arrays)',
    severity: 'error',
    scope: {},
    run: async (ctx) => {
      let whitelistConfig: unknown = { DEXS: [], PERIPHERY: {} }
      const whitelistFileName =
        ctx.environment === 'staging'
          ? 'whitelist.staging.json'
          : 'whitelist.json'
      const whitelistPath = path.join(
        process.cwd(),
        'config',
        whitelistFileName
      )
      if (existsSync(whitelistPath)) {
        try {
          whitelistConfig = JSON.parse(
            readFileSync(whitelistPath, 'utf8')
          ) as IWhitelistConfig
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          ctx.logError(`Failed to parse ${whitelistFileName}: ${errorMessage}`)
        }
      } else if (ctx.environment === 'staging') {
        consola.info(
          'whitelist.staging.json not found, skipping whitelist checks'
        )
      }

      try {
        const hasDexWhitelistConfig =
          (
            (whitelistConfig as IWhitelistConfig).DEXS as Array<{
              contracts?: Record<string, unknown[]>
            }>
          )?.some(
            (dex) => (dex.contracts?.[ctx.networkLower]?.length ?? 0) > 0
          ) ?? false

        const hasPeripheryWhitelistConfig =
          ((whitelistConfig as IWhitelistConfig).PERIPHERY?.[ctx.networkLower]
            ?.length ?? 0) > 0

        const hasWhitelistConfig =
          hasDexWhitelistConfig || hasPeripheryWhitelistConfig

        if (hasWhitelistConfig) {
          const expectedPairs = await getExpectedPairs(
            ctx.network,
            ctx.deployedContracts,
            whitelistConfig as IWhitelistConfig,
            ctx.logError,
            ctx.logWarn,
            ctx.isTron
          )

          await checkWhitelistIntegrity(
            ctx.network,
            ctx.environment,
            expectedPairs,
            ctx.logError,
            ctx.diamondAddress,
            {
              tronContext:
                ctx.isTron && ctx.tronRpcUrl && ctx.tronWeb
                  ? { tronRpcUrl: ctx.tronRpcUrl, tronWeb: ctx.tronWeb }
                  : undefined,
              evmContext: ctx.publicClient
                ? { publicClient: ctx.publicClient }
                : undefined,
            }
          )
        } else {
          consola.info(
            'No whitelist configuration found for this network, skipping whitelist checks'
          )
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.stack ?? error.message : String(error)
        ctx.logError(`Whitelist configuration not available: ${errorMessage}`)
      }
    },
  },
  {
    name: 'erc20proxy-owner',
    description: 'ERC20Proxy owner is the refund wallet',
    severity: 'error',
    scope: { environments: ['production'] },
    remediation:
      'Transfer ERC20Proxy ownership to refundWallet: current owner calls transferOwnership(refundWallet), then refundWallet calls confirmOwnershipTransfer().',
    run: async (ctx) => {
      if (ctx.isTron && ctx.tronWeb && ctx.tronRpcUrl)
        await checkOwnershipTron(
          'ERC20Proxy',
          ctx.refundWallet,
          ctx.deployedContracts,
          ctx.tronRpcUrl,
          ctx.tronWeb,
          ctx.logError
        )
      else if (ctx.publicClient)
        await checkOwnership(
          'ERC20Proxy',
          ctx.refundWallet,
          ctx,
          ctx.publicClient
        )
    },
  },
  {
    name: 'diamond-owner',
    description:
      'Diamond is owned by the timelock (mainnet) or deployer (testnet)',
    severity: 'error',
    scope: {},
    run: async (ctx) => {
      if (ctx.isTron && ctx.tronWeb && ctx.tronRpcUrl) {
        if (ctx.environment === 'production') {
          if (ctx.deployedContracts.LiFiTimelockController)
            await checkOwnershipTron(
              'LiFiDiamond',
              ctx.deployedContracts.LiFiTimelockController,
              ctx.deployedContracts,
              ctx.tronRpcUrl,
              ctx.tronWeb,
              ctx.logError
            )
          else
            ctx.logError(
              'LiFiTimelockController not deployed, so diamond ownership cannot be verified'
            )
        } else
          consola.info(
            'Skipping diamond ownership check for staging environment'
          )
        return
      }

      if (!ctx.publicClient) return

      // localanvil is a CI smoke-test sandbox where anvil's default account owns the diamond.
      if (ctx.isTestnet && ctx.networkLower !== 'localanvil')
        await checkOwnership(
          'LiFiDiamond',
          ctx.deployerWallet,
          ctx,
          ctx.publicClient
        )
      else if (ctx.networkLower === 'localanvil')
        consola.info(
          'Skipping diamond ownership check for localanvil (CI sandbox: anvil default account owns the diamond).'
        )
      else if (ctx.environment === 'production') {
        if (ctx.deployedContracts.LiFiTimelockController)
          await checkOwnership(
            'LiFiDiamond',
            ctx.deployedContracts.LiFiTimelockController,
            ctx,
            ctx.publicClient
          )
        else
          ctx.logError(
            'LiFiTimelockController not deployed, so diamond ownership cannot be verified'
          )
      } else
        consola.info('Skipping diamond ownership check for staging environment')
    },
  },
  // FeeCollector is deprecated: its on-chain owner is no longer maintained against
  // config.feeCollectorOwner, so there is deliberately no 'feecollector-owner' invariant.
  // config.feeCollectorOwner is still read by the FeeCollector deploy scripts.
  {
    name: 'receiver-owner',
    description: 'Every Receiver owner is the refund wallet',
    severity: 'error',
    // KNOWN GAP: ReceiverOIF is live on Tron (#2220) and this leaves it unchecked. The Tron path
    // needs its own sequential implementation - checkOwnershipTron spawns one troncast subprocess
    // per read, so the batched resolution below cannot be reused there. Tracked separately rather
    // than half-built here; receiver-executor-binding has carried the same gap since before it.
    scope: { chains: 'evm-only' },
    run: async (ctx) => {
      if (!ctx.publicClient) return
      const publicClient = ctx.publicClient

      // Resolved registry-first so a receiver missing from - or stale in - the deploy log is still
      // covered; absent from both sources means the receiver genuinely is not on this chain.
      // Resolved in one pass so the batched multicall client can coalesce the reads instead of
      // seeing them one await at a time.
      const resolved = await Promise.all(
        RECEIVER_EXECUTOR_GETTERS.map(async ({ name }) => ({
          name,
          address: await resolvePeripheryAddress(name, ctx),
        }))
      )

      for (const { name, address } of resolved) {
        if (!address) continue

        let owner: Address
        try {
          owner = await getOwnableContract(
            address as Address,
            publicClient
          ).read.owner()
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          report(ctx, error, `Could not read ${name} owner: ${errorMessage}`)
          continue
        }
        if (getAddress(owner) !== getAddress(ctx.refundWallet as Address))
          ctx.logError(
            `${name} owner is ${getAddress(owner)}, expected ${getAddress(
              ctx.refundWallet as Address
            )}`
          )
        else consola.success(`${name} owner is correct`)
      }
    },
  },
  {
    // A non-zero-balance floor for the pauser. verifyEmergencyPauseReadiness.yml
    // (checkPauserFunds.sh) owns the stronger "can afford a pauseDiamond()" check, but it is
    // EVM-only and runs only on the scheduled/manual readiness workflow — so on its own it
    // leaves two gaps: (1) the Tron pauser's TRX balance is asserted nowhere, and (2) a
    // freshly deployed EVM network's unfunded pauser is not caught until the next readiness
    // run. This lightweight floor closes both: it runs on Tron and at deploy time (the sweep's
    // push trigger), while the readiness workflow remains the authoritative affordability gate.
    name: 'pauser-funded',
    description: 'Pauser wallet has a non-zero native balance',
    severity: 'error',
    // skipTestnet: the two coverage gaps this closes are both mainnet (Tron mainnet pauser +
    // freshly deployed EVM mainnet pausers); testnet pausers (incl. the localanvil smoke-test
    // sandbox, whose pauser is unfunded) are not a production readiness invariant.
    scope: { environments: ['production'], skipTestnet: true },
    remediation:
      'Fund the pauser wallet with native gas so it can broadcast pauseDiamond() in an incident.',
    run: async (ctx) => {
      if (ctx.isTron && ctx.tronWeb) {
        const pauserTronAddress = ensureTronAddress(
          ctx.pauserWallet,
          ctx.tronWeb
        )
        const balanceSun = await ctx.tronWeb.trx.getBalance(pauserTronAddress)
        if (!balanceSun)
          ctx.logError(`Pauser wallet ${pauserTronAddress} has no TRX balance`)
        else
          consola.success(
            `Pauser wallet ${pauserTronAddress} is funded: ${
              balanceSun / 1e6
            } TRX`
          )
        return
      }

      if (!ctx.publicClient) return
      const balance = await ctx.publicClient.getBalance({
        address: ctx.pauserWallet as Address,
      })
      if (!balance)
        ctx.logError(`Pauser wallet ${ctx.pauserWallet} has no native balance`)
      else
        consola.success(
          `Pauser wallet ${ctx.pauserWallet} is funded: ${formatEther(balance)}`
        )
    },
  },
  {
    name: 'refund-wallet-access',
    description:
      'Refund wallet can execute its approved selectors on the diamond',
    severity: 'error',
    scope: {},
    run: async (ctx) => {
      const refundSelectors = ctx.globalConfig.approvedSelectorsForRefundWallet

      if (ctx.isTron && ctx.tronWeb) {
        const refundTronAddress = ensureTronAddress(
          ctx.refundWallet,
          ctx.tronWeb
        )
        for (const selector of refundSelectors) {
          try {
            const normalizedSelector = normalizeSelector(selector.selector)
            const canExecute = await callTronContractBoolean(
              ctx.tronWeb,
              ctx.diamondAddress,
              'addressCanExecuteMethod(bytes4,address)',
              [
                { type: 'bytes4', value: normalizedSelector },
                { type: 'address', value: refundTronAddress },
              ],
              'function addressCanExecuteMethod(bytes4,address) external view returns (bool)'
            )
            if (!canExecute)
              ctx.logError(
                `Refund wallet ${refundTronAddress} cannot execute ${selector.name} (${normalizedSelector})`
              )
            else
              consola.success(
                `Refund wallet ${refundTronAddress} can execute ${selector.name} (${normalizedSelector})`
              )
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : String(error)
            ctx.logError(
              `Failed to check access permission for ${selector.name}: ${errorMessage}`
            )
          }
        }
      } else if (ctx.publicClient) {
        const accessManager = getContract({
          address: ctx.diamondAddress as Address,
          abi: parseAbi([
            'function addressCanExecuteMethod(bytes4,address) external view returns (bool)',
          ]),
          client: ctx.publicClient,
        })

        for (const selector of refundSelectors) {
          const normalizedSelector = normalizeSelector(selector.selector)
          if (
            !(await accessManager.read.addressCanExecuteMethod([
              normalizedSelector,
              ctx.refundWallet as Address,
            ]))
          )
            ctx.logError(
              `Refund wallet ${ctx.refundWallet} cannot execute ${selector.name} (${normalizedSelector})`
            )
          else
            consola.success(
              `Refund wallet ${ctx.refundWallet} can execute ${selector.name} (${normalizedSelector})`
            )
        }
      }
    },
  },
  {
    name: 'no-duplicate-selectors',
    description: 'No function selector is registered by more than one facet',
    severity: 'error',
    scope: {},
    readsOnChainFacets: true,
    remediation:
      'A selector maps to two facets — a broken diamondCut; remove the duplicate registration.',
    run: async (ctx) => {
      if (ctx.onChainFacets.length === 0) {
        consola.info(
          'On-chain facet list unavailable; skipping duplicate-selector check'
        )
        return
      }
      const duplicates = findDuplicateSelectors(ctx.onChainFacets)
      if (duplicates.length === 0)
        consola.success('No duplicate selectors across facets')
      else
        for (const dup of duplicates)
          ctx.logError(
            `Selector ${
              dup.selector
            } is registered by multiple facets: ${dup.addresses.join(', ')}`
          )
    },
  },
  {
    name: 'no-unexpected-facets',
    description: 'Every on-chain facet address is a known deployed contract',
    severity: 'warning',
    scope: {},
    readsOnChainFacets: true,
    run: async (ctx) => {
      if (ctx.onChainFacets.length === 0) {
        consola.info(
          'On-chain facet list unavailable; skipping unexpected-facet check'
        )
        return
      }
      const knownAddresses = new Set(
        Object.values(ctx.deployedContracts).map((a) => String(a).toLowerCase())
      )
      const compiledSelectors =
        ctx.compiledFacetSelectors ?? loadCompiledFacetSelectors()
      let unexpected = 0
      for (const facet of ctx.onChainFacets)
        if (!knownAddresses.has(facet.address.toLowerCase())) {
          unexpected++
          const identified = identifyFacetBySelectorSet(
            facet.selectors,
            compiledSelectors
          )
          if (identified)
            ctx.logWarn(
              `Facet ${facet.address} is registered on-chain but absent from the deploy log; its selectors match ${identified} - confirm whether this is the current build before recording it in deployments/${ctx.networkLower}.json, since a superseded deployment can still match`
            )
          // Without build output there is nothing to match against, so say that rather than
          // reporting an identity check that never ran.
          else if (Object.keys(compiledSelectors).length === 0)
            ctx.logWarn(
              `Facet ${facet.address} is registered on-chain but absent from the deploy log (no build output available to identify it - run 'forge build')`
            )
          else
            ctx.logWarn(
              `Facet ${facet.address} is registered on-chain but absent from the deploy log, and no compiled selector set identifies it (unexpected/rogue facet, or a retired contract whose source is gone)`
            )
        }
      if (unexpected === 0)
        consola.success('All on-chain facets are known deployed contracts')
    },
  },
  {
    name: 'no-stale-registered-facets',
    description:
      'Deprecated facets still routed on-chain are covered by an open parked-removal task',
    severity: 'warning',
    // skipTestnet: the parked queue is a production-mainnet construct — testnet
    // diamonds are EOA-owned and clean up directly, so queue coverage is
    // meaningless there and the warning would never resolve.
    scope: { environments: ['production'], skipTestnet: true },
    readsOnChainFacets: true,
    remediation:
      'Enqueue the removal (script/deploy/safe/enqueue-parked-task.ts, with the deprecation PR URL) or run `cleanUpProdDiamond --auto --network <network>` (docs/DeferredDiamondCleanupQueue.md).',
    run: async (ctx) => {
      if (ctx.onChainFacets.length === 0) {
        consola.info(
          'On-chain facet list unavailable; skipping stale-facet check'
        )
        return
      }
      const expectedNames = getExpectedFacetNames(
        ctx.networkLower,
        EnvironmentEnum.production
      )
      if (!expectedNames) {
        consola.info(
          `No LiFiDiamond target-state entry for ${ctx.networkLower}/production; skipping stale-facet check`
        )
        return
      }

      // Stale = deprecated (source deleted), never target-state drift — the same
      // source-gone gate the removal engine applies (see findDeprecatedLiveFacets).
      const deprecated = findDeprecatedLiveFacets({
        networkLower: ctx.networkLower,
        environment: EnvironmentEnum.production,
        onChainFacets: ctx.onChainFacets,
        deployedContracts: ctx.deployedContracts,
        expectedNames,
        protectedNames: getProtectedNames(),
        sourceNames: cachedSourceContractNames(),
      })
      if (deprecated.length === 0) {
        consola.success('No stale registered facets')
        return
      }

      // Only stale networks consult the queue (fetched once per process — see
      // fetchOpenParkedAddressesByNetwork). Coverage is keyed by ADDRESS, like
      // the drain and the reconcile: a name maps to one deploy-log address, so a
      // task whose address does not match the stale facet on-chain covers
      // nothing the drain would actually remove — counting it as coverage would
      // silence this backstop for the very facet it exists to surface
      // (co-registered versions, EXSC-750/EXSC-775).
      const openParked = await fetchOpenParkedAddressesByNetwork()
      if ('unreachable' in openParked) {
        // An unreachable queue must not turn every parked removal into a false
        // alarm — surface the reduced coverage instead of guessing.
        ctx.logWarn(
          `Parked-task queue unreachable — stale-facet coverage check skipped (${deprecated.length} stale facet(s) unverified): ${openParked.unreachable}`
        )
        return
      }
      const openParkedAddresses =
        openParked.get(ctx.networkLower) ?? new Set<string>()

      const { parked, unparked } = splitByParkedCoverage(
        deprecated,
        openParkedAddresses
      )
      if (parked.length > 0)
        consola.info(
          `${
            parked.length
          } deprecated facet(s) awaiting their parked removal (expected-pending): ${parked
            .map((f) => f.name)
            .join(', ')}`
        )
      // One aggregated warning per network, not one per facet: the fleet-wide
      // backlog is large enough that per-facet lines would drown the report.
      if (unparked.length > 0)
        ctx.logWarn(
          `${
            unparked.length
          } deprecated facet(s) still routed with NO open parked-removal task: ${unparked
            .map((f) => `${f.name} (${f.address})`)
            .join(', ')}`
        )
      else
        consola.success(
          'All stale registered facets are covered by parked removals'
        )
    },
  },
  {
    name: 'safe-config',
    description: 'Governance Safe has the expected owners and threshold',
    severity: 'error',
    scope: {
      environments: ['production'],
      chains: 'evm-only',
      skipTestnet: true,
    },
    run: async (ctx) => {
      if (!ctx.networkConfig.safeAddress) {
        consola.warn('SAFE address not configured')
        return
      }
      if (!ctx.publicClient) return

      const safeOwners = ctx.globalConfig.safeOwners
      const safeAddress = ctx.networkConfig.safeAddress

      try {
        const { getSafeInfoFromContract } = await import('./safe/safe-utils')
        const safeInfo = await getSafeInfoFromContract(
          ctx.publicClient,
          safeAddress as Address
        )

        for (const o in safeOwners) {
          const safeOwnerAddr = safeOwners[o]
          if (!safeOwnerAddr) continue
          const safeOwner = getAddress(safeOwnerAddr)
          const isOwner = safeInfo.owners.some(
            (owner) => getAddress(owner) === safeOwner
          )
          if (!isOwner)
            ctx.logError(`SAFE owner ${safeOwner} not in SAFE configuration`)
          else
            consola.success(`SAFE owner ${safeOwner} is in SAFE configuration`)
        }

        if (safeInfo.threshold < BigInt(SAFE_THRESHOLD))
          ctx.logError(
            `SAFE signature threshold is ${safeInfo.threshold}, expected at least ${SAFE_THRESHOLD}`
          )
        else
          consola.success(`SAFE signature threshold is ${safeInfo.threshold}`)

        consola.info(`Current SAFE nonce: ${safeInfo.nonce}`)
      } catch (error) {
        ctx.logError(`Failed to get SAFE information: ${error}`)
      }
    },
  },
]

/**
 * Execute one invariant against an isolated view of the context, then merge its result.
 *
 * Each invariant logs into its own `errors`/`warnings` arrays (not the shared ones) so that
 * (a) invariants can run concurrently without clobbering each other's error accounting, and
 * (b) a fatal failure can be cleanly re-verified once: read-only checks are idempotent, so a
 * failure that does not reproduce on a second run was a transient RPC blip, not real drift.
 * `onChainFacets` stays shared (same array reference) — `facets-registered` mutates it in
 * place so the phase-2 consumers see it.
 *
 * @returns true if the invariant failed (an error persisted after re-verification).
 */
async function executeInvariant(
  baseCtx: IHealthCheckContext,
  invariant: IHealthCheckInvariant
): Promise<boolean> {
  // Do NOT format the severity as a `[error]`-style prefix here: this banner prints once per
  // invariant per network, so a level-looking token makes every passing check match a grep for
  // '[error]' in the CI log and makes a healthy run read as mass failure. Keep it a plain label.
  consola.box(
    `${invariant.name} — ${invariant.description} (severity: ${invariant.severity})`
  )
  const errors: string[] = []
  const warnings: string[] = []
  const localCtx: IHealthCheckContext = {
    ...baseCtx,
    errors,
    warnings,
    logError: (msg: string) => {
      consola.error(msg)
      errors.push(msg)
    },
    logWarn: (msg: string) => {
      consola.warn(msg)
      warnings.push(msg)
    },
  }

  const runOnce = async () => {
    try {
      await invariant.run(localCtx)
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      localCtx.logError(`[${invariant.name}] threw: ${errorMessage}`)
    }
  }

  await runOnce()

  // Re-verify a fatal failure once before recording it — guards against transient RPC errors
  // paging on a green fleet. Only error-severity failures are re-checked (warnings are non-fatal).
  if (invariant.severity === 'error' && errors.length > 0) {
    errors.length = 0
    warnings.length = 0
    // A lagging RPC node can return stale registry state as a SUCCESS, which the shared cache
    // would replay here and defeat the point of re-verifying. Only this pass gets a private cache;
    // invariants still running concurrently keep their shared entries.
    localCtx.peripheryRegistryCache = new Map()
    await runOnce()
    if (errors.length === 0)
      consola.info(`↻ [${invariant.name}] recovered on re-verify (transient)`)
  }

  const failed = errors.length > 0
  if (failed && invariant.remediation)
    consola.info(`💡 ${invariant.name}: ${invariant.remediation}`)

  baseCtx.errors.push(...errors)
  baseCtx.warnings.push(...warnings)
  return failed
}

/**
 * Run the given invariants against one network's context. Applicability is decided by
 * {@link isInvariantApplicable} and per-network carve-outs by {@link getInvariantExclusion}.
 *
 * Execution is phased for both correctness and efficiency:
 * - Phase 0: `haltIfFailed` prerequisites (e.g. diamond deployed) run first, sequentially;
 *   if one fails the run stops (nothing else is meaningful).
 * - Phase 1: every other invariant that does NOT read `onChainFacets` runs concurrently —
 *   their on-chain reads overlap so the viem client (batch: multicall) aggregates them into
 *   a few multicall round-trips instead of dozens of sequential calls.
 * - Phase 2: invariants that read `onChainFacets` run concurrently after phase 1's barrier,
 *   by which point `facets-registered` has populated it.
 *
 * Results accumulate in `ctx.errors` / `ctx.warnings`.
 */
export async function runHealthCheckInvariants(
  ctx: IHealthCheckContext,
  invariants: IHealthCheckInvariant[] = HEALTH_CHECK_INVARIANTS
): Promise<void> {
  const active = invariants.filter((invariant) => {
    if (!isInvariantApplicable(invariant, ctx)) {
      consola.info(`⏭  Skipping [${invariant.name}] (out of scope)`)
      return false
    }
    const exclusion = getInvariantExclusion(invariant.name, ctx.networkLower)
    if (exclusion) {
      // Surface the carve-out (never a silent skip) so it is visible in the run output.
      consola.info(
        `⏭  Skipping [${invariant.name}] on ${ctx.networkLower} — excluded: ${exclusion.reason}`
      )
      return false
    }
    return true
  })

  for (const invariant of active.filter((i) => i.haltIfFailed)) {
    const failed = await executeInvariant(ctx, invariant)
    if (failed) {
      consola.warn(
        `Halting further checks: prerequisite invariant '${invariant.name}' failed.`
      )
      return
    }
  }

  const rest = active.filter((i) => !i.haltIfFailed)
  await Promise.all(
    rest
      .filter((i) => !i.readsOnChainFacets)
      .map((i) => executeInvariant(ctx, i))
  )
  await Promise.all(
    rest
      .filter((i) => i.readsOnChainFacets)
      .map((i) => executeInvariant(ctx, i))
  )
}
