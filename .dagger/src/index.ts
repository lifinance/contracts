/**
 * A generated module for LifiContracts functions
 *
 * This module provides deployment functions for LiFi smart contracts
 * using Foundry in containerized environments.
 */
import {
  dag,
  Container,
  Directory,
  Secret,
  object,
  func,
} from '@dagger.io/dagger'

interface NetworkConfig {
  chainId: number
  rpcUrl: string
  deployedWithEvmVersion: string
  deployedWithSolcVersion: string
  verificationType: string
  explorerApiUrl: string
  create3Factory: string
}

@object()
export class LifiContracts {
  /**
   * Build the Foundry project using forge build
   *
   * @param source - Source directory containing the project root
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
   */
  @func()
  buildProject(
    source: Directory,
    solcVersion?: string,
    evmVersion?: string
  ): Container {
    let container = dag
      .container()
      .from('ghcr.io/foundry-rs/foundry:latest')
      .withDirectory('/workspace/src', source.directory('src'))
      .withDirectory('/workspace/lib', source.directory('lib'))
      .withDirectory('/workspace/script', source.directory('script'))
      .withFile('/workspace/foundry.toml', source.file('foundry.toml'))
      .withFile('/workspace/remappings.txt', source.file('remappings.txt'))
      .withFile('/workspace/.env', source.file('.env'))
      .withWorkdir('/workspace')
      .withUser('root')
      .withExec([
        'mkdir',
        '-p',
        '/workspace/out',
        '/workspace/cache',
        '/workspace/broadcast',
      ])
      .withExec([
        'chown',
        'foundry:foundry',
        '/workspace/out',
        '/workspace/cache',
        '/workspace/broadcast',
      ])
      .withUser('foundry')
      .withEnvVariable('FOUNDRY_DISABLE_NIGHTLY_WARNING', 'true')

    // Build forge build command with version parameters
    const buildArgs = ['forge', 'build']

    if (solcVersion) {
      buildArgs.push('--use', solcVersion)
    }

    if (evmVersion) {
      buildArgs.push('--evm-version', evmVersion)
    }

    container = container.withExec(buildArgs)

    return container
  }

  /**
   * Deploy a smart contract using Foundry forge script (internal function)
   *
   * @param source - Source directory containing the project root
   * @param scriptPath - Path to the deployment script (e.g., "script/deploy/facets/DeployExecutor.s.sol")
   * @param network - Target network name (e.g., "mainnet", "polygon", "arbitrum")
   * @param deploySalt - Salt for CREATE3 deployment
   * @param create3FactoryAddress - Address of the CREATE3 factory contract
   * @param fileSuffix - File suffix for deployment logs (e.g., "staging", "production")
   * @param privateKey - Private key secret for deployment
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
   * @param gasEstimateMultiplier - Gas estimate multiplier percentage (default: "130")
   * @param broadcast - Whether to broadcast the transaction (default: true)
   * @param legacy - Whether to use legacy transaction type (default: true)
   * @param slow - Whether to use slow mode for better reliability (default: true)
   * @param skipSimulation - Whether to skip simulation (default: false)
   * @param verbosity - Verbosity level (default: "vvvvv")
   * @param defaultDiamondAddressDeploysalt - Default diamond address deploy salt (optional)
   * @param deployToDefaultDiamondAddress - Whether to deploy to default diamond address (optional)
   * @param diamondType - Diamond type for CelerIMFacet (optional)
   */
  @func()
  deployContractInternal(
    source: Directory,
    scriptPath: string,
    network: string,
    deploySalt: string,
    create3FactoryAddress: string,
    fileSuffix: string,
    privateKey: Secret,
    solcVersion?: string,
    evmVersion?: string,
    gasEstimateMultiplier?: string,
    broadcast?: boolean,
    legacy?: boolean,
    slow?: boolean,
    skipSimulation?: boolean,
    verbosity?: string,
    defaultDiamondAddressDeploysalt?: string,
    deployToDefaultDiamondAddress?: string,
    diamondType?: string
  ): Container {
    // Set default values
    const gasMultiplier = gasEstimateMultiplier || '130'
    const shouldBroadcast = broadcast !== false
    const useLegacy = legacy !== false
    const useSlow = slow !== false
    const shouldSkipSimulation = skipSimulation === true
    const solc = solcVersion || '0.8.29'
    const evm = evmVersion || 'cancun'

    // Build the project first with the same versions as deployment
    const builtContainer = this.buildProject(source, solc, evm)

    // Mount the deployments directory to the built container
    const containerWithDeployments = builtContainer.withMountedDirectory(
      '/workspace/deployments',
      source.directory('deployments')
    )

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
      '--json',
    ]

