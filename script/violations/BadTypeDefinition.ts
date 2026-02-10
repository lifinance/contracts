/**
 * Violation: Type definitions don't follow naming conventions.
 * 
 * Convention violations:
 * - Interfaces MUST start with `I` prefix (e.g., INetwork, ITransferResult) - hard requirement enforced by ESLint
 * - Enums MUST use PascalCase with `Enum` suffix (e.g., EnvironmentEnum)
 * - Type aliases use PascalCase without prefix (e.g., SupportedChain, HexString)
 * - Always check existing types before defining new ones: Search in order: TypeChain types, viem types, script/common/types.ts
 * - Reuse existing types over defining duplicates
 * 
 * This file violates by defining interfaces without `I` prefix and enums without `Enum` suffix.
 */

import { consola } from 'consola'
// Violation: Should check existing types in script/common/types.ts first (INetwork already exists)
// Violation: Should reuse SupportedChain from script/common/types.ts instead of defining new type

// Violation: Interface doesn't start with `I` prefix (ESLint should catch this)
export interface Network {
  name: string
  chainId: number
}

// Violation: Interface doesn't start with `I` prefix (ESLint should catch this)
export interface TransferResult {
  success: boolean
  txHash: string
}

// Violation: Enum doesn't have `Enum` suffix (should be EnvironmentEnum)
export enum Environment {
  staging = 'staging',
  production = 'production',
}

// Violation: Enum doesn't have `Enum` suffix (should be StatusEnum)
export enum Status {
  pending = 'pending',
  completed = 'completed',
}

// Violation: Type alias uses lowercase (should be PascalCase: NetworkName)
export type networkName = string

// Violation: Type alias uses camelCase (should be PascalCase: TransferHash)
export type transferHash = string

// Violation: Should use existing INetwork from script/common/types.ts instead of defining duplicate
export function badFunction(network: Network, result: TransferResult, env: Environment, status: Status) {
  consola.info(`Network: ${network.name}, Result: ${result.success}, Env: ${env}, Status: ${status}`)
}
