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
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import type { IWhitelistConfig, TargetState } from '../common/types'
import { normalizeSelector } from '../utils/utils'

import { SAFE_THRESHOLD } from './shared/constants'
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
  parseTroncastNestedArray,
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
  feeCollectorOwner: string
  pauserWallet: string
  /** Populated by the `facets-registered` invariant; reused by selector/facet-set invariants. */
  onChainFacets: IOnChainFacet[]
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
 * Binary-search the earliest block at which `address` has code — its deployment block —
 * in ~log2(latest) `getCode` calls. Used to bound event queries: a full-history
 * `fromBlock: 'earliest'` scan is range-capped (throws) or silently truncated (false pass)
 * by some RPC providers on long-lived mainnet proxies. Assumes code presence is monotonic
 * (contract not self-destructed), which holds for LI.FI periphery.
 */
async function findDeploymentBlock(
  publicClient: PublicClient,
  address: Address
): Promise<bigint> {
  const hasCode = async (blockNumber: bigint): Promise<boolean> => {
    const code = await publicClient.getCode({ address, blockNumber })
    return code !== undefined && code !== '0x'
  }

  // Defensive: if code exists at genesis (never for our contracts), earliest is 0.
  if (await hasCode(0n)) return 0n

  // Invariant: no code at `low`, code at `high`; converge to the first block with code.
  let low = 0n
  let high = await publicClient.getBlockNumber()
  while (high - low > 1n) {
    const mid = (low + high) / 2n
    if (await hasCode(mid)) high = mid
    else low = mid
  }
  return high
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

const getExpectedPairs = async (
  network: string,
  deployedContracts: Record<string, Address | string>,
  whitelistConfig: IWhitelistConfig,
  logError: (msg: string) => void,
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
        for (const peripheryContract of networkPeripheryContracts) {
          const contractAddr = deployedContracts[peripheryContract.name]
          if (contractAddr) {
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

    let parsed: unknown[]
    try {
      parsed = JSON.parse(onChainDataOutput.trim())
    } catch {
      const trimmed = onChainDataOutput.trim()
      if (!trimmed.startsWith('[')) {
        throw new Error('Expected array format')
      }
      const [parsedArray] = parseTroncastNestedArray(trimmed, 0)
      parsed = parsedArray as unknown[]
    }

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
        consola.warn(
          `\n💡 To fix missing pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist ${network} ${environment}`
        )
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
        consola.warn(
          `\n💡 To fix stale pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist ${network} ${environment}`
        )
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logError(`Failed during whitelist integrity checks: ${errorMessage}`)
  }
}

/** Every Receiver periphery contract and the getter that exposes its bound Executor. */
const RECEIVER_EXECUTOR_GETTERS: Array<{ name: string; getter: string }> = [
  { name: 'ReceiverAcrossV3', getter: 'executor' },
  { name: 'ReceiverAcrossV4', getter: 'EXECUTOR' },
  { name: 'ReceiverChainflip', getter: 'executor' },
  { name: 'ReceiverOIF', getter: 'EXECUTOR' },
  { name: 'ReceiverStargateV2', getter: 'executor' },
]

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
      const executorAddress = ctx.deployedContracts['Executor']
      if (!executorAddress) {
        ctx.logError(
          'Executor missing from deploy log; cannot verify Receivers'
        )
        return
      }
      const expectedExecutor = getAddress(executorAddress as Address)

      for (const { name, getter } of RECEIVER_EXECUTOR_GETTERS) {
        const receiverAddress = ctx.deployedContracts[name]
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
        const boundExecutor = getAddress(await readExecutor())

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

            const cleanedAddress = registeredAddressOutput
              .trim()
              .replace(/^["']|["']$/g, '')
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
        ctx.logError('Whitelist configuration not available')
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
  {
    name: 'feecollector-owner',
    description: 'FeeCollector owner is the fee-collector owner wallet',
    severity: 'error',
    scope: {},
    run: async (ctx) => {
      if (ctx.isTron && ctx.tronWeb && ctx.tronRpcUrl)
        await checkOwnershipTron(
          'FeeCollector',
          ctx.feeCollectorOwner,
          ctx.deployedContracts,
          ctx.tronRpcUrl,
          ctx.tronWeb,
          ctx.logError
        )
      else if (ctx.publicClient)
        await checkOwnership(
          'FeeCollector',
          ctx.feeCollectorOwner,
          ctx,
          ctx.publicClient
        )
    },
  },
  {
    name: 'receiver-owner',
    description: 'Receiver owner is the refund wallet',
    severity: 'error',
    scope: {},
    run: async (ctx) => {
      if (ctx.isTron && ctx.tronWeb && ctx.tronRpcUrl)
        await checkOwnershipTron(
          'Receiver',
          ctx.refundWallet,
          ctx.deployedContracts,
          ctx.tronRpcUrl,
          ctx.tronWeb,
          ctx.logError
        )
      else if (ctx.publicClient)
        await checkOwnership(
          'Receiver',
          ctx.refundWallet,
          ctx,
          ctx.publicClient
        )
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
      let unexpected = 0
      for (const facet of ctx.onChainFacets)
        if (!knownAddresses.has(facet.address.toLowerCase())) {
          unexpected++
          ctx.logWarn(
            `Facet ${facet.address} is registered on-chain but absent from the deploy log (possible unexpected/rogue facet or stale deploy log)`
          )
        }
      if (unexpected === 0)
        consola.success('All on-chain facets are known deployed contracts')
    },
  },
  {
    name: 'no-unexpected-erc20proxy-callers',
    description: 'Only the Executor is authorized on the ERC20Proxy',
    severity: 'warning',
    scope: { environments: ['production'], chains: 'evm-only' },
    run: async (ctx) => {
      if (!ctx.publicClient) return
      const erc20ProxyAddress = ctx.deployedContracts['ERC20Proxy']
      const executorAddress = ctx.deployedContracts['Executor']
      if (!erc20ProxyAddress || !executorAddress) return

      const expectedAuthorized = new Set([
        getAddress(executorAddress as Address).toLowerCase(),
      ])

      // ERC20Proxy exposes no enumerator for authorizedCallers, so reconstruct the current
      // set from AuthorizationChanged events. Bound the scan to the proxy's deployment block:
      // a `fromBlock: 'earliest'` full-history query is range-capped (throws) or silently
      // truncated (false pass) by some providers on long-lived mainnet proxies. The events are
      // sparse, so one bounded query returns the full set. Any failure surfaces as a visible
      // warning (never a silent pass).
      try {
        const erc20Proxy = getAddress(erc20ProxyAddress as Address)
        const fromBlock = await findDeploymentBlock(
          ctx.publicClient,
          erc20Proxy
        )
        const logs = await ctx.publicClient.getContractEvents({
          address: erc20Proxy,
          abi: parseAbi([
            'event AuthorizationChanged(address indexed caller, bool authorized)',
          ]),
          eventName: 'AuthorizationChanged',
          fromBlock,
          toBlock: 'latest',
        })

        const authorized = new Map<string, boolean>()
        for (const log of logs) {
          const args = log.args as { caller?: Address; authorized?: boolean }
          if (args.caller !== undefined && args.authorized !== undefined)
            authorized.set(
              getAddress(args.caller).toLowerCase(),
              args.authorized
            )
        }

        const unexpected = [...authorized.entries()]
          .filter(([addr, isAuth]) => isAuth && !expectedAuthorized.has(addr))
          .map(([addr]) => addr)

        if (unexpected.length === 0)
          consola.success('Only the Executor is authorized on the ERC20Proxy')
        else
          ctx.logWarn(
            `ERC20Proxy authorizes unexpected caller(s) besides the Executor: ${unexpected.join(
              ', '
            )}`
          )
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        ctx.logWarn(
          `Could not enumerate ERC20Proxy authorized callers (RPC log range limit?); skipping: ${errorMessage}`
        )
      }
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
  consola.box(
    `[${invariant.severity}] ${invariant.name} — ${invariant.description}`
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