    // Add verbosity flag only if specified
    if (verbosity) {
      forgeArgs.push(`-${verbosity}`)
    }

    // Add conditional flags
    if (shouldBroadcast) forgeArgs.push('--broadcast')
    if (useLegacy) forgeArgs.push('--legacy')
    if (useSlow) forgeArgs.push('--slow')
    if (shouldSkipSimulation) forgeArgs.push('--skip-simulation')

    // Add gas estimate multiplier
    forgeArgs.push('--gas-estimate-multiplier', gasMultiplier)

    // Set required environment variables that the deployment scripts expect
    let deployContainer = containerWithDeployments
      .withEnvVariable('FOUNDRY_DISABLE_NIGHTLY_WARNING', 'true')
      .withEnvVariable('DEPLOYSALT', deploySalt)
      .withEnvVariable('CREATE3_FACTORY_ADDRESS', create3FactoryAddress)
      .withEnvVariable('NETWORK', network)
      .withEnvVariable('FILE_SUFFIX', fileSuffix)
      .withSecretVariable('PRIVATE_KEY', privateKey)
      .withEnvVariable(
        'DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS',
        deployToDefaultDiamondAddress || 'true'
      )

    // Add optional environment variables if provided
    if (defaultDiamondAddressDeploysalt) {
      deployContainer = deployContainer.withEnvVariable(
        'DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT',
        defaultDiamondAddressDeploysalt
      )
    }

    if (diamondType) {
      deployContainer = deployContainer.withEnvVariable(
        'DIAMOND_TYPE',
        diamondType
      )
    }

