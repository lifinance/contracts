import type networks from '../../config/networks.json'

export type SupportedChain = keyof typeof networks

/**
 * Subset of EVM hardfork labels used for Safe local bytecode (`safe/london` vs `safe/cancun`)
 * and `networks.json` → `deployedWithEvmVersion`.
 */
export type EVMVersion = 'london' | 'cancun'

export interface INetworksObject {
  [key: string]: Omit<INetwork, 'id'>
}

export enum EnvironmentEnum {
  'staging',
  'production',
}

/**
 * Environment value for deployment artifact filenames (`''` vs `'staging.'` prefix).
 * CLI/config often use `'production' | 'staging'`; scripts typically use {@link EnvironmentEnum} (numeric).
 */
export type DeploymentFileSuffixInput =
  | EnvironmentEnum
  | keyof typeof EnvironmentEnum
  | string

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
  deployedWithEvmVersion: string
  deployedWithSolcVersion: string
  gasZipChainId: number
  id: string
  isZkEVM: boolean
  safeApiUrl?: string
  safeWebUrl?: string
  create3Factory?: string
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
