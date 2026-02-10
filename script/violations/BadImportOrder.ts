/**
 * Violation: Imports are in incorrect order.
 * 
 * Convention violation: Imports MUST be ordered as:
 * 1. External libs (viem, consola, citty, dotenv)
 * 2. TypeChain types (typechain/)
 * 3. Config files
 * 4. Internal utils/helpers
 * Use `type` imports for types-only
 * 
 * This file violates by importing internal utils before external libs,
 * and config before TypeChain types.
 */

// Violation: Internal utils imported FIRST (should be LAST, after external libs, TypeChain, config)
import { getDeployments } from '../utils/deploymentHelpers'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'
import type { SupportedChain } from '../common/types'

// Violation: Config imported BEFORE TypeChain types (should be: external libs -> TypeChain -> config -> utils)
import networksConfig from '../../config/networks.json'

// Violation: External libs imported AFTER internal utils and config (should be FIRST)
import { consola } from 'consola'
import { createPublicClient, http, type Address } from 'viem'

// Violation: TypeChain types imported LAST (should be SECOND, right after external libs)
import type { ILiFi } from '../../../typechain'

// Violation: Should use `type` import for types-only (SupportedChain, Address, ILiFi)
export async function badFunction() {
  const deployments = getDeployments('mainnet')
  consola.info('Bad import order example')
}
