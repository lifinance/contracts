/**
 * Shared TypeScript types used across deploy scripts and utilities.
 * Import from here instead of defining duplicates in individual script files.
 */
import type { Address, Hex, TransactionReceipt } from 'viem'

import type globalConfigJson from '../../config/global.json'
import type networks from '../../config/networks.json'

/** Shape of `config/global.json` (for deriving wallet keys and config-driven types). */
export type TGlobalConfig = typeof globalConfigJson

/** Keys of `tronWallets` in global config (Tron base58 addresses). */
export type TTronWalletName = keyof TGlobalConfig['tronWallets']

export type SupportedChain = keyof typeof networks

/** Tron network keys — hardcoded because they are never in networks.json (Tron is non-EVM). */
export type TronNetworkKey = 'tron' | 'tronshasta'

/** Any network key accepted by deployment scripts: EVM chains from config plus Tron. */
export type NetworkKey = SupportedChain | TronNetworkKey

type NetworkRow = (typeof networks)[keyof typeof networks]

/**
 * Every distinct `deployedWithEvmVersion` value in `config/networks.json`.
 */
export type DeployedEvmVersionLabel = NetworkRow['deployedWithEvmVersion']

/**
 * EVM hardfork labels used across scripts and config (e.g. `networks.json` → `deployedWithEvmVersion`,
 * validated fork names for deploy tooling, artifact paths such as `safe/<fork>/`).
 * Union is derived from `networks.json`, excluding placeholders (`n/a`, empty).
 */
export type EVMVersion = Exclude<Lowercase<DeployedEvmVersionLabel>, 'n/a' | ''>

/** Map of network name → network config (without the runtime-derived `id` field). */
export interface INetworksObject {
  [key: string]: Omit<INetwork, 'id'>
}

/** Deployment environment: controls which private key, deployment file suffix, and MongoDB collection are used. */
export enum EnvironmentEnum {
  production = 'production',
  staging = 'staging',
}

/**
 * Environment value for deployment artifact filenames (`''` vs `'staging.'` prefix).
 * Accepts {@link EnvironmentEnum} or arbitrary `string` (e.g. raw CLI args).
 */
export type DeploymentFileSuffixInput = EnvironmentEnum | string

export interface INetwork {
  name: string
  chainId: number
  nativeAddress: string
  nativeCurrency: string
  wrappedNativeAddress: string
  status: string
  type: string
  rpcUrl: string
  verificationType: string
  explorerUrl: string
  explorerApiUrl: string
  multicallAddress: string
  safeAddress: string
  deployedWithEvmVersion: DeployedEvmVersionLabel
  deployedWithSolcVersion: string
  gasZipChainId: number
  id: string
  isZkEVM: boolean
  safeApiUrl?: string
  safeWebUrl?: string
  create3Factory?: string
  converterAddress?: string
  devNotes?: string
  castSendAsync?: boolean
  /**
   * Custom verification flags to pass to forge verify-contract command.
   * Format: JSON object where keys are flag names and values are flag values (or null for flags without values).
   * Examples:
   *   Single flag with value: {"-e": "verifyContract"}
   *   Single flag without value: {"--skip-is-verified-check": null}
   *   Multiple flags: {"-e": "verifyContract", "--skip-is-verified-check": null}
   * These flags are appended to the verification command in the order specified.
   */
  customVerificationFlags?: Record<string, string | null>
  /**
   * When true, the deployment healthcheck (script/deploy/healthCheck.ts) exits successfully without running checks.
   * Use only on an exceptional basis when the healthcheck cannot pass otherwise (e.g. core periphery contracts
   * such as GasZipPeriphery or TokenWrapper are intentionally not deployed on that network).
   * Before merging: still run the healthcheck manually for that network and verify all addresses and configuration
   * are correct; this flag only allows CI to pass.
   */
  skipHealthcheck?: boolean
  /**
   * Chains with no native currency (`nativeCurrency: "N/A"`, e.g. tempo): the ERC20 token gas is
   * paid in by default (tempo: the pathUSD TIP-20 predeploy). Funding audits read this token's
   * balance instead of eth_getBalance, which returns a meaningless sentinel on such chains.
   */
  feeTokenAddress?: string
  /**
   * Optional companion to `feeTokenAddress`: a fee-preference manager exposing
   * `userTokens(address)` (tempo: the FeeManager predeploy). A non-zero per-account preference
   * overrides `feeTokenAddress` as the token that account pays gas with.
   */
  feeManagerAddress?: string
}

