/**
 * LI.FI Diamond health check (single network).
 *
 * Reads the live on-chain configuration of one network's LiFiDiamond and its periphery
 * and asserts every invariant in {@link HEALTH_CHECK_INVARIANTS} holds. Invoke via
 * `bunx tsx ./script/deploy/healthCheck.ts --network <network> [--environment production|staging]`.
 * The check layer (what is asserted) lives in `healthCheckInvariants.ts`; this file builds
 * the per-network context and runs the registry. The reusable entry point is
 * {@link runHealthCheckForNetwork} (returns a result, never exits) so the multi-network
 * runner can fan it out in-process; the CLI wrapper maps that result to an exit code.
 */
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import { createPublicClient, getAddress, http, type PublicClient } from 'viem'

import type { TargetState } from '../common/types'
import { initTronWeb } from '../troncast/utils/tronweb'
import { getNetworkConfig, getRPCEnvVarName } from '../utils/utils'
import {
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
  isTestnetNetwork,
} from '../utils/viemScriptHelpers'

import targetStateImport from './_targetState.json'
import {
  runHealthCheckInvariants,
  type IHealthCheckContext,
} from './healthCheckInvariants'
import {
  getCoreFacets,
  getCorePeriphery,
  getTronWallet,
} from './shared/globalContractLists'

const targetState = targetStateImport as TargetState

/** Outcome of a single network's health check. */
export interface IHealthCheckNetworkResult {
  network: string
  status: 'passed' | 'failed' | 'skipped'
  errors: string[]
  warnings: string[]
  /** Set when status is 'skipped'. */
  skipReason?: string
}

/**
 * Run the health check for one network and return its result. Never calls `process.exit`
 * and never throws — any failure (including a missing deploy log) is captured as a failed
 * result — so it is safe to fan out concurrently in a single process.
 *
 * @param networkStr - Network key (as in config/networks.json).
 * @param environment - 'production' or 'staging' (validated by the caller).
 */
