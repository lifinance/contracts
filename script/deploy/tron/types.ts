import type { TronWeb } from 'tronweb'
import type { Address, Hex } from 'viem'

/** Tron TVM network keys in `config/networks.json` (mainnet / Shasta). */
export type TronTvmNetworkName = 'tron' | 'tronshasta'

/** Options for the propose-to-safe-tron CLI script. */
export interface IProposeToSafeTronOptions {
  dryRun?: boolean
  /** Base58 contract address for generic proposals */
  to?: string
  /** Hex calldata for generic proposals */
  calldata?: Hex
  /**
   * When true (default for generic), Safe calls Timelock.scheduleBatch(Diamond, payload).
   * When false, use --direct instead (Safe calls target directly).
   */
  timelock?: boolean
  /** When true with generic mode, Safe → target with calldata (no timelock schedule). */
  direct?: boolean
  privateKey?: string
}

/** Result of broadcasting Safe `execTransaction` on Tron via TronWeb. */
export interface IExecuteSafeExecTronWebResult {
  txId: string
  hash: Hex
}

/** Params for Tron Safe `execTransaction` broadcast (signing key supplied separately). */
export interface ITronSafeExecParams {
  networkName: TronTvmNetworkName
  safeAddressEvm: Address
  to: Address
  value: bigint
  data: Hex
  operation: number
  signatures: Hex
  confirmTimeoutMs?: number
}

export type IBroadcastTronSafeExecParams = ITronSafeExecParams & {
  privateKeyHex: string
}

export interface ICreateTronWebOptions {
  /**
   * RPC URL as in env (may end with `/jsonrpc` or trailing slashes).
   * When `networkKey` is `tron` or `tronshasta`, normalized to TronWeb’s native HTTP root
   * via `tronWebFullHostFromRpcUrl`. Otherwise only trailing slashes are trimmed.
   */
  rpcUrl: string
  networkKey?: TronTvmNetworkName
  privateKey?: string
  headers?: Record<string, string>
  /**
   * Optional TronGrid PRO API key. Used only when `headers` does not already set
   * `TRON-PRO-API-KEY`. If still unset and the resolved host looks like TronGrid, the key is
   * taken from the environment via `getTronGridAPIKey` (e.g. `TRONGRID_API_KEY`).
   */
  tronProApiKey?: string
  /** Passed to `getTronGridAPIKey` when resolving the key from the environment. */
  verbose?: boolean
}

/** Generic contract-call broadcast (any contract, any calldata) via TronWeb. */
export interface IBroadcastTronContractCallParams {
  networkKey: TronTvmNetworkName
  privateKeyHex: string
  contractAddress: Address
  calldata: Hex
  callValue?: bigint
  confirmTimeoutMs?: number
}

export interface IBroadcastTronContractCallResult {
  txId: string
  hash: Hex
}

/** Parameters for estimating contract call energy via TRON triggerconstantcontract API */
export interface IEstimateContractCallEnergyParams {
  fullHost: string
  tronWeb: TronWeb
  contractAddressBase58: string
  functionSelector: string
  parameterHex: string
  safetyMargin?: number
  feeLimitForEstimation?: number
}

/** Cache entry for TRON energy/bandwidth prices with TTL */
export interface IPriceCache {
  energyPrice: number
  bandwidthPrice: number
  timestamp: number
}

/** Base shape for viem HTTP RPC transport (URL + optional fetch headers) */
export interface IViemRpcTransportConfigBase {
  url: string
  fetchOptions?: { headers: Record<string, string> }
}

/** Viem HTTP transport with optional retry tuning (e.g. TronGrid 429 backoff) */
export interface IViemRpcTransportConfig extends IViemRpcTransportConfigBase {
  retryCount?: number
  retryDelay?: number
}

/** Response from Tron getaccountresource (snake_case or camelCase from different clients) */
export interface IAccountResourceResponse {
  EnergyLimit?: number
  EnergyUsed?: number
  NetLimit?: number
  NetUsed?: number
  freeNetLimit?: number
  freeNetUsed?: number
  energy_limit?: number
  energy_used?: number
  net_limit?: number
  net_used?: number
  free_net_limit?: number
  free_net_used?: number
}

export interface ITronDeploymentConfig {
  /**
   * Tron RPC URL (env / `networks.json`). May include `/jsonrpc`; when `tvmNetworkKey` is set,
   * it is normalized for TronWeb and wallet HTTP APIs.
   */
  fullHost: string
  /** When set with a Tron TVM network key, {@link fullHost} is normalized (e.g. strip `/jsonrpc`). */
  tvmNetworkKey?: TronTvmNetworkName
  privateKey: string
  feeLimit?: number
  userFeePercentage?: number
  originEnergyLimit?: number
  safetyMargin?: number
  maxRetries?: number
  confirmationTimeout?: number
  verbose?: boolean
  dryRun?: boolean
  headers?: Record<string, string>
}

export interface ITronCostEstimate {
  energy: number
  bandwidth: number
  totalTrx: number
  feeLimit: number
  breakdown: {
    energyCost: number
    bandwidthCost: number
    energyFactor: number
    safetyMargin: number
  }
}

export interface ITronDeploymentResult {
  contractAddress: string
  transactionId: string
  deploymentTransaction: any
  receipt: any
  costEstimate: ITronCostEstimate
  actualCost: {
    energyUsed: number
    bandwidthUsed: number
    trxCost: number
  }
}

export interface IForgeArtifact {
  abi: any[]
  bytecode: {
    object: string
    sourceMap: string
    linkReferences: Record<string, any>
  }
  deployedBytecode: {
    object: string
    sourceMap: string
    linkReferences: Record<string, any>
  }
  methodIdentifiers: Record<string, string>
  rawMetadata: string
  metadata: {
    compiler: {
      version: string
    }
    language: string
    output: any
    settings: any
    sources: Record<string, any>
    version: number
  }
}

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

export interface IDiamondRegistrationResult {
  success: boolean
  transactionId?: string
  error?: string
}

/** Resume state for `deploy-safe-tron.ts` (singleton + factory addresses). */
export interface ITronSafeTemp {
  safeSingletonAddress?: string
  safeProxyFactoryAddress?: string
}