/** Parsed subset of `foundry.toml` used by script helpers that read default compiler/EVM settings. */
export interface IFoundryTomlConfig {
  profile?: {
    default?: {
      solc_version?: string
      evm_version?: string
    }
  }
}

export type IFoundryProfileDefaultConfig = NonNullable<
  NonNullable<IFoundryTomlConfig['profile']>['default']
>

/**
 * Whitelist configuration structure for DEX and Periphery contracts
 * Used in health check scripts to validate on-chain whitelist state
 */
export interface IWhitelistConfig {
  DEXS: Array<{
    name: string
    key: string
    contracts?: Record<
      string,
      Array<{
        address: string
        functions?: Record<string, string>
      }>
    >
  }>
  PERIPHERY?: Record<
    string,
    Array<{
      name: string
      address: string
      selectors: Array<{ selector: string; signature: string }>
    }>
  >
}

/**
 * Target state JSON structure for health checks
 * Maps network names to their production/staging deployment states
 */
export type TargetState = Record<
  string,
  {
    production?: {
      LiFiDiamond?: Record<string, string>
      [key: string]: Record<string, string> | undefined
    }
    staging?: {
      LiFiDiamond?: Record<string, string>
      [key: string]: Record<string, string> | undefined
    }
  }
>

export interface IDeploymentResult {
  contract: string
  address: string
  txId: string
  cost: number
  version: string
  status?: 'success' | 'failed' | 'existing'
}

export interface INetworkInfo {
  network: string
  block: number
  address: string
  balance: number
}

/** Parameters passed to the executor — the chain-agnostic subset of a Safe transaction. */
export interface IChainExecutionParams {
  safeAddress: Address
  to: Address
  value: bigint
  data: Hex
  operation: number
  signatures: Hex
}

/** Result of executing a Safe transaction on any chain. */
export interface IChainExecutionResult {
  /** Transaction hash (always 0x-prefixed hex). */
  hash: Hex
  /**
   * Normalized on-chain outcome once confirmed. `undefined` means the outcome
   * is still unknown (EVM receipt poll timed out) — the caller leaves the row
   * `submitted` for reconciliation to resolve. Tron has no reconciliation, so
   * its executor resolves this synchronously before returning.
   */
  status?: 'success' | 'reverted'
  /** Human-readable explorer URL for CLI display (e.g. TronScan). */
  explorerUrl?: string
  /** Formatted hash for CLI display (e.g. Tron strips 0x prefix). Falls back to `hash`. */
  displayHash?: string
}

/** Strategy interface for chain-specific Safe transaction execution. */
export interface IChainExecutor {
  executeTransaction: (
    params: IChainExecutionParams
  ) => Promise<IChainExecutionResult>
}

/** Parameters for a generic contract call (any contract, any calldata). */
export interface IChainCallParams {
  to: Address
  data: Hex
  value?: bigint
}

/** Result of a generic contract call on any chain. */
export interface IChainCallResult {
  /** Transaction hash (always 0x-prefixed hex). */
  hash: Hex
  /** On-chain receipt, if the chain supports synchronous confirmation. */
  receipt?: TransactionReceipt
  /** Gas used by the transaction (from receipt). */
  gasUsed?: bigint
  /** Human-readable explorer URL for CLI display. */
  explorerUrl?: string
}

/** Result of simulating a contract call (dry-run). */
export interface IChainSimulateResult {
  /** Estimated resource cost. */
  estimatedResource: bigint
  /** Label for the resource unit (for display). */
  resourceLabel: string
}

/** Options for proposing a Safe transaction (EVM). */
export interface IProposeToSafeOptions {
  network: string
  /** Target address, or one address per call when proposing multiple calls. */
  to: string | string[]
  /** Calldata, or one calldata per call (parallel to `to`). Multiple calls require `timelock`. */
  calldata: Hex | Hex[]
  timelock?: boolean
  dryRun?: boolean
  privateKey?: string
  rpcUrl?: string
  ledger?: boolean
  ledgerLive?: boolean
  accountIndex?: number
  derivationPath?: string
  safeAddress?: string
  calldataFile?: string
  nonce?: bigint
}

/** Strategy interface for chain-specific generic contract call broadcasting. */
export interface IChainCaller {
  /** The sender address used for broadcasting. */
  readonly senderAddress: Address
  /** Broadcast a contract call and return the result. */
  call: (params: IChainCallParams) => Promise<IChainCallResult>
  /** Simulate a contract call without broadcasting (dry-run). */
  simulate: (params: IChainCallParams) => Promise<IChainSimulateResult>
}
