import type networks from '../../config/networks.json'

export type SupportedChain = keyof typeof networks

export interface INetworksObject {
  [key: string]: Omit<INetwork, 'id'>
}

export enum EnvironmentEnum {
  'staging',
  'production',
}

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
