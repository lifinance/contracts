/**
 * A generated module for LifiContracts functions
 *
 * This module provides deployment functions for LiFi smart contracts
 * using Foundry in containerized environments.
 */
import { dag, Container, Directory, object, func } from '@dagger.io/dagger'

@object()
export class LifiContracts {
  /**
   * Deploy a smart contract using Foundry forge script
   *
   * @param source - Source directory containing the contract code (should include .env file)
   * @param scriptPath - Path to the deployment script (e.g., "script/deploy/facets/DeployExecutor.s.sol")
   * @param network - Target network name (e.g., "mainnet", "polygon", "arbitrum")
   * @param deploySalt - Salt for CREATE3 deployment
   * @param create3FactoryAddress - Address of the CREATE3 factory contract
   * @param fileSuffix - File suffix for deployment logs (e.g., "staging", "production")
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
   * @param gasEstimateMultiplier - Gas estimate multiplier percentage (default: "130")
   * @param diamondType - Type of diamond contract ("LiFiDiamond" or "LiFiDiamondImmutable")
   * @param broadcast - Whether to broadcast the transaction (default: true)
   * @param legacy - Whether to use legacy transaction type (default: true)
   * @param slow - Whether to use slow mode for better reliability (default: true)
   * @param skipSimulation - Whether to skip simulation (default: false)
   * @param verbosity - Verbosity level (default: "vvvvv")
   */
  @func()
  deployContract(
    source: Directory,
    scriptPath: string,
    network: string,
    deploySalt: string,
    create3FactoryAddress: string,
    fileSuffix: string,
    solcVersion?: string,
    evmVersion?: string,
    gasEstimateMultiplier?: string,
    diamondType?: string,
    broadcast?: boolean,
    legacy?: boolean,
    slow?: boolean,
    skipSimulation?: boolean,
    verbosity?: string
  ): Container {
    // Set default values
    const gasMultiplier = gasEstimateMultiplier || '130'
    const shouldBroadcast = broadcast !== false
    const useLegacy = legacy !== false
    const useSlow = slow !== false
    const shouldSkipSimulation = skipSimulation === true
    const logLevel = verbosity || 'vvvvv'
    const solc = solcVersion || '0.8.29'
    const evm = evmVersion || 'cancun'

    // Build forge script command
    const forgeArgs = [
      'forge',
      'script',
      scriptPath,
      '-f',
      network,
      '--use',
      solc,
      '--evm-version',
      evm,
      `-${logLevel}`,
      '--json',
    ]

    // Add conditional flags
    if (shouldBroadcast) forgeArgs.push('--broadcast')
    if (useLegacy) forgeArgs.push('--legacy')
    if (useSlow) forgeArgs.push('--slow')
    if (shouldSkipSimulation) forgeArgs.push('--skip-simulation')

    // Add gas estimate multiplier
    forgeArgs.push('--gas-estimate-multiplier', gasMultiplier)

    // Start with foundry container
    let container = dag
      .container()
      .from('ghcr.io/foundry-rs/foundry:latest')
      .withMountedDirectory('/workspace', source)
      .withWorkdir('/workspace')
      // Set required environment variables
      .withEnvVariable('DEPLOYSALT', deploySalt)
      .withEnvVariable('CREATE3_FACTORY_ADDRESS', create3FactoryAddress)
      .withEnvVariable('NETWORK', network)
      .withEnvVariable('FILE_SUFFIX', fileSuffix)

    // Set optional environment variables if provided
    if (diamondType) {
      container = container.withEnvVariable('DIAMOND_TYPE', diamondType)
    }

    // Build command that sources .env file and runs forge
    const forgeCommand = [
      'sh',
      '-c',
      `test -f .env && source .env; ${forgeArgs.join(' ')}`,
    ]

    // Execute the forge script command with .env sourcing
    return container.withExec(forgeCommand)
  }
}
