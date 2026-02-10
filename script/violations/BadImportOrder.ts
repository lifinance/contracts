/**
 * Violation: Imports are in incorrect order.
 * 
 * Convention violation: Imports MUST be ordered as:
 * 1. External libs (viem, consola, citty, dotenv)
 * 2. TypeChain types (typechain/)
 * 3. Config files
 * 4. Internal utils/helpers
 * 
 * This file violates by importing internal utils before external libs.
 */

// Violation: Internal utils imported before external libs
import { getDeployments } from '../utils/deploymentHelpers'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'
import type { SupportedChain } from '../common/types'

// Violation: External libs imported after internal utils
import { consola } from 'consola'
import { createPublicClient, http, type Address } from 'viem'

// Violation: Config imported after external libs (should be before internal utils)
import networksConfig from '../../config/networks.json'

// Violation: TypeChain types imported last (should be second, after external libs)
import type { ILiFi } from '../../../typechain'

export async function badFunction() {
  // Function implementation...
}
