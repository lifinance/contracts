/**
 * Violation: Type definitions don't follow naming conventions.
 * 
 * Convention violations:
 * - Interfaces MUST start with `I` prefix (e.g., INetwork, ITransferResult)
 * - Enums MUST use PascalCase with `Enum` suffix (e.g., EnvironmentEnum)
 * - Type aliases use PascalCase without prefix (e.g., SupportedChain, HexString)
 * 
 * This file violates by defining interfaces without `I` prefix and enums without `Enum` suffix.
 */

import { consola } from 'consola'

// Violation: Interface doesn't start with `I` prefix
export interface Network {
  name: string
  chainId: number
}

// Violation: Interface doesn't start with `I` prefix
export interface TransferResult {
  success: boolean
  txHash: string
}

// Violation: Enum doesn't have `Enum` suffix
export enum Environment {
  staging = 'staging',
  production = 'production',
}

// Violation: Enum doesn't have `Enum` suffix
export enum Status {
  pending = 'pending',
  completed = 'completed',
}

// Violation: Type alias uses lowercase (should be PascalCase)
export type networkName = string

// Violation: Type alias uses camelCase (should be PascalCase)
export type transferHash = string

export function badFunction(network: Network, result: TransferResult) {
  // Function implementation...
}