export async function runHealthCheckForNetwork(
  networkStr: string,
  environment: string
): Promise<IHealthCheckNetworkResult> {
  const networkLower = networkStr.toLowerCase()

  // Skip tronshasta testnet but allow tron mainnet.
  if (networkLower === 'tronshasta')
    return {
      network: networkStr,
      status: 'skipped',
      errors: [],
      warnings: [],
      skipReason: 'Health checks are not implemented for Tron Shasta testnet',
    }

  const errors: string[] = []
  const warnings: string[] = []

  try {
    const isTron = networkLower === 'tron'

    // Testnet networks have an EOA-owned diamond (deployerWallet) with no Safe
    // multisig or Timelock. Ownership and SAFE checks must reflect that.
    const isTestnet = isTestnetNetwork(networkLower)

    const { default: deployedContracts } = await import(
      `../../deployments/${networkLower}${
        environment === 'staging' ? '.staging' : ''
      }.json`
    )

    const { default: globalConfig } = await import('../../config/global.json')
    const { default: networksConfig } = await import(
      '../../config/networks.json'
    )

    // Optional bypass: config/networks.json skipHealthcheck (see INetwork.skipHealthcheck in script/common/types.ts).
    const networkEntry = (
      networksConfig as Record<
        string,
        { skipHealthcheck?: boolean } | undefined
      >
    )[networkLower]
    if (networkEntry?.skipHealthcheck === true)
      return {
        network: networkStr,
        status: 'skipped',
        errors: [],
        warnings: [],
        skipReason: 'skipHealthcheck: true in config/networks.json',
      }

    // Skip GasZip checks for networks where the integration is intentionally unsupported.
    const networkGasZipConfig = (
      networksConfig as Record<string, { gasZipChainId?: number } | undefined>
    )[networkLower]
    const supportsGasZip = (networkGasZipConfig?.gasZipChainId ?? 0) > 0

    const coreFacetExclusions = supportsGasZip ? [] : ['GasZipFacet']
    const coreFacetsToCheck = getCoreFacets({ exclude: coreFacetExclusions })

    // For staging, skip targetState checks as targetState is only for production.
    let nonCoreFacets: string[] = []
    let missingProductionTargetState = false
    if (environment === 'production') {
      const networkTarget = targetState[networkLower]?.production
      if (!networkTarget?.LiFiDiamond)
        // Surface (not silence): a production network with no target state means the
        // non-core facet comparison is skipped, i.e. reduced coverage.
        missingProductionTargetState = true
      else
        nonCoreFacets = Object.keys(networkTarget.LiFiDiamond).filter(
          (k) =>
            !coreFacetsToCheck.includes(k) &&
            !getCorePeriphery().includes(k) &&
            k !== 'LiFiDiamond' &&
            k.includes('Facet')
        )
    }

    let publicClient: PublicClient | undefined
    let tronWeb: TronWeb | undefined

    const networkConfig = getNetworkConfig(networkLower)

    const tronRpcUrl = isTron
      ? process.env[getRPCEnvVarName(networkLower)]?.trim() ||
        networkConfig.rpcUrl
      : undefined

    if (isTron)
      tronWeb = initTronWeb(
        'mainnet',
        undefined,
        tronRpcUrl ?? networkConfig.rpcUrl
      )
    else {
      const chain = getViemChainForNetworkName(networkLower)
      const rpcUrl = chain.rpcUrls.default.http[0]
      if (!rpcUrl)
        throw new Error(`No default RPC URL configured for ${networkLower}`)

      const {
        url: transportUrl,
        fetchOptions,
        retryCount,
        retryDelay,
      } = getTransportConfigFromRpcUrl(rpcUrl)
      publicClient = createPublicClient({
        batch: { multicall: true },
        chain,
        transport: http(transportUrl, {
          ...(fetchOptions ? { fetchOptions } : {}),
          ...(retryCount !== undefined ? { retryCount } : {}),
          ...(retryDelay !== undefined ? { retryDelay } : {}),
        }),
      })
    }

    // Wallet addresses (Tron or EVM format)
    let deployerWallet: string
    let refundWallet: string
    let feeCollectorOwner: string

    if (isTron) {
      if (!tronWeb) throw new Error('TronWeb not initialized')

      deployerWallet = getTronWallet('deployerWallet', { tronWeb })
      refundWallet = getTronWallet('refundWallet', { tronWeb })
      feeCollectorOwner = getTronWallet('feeCollectorOwner', { tronWeb })
    } else {
      // Testnets are owned by deployerWallet regardless of environment.
      deployerWallet = getAddress(
        !isTestnet && environment === 'staging'
          ? globalConfig.devWallet
          : globalConfig.deployerWallet
      )
      refundWallet = getAddress(globalConfig.refundWallet)
      feeCollectorOwner = getAddress(globalConfig.feeCollectorOwner)
    }

    const ctx: IHealthCheckContext = {
      network: networkStr,
      networkLower,
      environment,
      isTron,
      isTestnet,
      supportsGasZip,
      deployedContracts,
      globalConfig,
      targetState,
      networkConfig,
      publicClient,
      tronWeb,
      tronRpcUrl,
      diamondAddress: deployedContracts['LiFiDiamond'],
      coreFacetsToCheck,
      nonCoreFacets,
      deployerWallet,
      refundWallet,
      feeCollectorOwner,
      onChainFacets: [],
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

    if (missingProductionTargetState)
      ctx.logWarn(
        `Network '${networkLower}' has no production target state; non-core facet coverage is reduced`
      )

    consola.info(`[${networkLower}] Running post deployment checks...\n`)

    await runHealthCheckInvariants(ctx)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    errors.push(`[${networkLower}] health check aborted: ${errorMessage}`)
  }

  return {
    network: networkStr,
    status: errors.length ? 'failed' : 'passed',
    errors,
    warnings,
  }
}

const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Health Check',
    description: 'Check that the diamond is configured correctly',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment to check (production or staging)',
      default: 'production',
    },
  },
  async run({ args }) {
    const { network, environment } = args
    const networkStr = Array.isArray(network) ? network[0] : (network as string)

    // Reject typos early: an unsupported value would load production deploy logs
    // (anything but 'staging') while skipping production-only checks (anything but
    // 'production'), silently running reduced coverage against production data.
    if (environment !== 'production' && environment !== 'staging') {
      consola.error(
        `Unsupported environment '${String(
          environment
        )}'; expected 'production' or 'staging'`
      )
      process.exit(1)
    }

    const result = await runHealthCheckForNetwork(networkStr, environment)

    // this line ensures that all logs are actually written before the script ends
    process.stdout.write('', () => process.stdout.end())

    if (result.status === 'skipped') {
      consola.info(`Skipping all tests: ${result.skipReason}`)
      process.exit(0)
    }
    if (result.warnings.length)
      consola.warn(
        `${result.warnings.length} warning(s) found (non-fatal, review recommended)`
      )
    if (result.status === 'failed') {
      consola.error(`${result.errors.length} Errors found in deployment`)
      process.exit(1)
    }
    consola.success('Deployment checks passed')
    process.exit(0)
  },
})

// Guard so importing this module does not execute the CLI (entry-point-only run).
if (import.meta.main) runMain(main)
