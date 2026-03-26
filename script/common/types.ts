/**
 * Shared TypeScript types used across deploy scripts and utilities.
 * Import from here instead of defining duplicates in individual script files.
 */

import type networks from '../../config/networks.json'

export type SupportedChain = keyof typeof networks

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
}

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
