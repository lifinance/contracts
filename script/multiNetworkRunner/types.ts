import type { PublicClient } from 'viem'

import type { INetwork, SupportedChain } from '../common/types'

export type EnvironmentName = 'production' | 'staging'

export type ExecutionGroupName = 'primary' | 'london' | 'zkevm'

export type TrackingStatus =
  | 'pending'
  | 'in_progress'
  | 'success'
  | 'failed'
  | 'skipped'

export interface INetworkConfig extends INetwork {
  id: SupportedChain
}

export interface IActionContext {
  network: INetworkConfig
  environment: EnvironmentName
  contract?: string
  rpcClient: PublicClient
  rpcEndpoints: IRpcEndpoint[]
  dryRun: boolean
}

export interface IActionResult {
  status: TrackingStatus
  error?: string
}

export interface IActionDefinition {
  id: string
  label: string
  isTx: boolean
  requiresContract?: boolean
  run: (context: IActionContext) => Promise<IActionResult>
}

export interface IExecutionGroup {
  name: ExecutionGroupName
  evmVersion?: string
  networks: INetworkConfig[]
}

export interface IExecutionPlan {
  groups: IExecutionGroup[]
  networks: INetworkConfig[]
}

export interface IRpcEndpoint {
  url: string
  source: 'env' | 'env-commented' | 'mongo'
  priority?: number
  isActive?: boolean
}

export interface IRetryConfig {
  retryCount: number
  retryDelayMs: number
  timeoutMs: number
}

export interface ITrackingActionEntry {
  status: TrackingStatus
  attempts: number
  lastAttempt: string | null
  error: string | null
}

export interface ITrackingState {
  runId: string
  environment: EnvironmentName
  createdAt: string
  actions: Array<{ id: string; label: string; paramsHash: string }>
  networks: Record<string, { actions: Record<string, ITrackingActionEntry> }>
}

// Type aliases for backward compatibility
export type NetworkConfig = INetworkConfig
export type ActionContext = IActionContext
export type ActionResult = IActionResult
export type ActionDefinition = IActionDefinition
export type ExecutionGroup = IExecutionGroup
export type ExecutionPlan = IExecutionPlan
export type RpcEndpoint = IRpcEndpoint
export type RetryConfig = IRetryConfig
export type TrackingActionEntry = ITrackingActionEntry
export type TrackingState = ITrackingState