    // Execute the forge script command
    return deployContainer.withExec(forgeArgs)
  }

  /**
   * Verify a smart contract using an existing built container (internal function)
   *
   * This function reuses a pre-built container to avoid rebuilding and ensure
   * the same artifacts are used for both deployment and verification.
   *
   * @param builtContainer - Pre-built container with compiled artifacts
   * @param source - Source directory containing the project root
   * @param contractName - Name of the contract to verify (e.g., "Executor")
   * @param contractAddress - Deployed contract address
   * @param constructorArgs - Constructor arguments in hex format (e.g., "0x123...")
   * @param chainId - Chain ID for verification
   * @param apiKey - API key for verification service (optional)
   * @param verifier - Verification service ("etherscan", "blockscout", "sourcify") (default: "etherscan")
   * @param watch - Whether to watch verification status (default: true)
   * @param skipIsVerifiedCheck - Whether to skip already verified check (default: true)
   */
  @func()
  verifyContractInternal(
    builtContainer: Container,
    source: Directory,
    contractName: string,
    contractAddress: string,
    constructorArgs: string,
    chainId: string,
    apiKey?: string,
    verifier?: string,
    watch?: boolean,
    skipIsVerifiedCheck?: boolean
  ): Container {
    // Set default values
    const verificationService = verifier || 'etherscan'
    const shouldWatch = watch !== false
    const shouldSkipVerifiedCheck = skipIsVerifiedCheck !== false

    // Mount the deployments directory to the built container
    // Note: The built container already has src, lib, script, foundry.toml, etc.
    // We just need to mount the deployments directory for verification
    builtContainer = builtContainer.withMountedDirectory(
      '/workspace/deployments',
      source.directory('deployments')
    )

    // Build base verification command
    const forgeArgs = ['forge', 'verify-contract']

    // Add watch flag
    if (shouldWatch) {
      forgeArgs.push('--watch')
    }

    // Add chain ID
    forgeArgs.push('--chain', chainId)

    // Add contract address and contract name
    forgeArgs.push(contractAddress, contractName)

    // Add skip verification check flag
    if (shouldSkipVerifiedCheck) {
      forgeArgs.push('--skip-is-verified-check')
    }

    // Add constructor args if present
    if (constructorArgs && constructorArgs !== '0x') {
      forgeArgs.push('--constructor-args', constructorArgs.trim())
    }

    // Add verifier
    if (verificationService !== 'etherscan') {
      forgeArgs.push('--verifier', verificationService)
    }

    // Add API key if provided and not using sourcify
    if (apiKey && verificationService !== 'sourcify') {
      forgeArgs.push('-e', apiKey)
    }

    // Execute the verification command
    return builtContainer.withExec(forgeArgs)
  }

  /**
   * Verify a smart contract with configuration reading from networks.json
   *
   * This function builds the project and verifies a deployed contract using the same
   * configuration as deployContract to ensure consistency.
   *
   * @param source - Source directory containing the project root
   * @param contractName - Name of the contract to verify (e.g., "AcrossFacet")
   * @param contractAddress - Deployed contract address
   * @param constructorArgs - Constructor arguments in hex format (e.g., "0x123...")
   * @param network - Target network name (e.g., "arbitrum", "mainnet")
   * @param contractFilePath - Custom contract file path (optional, auto-detected if not provided)
   * @param apiKey - API key for verification service (optional)
   * @param watch - Whether to watch verification status (default: true)
   * @param skipIsVerifiedCheck - Whether to skip already verified check (default: true)
   */
  @func()
  async verifyContract(
    source: Directory,
    contractName: string,
    contractAddress: string,
    constructorArgs: string,
    network: string,
    apiKey?: string,
    watch?: boolean,
    skipIsVerifiedCheck?: boolean
  ): Promise<Container> {
    // Read network configuration from networks.json
    const networksFile = source.file('config/networks.json')
    const networksContent = await networksFile.contents()
    const networks = JSON.parse(networksContent)

    if (!networks[network]) {
      throw new Error(`Network ${network} not found in networks.json`)
    }

    const networkConfig = networks[network] as NetworkConfig

    // Build the project first to get the same artifacts as deployment
    const builtContainer = this.buildProject(
      source,
      networkConfig.deployedWithSolcVersion,
      networkConfig.deployedWithEvmVersion
    )

    // Use the built container for verification
    return this.verifyContractInternal(
      builtContainer,
      source,
      contractName,
      contractAddress,
      constructorArgs,
      networkConfig.chainId.toString(),
      apiKey,
      networkConfig.verificationType || 'etherscan',
      watch,
      skipIsVerifiedCheck
    )
  }

  /**
   * Deploy a smart contract with configuration reading from networks.json
   *
   * @param source - Source directory containing the project root
   * @param contractName - Name of the contract to deploy (e.g., "AcrossFacet")
   * @param network - Target network name (e.g., "arbitrum", "mainnet")
   * @param privateKey - Private key secret for deployment
   * @param environment - Deployment environment ("staging" or "production", defaults to "production")
   * @returns Updated source directory with deployment logs
   */
  @func()
  async deployContract(
    source: Directory,
    contractName: string,
    network: string,
    privateKey: Secret,
    environment?: string
  ): Promise<Directory> {
    const env = environment || 'production'

    // Read network configuration from networks.json
    const networksFile = source.file('config/networks.json')
    const networksContent = await networksFile.contents()
    const networks = JSON.parse(networksContent)

    if (!networks[network]) {
      throw new Error(`Network ${network} not found in networks.json`)
    }

    const networkConfig = networks[network] as NetworkConfig

    // Build the project first with network-specific versions
    let builtContainer = this.buildProject(
      source,
      networkConfig.deployedWithSolcVersion,
      networkConfig.deployedWithEvmVersion
    )

    const scriptPath = `script/deploy/facets/Deploy${contractName}.s.sol`

    // Generate deployment salt exactly like the bash script
    let deploySalt: string
    // Read the bytecode from compiled artifacts
    const artifactPath = `/workspace/out/${contractName}.sol/${contractName}.json`
    const artifactContainer = builtContainer.withExec(['cat', artifactPath])
    const artifactContent = await artifactContainer.stdout()

    const artifact = JSON.parse(artifactContent)
    let bytecode = artifact.bytecode?.object || artifact.bytecode

    if (!bytecode) {
      throw new Error(`No bytecode found for contract ${contractName}`)
    }

    // Get SALT from environment variable (can be empty)
    const salt = process.env.SALT || ''

    // Validate SALT format if provided (must have even number of digits)
    if (salt && salt.length % 2 !== 0) {
      throw new Error(
        'SALT environment variable has odd number of digits (must be even digits)'
      )
    }

    // Create salt input by concatenating bytecode and SALT (same as bash: SALT_INPUT="$BYTECODE""$SALT")
    const saltInput = bytecode + salt

    // Generate DEPLOYSALT using cast keccak (same as bash: DEPLOYSALT=$(cast keccak "$SALT_INPUT"))
    builtContainer = builtContainer.withExec(['cast', 'keccak', saltInput])

    const keccakResult = await builtContainer.stdout()
    deploySalt = keccakResult.trim()

    // Execute deployment
    const deploymentContainer = this.deployContractInternal(
      source,
      scriptPath,
      network,
      deploySalt,
      networkConfig.create3Factory,
      env === 'production' ? '' : 'staging.',
      privateKey, // privateKey passed as secret
      networkConfig.deployedWithSolcVersion,
      networkConfig.deployedWithEvmVersion,
      '130', // gasEstimateMultiplier
      true, // broadcast
      true, // legacy
      true, // slow
      false, // skipSimulation
      undefined, // verbosity - omit by default
      undefined, // defaultDiamondAddressDeploysalt
      'true', // deployToDefaultDiamondAddress
      undefined // diamondType
    )

    // Extract deployment results from the output
    const deploymentOutput = await deploymentContainer.stdout()

    // Parse the deployment output using the same logic as deploySingleContract.sh
    let contractAddress = ''
    let constructorArgs = '0x'

    // Extract the JSON blob that starts with {"logs":
    const jsonMatch = deploymentOutput.match(/\{"logs":.*/)
    let cleanData = ''

    if (jsonMatch) {
      cleanData = jsonMatch[0]

      try {
        const result = JSON.parse(cleanData)

        // Try extracting from `.returns.deployed.value` (primary method)
        if (
          result.returns &&
          result.returns.deployed &&
          result.returns.deployed.value
        ) {
          contractAddress = result.returns.deployed.value
        }

        // Extract constructor args from `.returns.constructorArgs.value`
        if (
          result.returns &&
          result.returns.constructorArgs &&
          result.returns.constructorArgs.value
        ) {
          constructorArgs = result.returns.constructorArgs.value
        }
      } catch (e) {
        // JSON parsing failed, continue to fallback methods
      }
    }

    if (!contractAddress) {
      throw new Error(
        'Failed to extract contract address from deployment output'
      )
    }

    // Use original SALT for logging (can be empty string)
    const logSalt = salt

    // Update deployment logs and get updated source
    source = await this.logDeployment(
      source,
      contractName,
      network,
      env,
      contractAddress,
      constructorArgs,
      logSalt
    )

    // Attempt contract verification using the deployment container
    await this.attemptVerification(
      deploymentContainer,
      source,
      contractName,
      contractAddress,
      constructorArgs,
      networkConfig,
      network,
      env
    )

    // Return the full updated source directory
    return source
  }

  /**
   * Deploy a smart contract to multiple networks
   *
   * @param source - Source directory containing the project root
   * @param contractName - Name of the contract to deploy (e.g., "AcrossFacet")
   * @param privateKey - Private key secret for deployment
   * @param environment - Deployment environment ("staging" or "production", defaults to "production")
   */
  @func()
  async deployToAllNetworks(
    source: Directory,
    contractName: string,
    privateKey: Secret,
    environment?: string
  ): Promise<Directory> {
    const networks = ['optimism', 'arbitrum', 'base', 'boba', 'rootstock']
    let updatedSource = source

    for (const network of networks) {
      try {
        // deployContract returns an updated source directory with the new deployment logs
        updatedSource = await this.deployContract(
          updatedSource,
          contractName,
          network,
          privateKey,
          environment
        )
        console.log(`✅ Successfully deployed ${contractName} to ${network}`)
      } catch (error) {
        // Capture full error details for logging
        let errorMessage = 'Unknown error'
        if (error instanceof Error) {
          errorMessage = `${error.name}: ${error.message}`
          if (error.stack) {
            errorMessage += `\nStack: ${error.stack}`
          }
        } else {
          errorMessage = String(error)
        }

        console.error(
          `❌ Failed to deploy ${contractName} to ${network}: ${errorMessage}`
        )

        // Log the failure to failed_deployments_log.json
        updatedSource = await this.logFailedDeployment(
          updatedSource,
          contractName,
          network,
          environment || 'production',
          errorMessage
        )

        // Continue to next network
      }
    }

    return updatedSource.directory('deployments')
  }

  /**
   * Update deployment logs to mark contract as verified locally
   *
   * @param source - Source directory containing the project root
   * @param contractName - Name of the verified contract
   * @param network - Target network name
   * @param environment - Deployment environment
   * @param contractAddress - Address of the verified contract
   */
  @func()
  async updateVerificationLogs(
    source: Directory,
    contractName: string,
    network: string,
    environment: string,
    contractAddress: string
  ): Promise<Directory> {
    const fileSuffix = environment === 'production' ? '' : '.staging'
    const deploymentFileName = `${network}${fileSuffix}.json`
    const logFileName = '_deployments_log_file.json'

    // Read current deployment files from source directory
    let currentDeploymentsRaw = '{}'
    try {
      const deploymentFile = source
        .directory('deployments')
        .file(deploymentFileName)
      currentDeploymentsRaw = await deploymentFile.contents()
    } catch (e) {
      // File doesn't exist, use empty object
    }

    let currentLogsRaw = '{}'
    try {
      const logFile = source.directory('deployments').file(logFileName)
      currentLogsRaw = await logFile.contents()
    } catch (e) {
      // File doesn't exist, use empty object
    }

    // Parse and update deployment data using TypeScript
    let currentDeployments: any = {}
    try {
      currentDeployments = JSON.parse(currentDeploymentsRaw.trim() || '{}')
    } catch (e) {
      currentDeployments = {}
    }

    let currentLogs: any = {}
    try {
      currentLogs = JSON.parse(currentLogsRaw.trim() || '{}')
    } catch (e) {
      currentLogs = {}
    }

    // Update network-specific deployment file
    if (currentDeployments[contractName]) {
      currentDeployments[contractName].verified = true
    }

    // Update master log file - find entries with matching address and mark as verified
    if (
      currentLogs[contractName] &&
      currentLogs[contractName][network] &&
      currentLogs[contractName][network][environment]
    ) {
      Object.keys(currentLogs[contractName][network][environment]).forEach(
        (version) => {
          const entries =
            currentLogs[contractName][network][environment][version]
          if (Array.isArray(entries)) {
            entries.forEach((entry: any) => {
              if (entry.ADDRESS === contractAddress) {
                entry.VERIFIED = 'true'
              }
            })
          }
        }
      )
    }

    // Write updated files to source directory
    const updatedDeployments = JSON.stringify(currentDeployments, null, 2)
    const updatedLogs = JSON.stringify(currentLogs, null, 2)

    const updatedSource = source
      .withNewFile(`deployments/${deploymentFileName}`, updatedDeployments)
      .withNewFile(`deployments/${logFileName}`, updatedLogs)

    console.log(
      `Contract verification completed successfully for ${contractName} at ${contractAddress}`
    )
    console.log(
      `Updated network deployment file: deployments/${deploymentFileName}`
    )
    console.log(`Updated master log file: deployments/${logFileName}`)

    return updatedSource
  }

  /**
   * Log failed deployment details to failed_deployments_log.json
   */
  private async logFailedDeployment(
    source: Directory,
    contractName: string,
    network: string,
    environment: string,
    errorMessage: string
  ): Promise<Directory> {
    const failedLogFileName = 'failed_deployments_log.json'

    // Read current failed deployments log
    let currentFailedLogsRaw = '{}'
    try {
      const failedLogFile = source
        .directory('deployments')
        .file(failedLogFileName)
      currentFailedLogsRaw = await failedLogFile.contents()
    } catch (e) {
      // File doesn't exist, use empty object
    }

    // Parse and update failed deployment data
    const timestamp = new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '')

    let currentFailedLogs: any = {}
    try {
      currentFailedLogs = JSON.parse(currentFailedLogsRaw.trim() || '{}')
    } catch (e) {
      currentFailedLogs = {}
    }

    // Create nested structure: contractName -> network -> environment -> array
    if (!currentFailedLogs[contractName]) {
      currentFailedLogs[contractName] = {}
    }
    if (!currentFailedLogs[contractName][network]) {
      currentFailedLogs[contractName][network] = {}
    }
    if (!currentFailedLogs[contractName][network][environment]) {
      currentFailedLogs[contractName][network][environment] = []
    }

    // Add new failed deployment entry
    currentFailedLogs[contractName][network][environment].push({
      TIMESTAMP: timestamp,
      ERROR_MESSAGE: errorMessage,
      ENVIRONMENT: environment,
    })

    // Write updated failed deployments log to source directory
    const updatedFailedLogs = JSON.stringify(currentFailedLogs, null, 2)
    const updatedSource = source.withNewFile(
      `deployments/${failedLogFileName}`,
      updatedFailedLogs
    )

    console.log(
      `Failed deployment logged for ${contractName} on ${network}: ${errorMessage}`
    )
    console.log(
      `Updated failed deployments log: deployments/${failedLogFileName}`
    )

    return updatedSource
  }

  /**
   * Log deployment details to deployment files
   */
  private async logDeployment(
    source: Directory,
    contractName: string,
    network: string,
    environment: string,
    contractAddress: string,
    constructorArgs: string,
    deploySalt: string
  ): Promise<Directory> {
    const fileSuffix = environment === 'production' ? '' : '.staging'
    const deploymentFileName = `${network}${fileSuffix}.json`
    const logFileName = '_deployments_log_file.json'

    // Read current deployment files from source directory or create empty ones
    let currentDeploymentsRaw = '{}'
    try {
      const deploymentFile = source
        .directory('deployments')
        .file(deploymentFileName)
      currentDeploymentsRaw = await deploymentFile.contents()
    } catch (e) {
      // File doesn't exist, use empty object
    }

    let currentLogsRaw = '{}'
    try {
      const logFile = source.directory('deployments').file(logFileName)
      currentLogsRaw = await logFile.contents()
    } catch (e) {
      // File doesn't exist, use empty object
    }

    // Parse and update deployment data using TypeScript
    const timestamp = new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '')

    let currentDeployments: any = {}
    try {
      currentDeployments = JSON.parse(currentDeploymentsRaw.trim() || '{}')
    } catch (e) {
      currentDeployments = {}
    }

    let currentLogs: any = {}
    try {
      currentLogs = JSON.parse(currentLogsRaw.trim() || '{}')
    } catch (e) {
      currentLogs = {}
    }

    // Update deployment data (network-specific file)
    // For network files, just store the address as a string (matching existing format)
    currentDeployments[contractName] = contractAddress

    // Update master log with nested structure: contractName -> network -> environment -> version -> array
    if (!currentLogs[contractName]) {
      currentLogs[contractName] = {}
    }
    if (!currentLogs[contractName][network]) {
      currentLogs[contractName][network] = {}
    }
    if (!currentLogs[contractName][network][environment]) {
      currentLogs[contractName][network][environment] = {}
    }

    // Use version 1.0.0 as default (could be extracted from contract source later)
    const version = '1.0.0'
    if (!currentLogs[contractName][network][environment][version]) {
      currentLogs[contractName][network][environment][version] = []
    }

    // Remove existing entry for same address if it exists
    currentLogs[contractName][network][environment][version] = currentLogs[
      contractName
    ][network][environment][version].filter(
      (entry: any) => entry.ADDRESS !== contractAddress
    )

    // Add new deployment entry
    currentLogs[contractName][network][environment][version].push({
      ADDRESS: contractAddress,
      OPTIMIZER_RUNS: '1000000', // Default value, could be extracted from build info
      TIMESTAMP: timestamp,
      CONSTRUCTOR_ARGS: constructorArgs,
      SALT: deploySalt,
      VERIFIED: 'false',
    })

    // Write updated files to source directory
    const updatedDeployments = JSON.stringify(currentDeployments, null, 2)
    const updatedLogs = JSON.stringify(currentLogs, null, 2)

    // Update the source directory with new deployment files
    let updatedSource = source
      .withNewFile(`deployments/${deploymentFileName}`, updatedDeployments)
      .withNewFile(`deployments/${logFileName}`, updatedLogs)

    console.log(`Deployment logged for ${contractName} at ${contractAddress}`)
    console.log(
      `Updated network deployment file: deployments/${deploymentFileName}`
    )
    console.log(`Updated master log file: deployments/${logFileName}`)

    return updatedSource
  }

  /**
   * Attempt contract verification
   */
  private async attemptVerification(
    container: Container,
    source: Directory,
    contractName: string,
    contractAddress: string,
    constructorArgs: string,
    networkConfig: NetworkConfig,
    network: string,
    environment: string
  ): Promise<Container> {
    try {
      // Determine chain ID from network config
      const chainId = networkConfig.chainId.toString()

      // Use the built container for verification to reuse compiled artifacts
      const verificationContainer = this.verifyContractInternal(
        container,
        source,
        contractName,
        contractAddress,
        constructorArgs,
        chainId,
        undefined, // auto-detect contract file path
        networkConfig.verificationType || 'etherscan',
        true, // watch
        true // skipIsVerifiedCheck
      )

      // Log verification details
      const logContainer = verificationContainer.withExec([
        'sh',
        '-c',
        `
          echo "Contract verification completed successfully for ${contractName} at ${contractAddress}"
          echo "Using compiler: ${networkConfig.deployedWithSolcVersion}, EVM: ${networkConfig.deployedWithEvmVersion}"
          echo "Constructor args: ${constructorArgs}"
        `,
      ])

      // Update deployment logs locally
      await this.updateVerificationLogs(
        source,
        contractName,
        network,
        environment,
        contractAddress
      )

      return logContainer
    } catch (error) {
      // If verification fails, continue with unverified deployment
      console.warn(`Contract verification failed: ${error}`)
      return container.withExec([
        'echo',
        `Warning: Contract verification failed for ${contractName} at ${contractAddress}`,
      ])
    }
  }
}
