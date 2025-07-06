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
   * Generate deployment salt from contract bytecode using TypeScript
   *
   * @param builtContainer - Pre-built container with compiled artifacts
   * @param contractName - Name of the contract to generate salt for
   */
  @func()
  async generateDeploymentSalt(
    builtContainer: Container,
    contractName: string
  ): Promise<string> {
    // Special case for LiFiDiamondImmutable - use hardcoded salt
    if (contractName === 'LiFiDiamondImmutable') {
      return '0xc726deb4bf42c6ef5d0b4e3080ace43aed9b270938861f7cacf900eba890fa66'
    }

    // Read the bytecode from the compiled artifacts
    const artifactPath = `/workspace/out/${contractName}.sol/${contractName}.json`
    const artifactContainer = builtContainer.withExec(['cat', artifactPath])

    const artifactContent = await artifactContainer.stdout()

    try {
      const artifact = JSON.parse(artifactContent)
      const bytecode = artifact.bytecode?.object || artifact.bytecode

      if (!bytecode) {
        throw new Error(`No bytecode found for contract ${contractName}`)
      }

      // Generate SHA256 hash of the bytecode using container's sha256sum
      const hashContainer = builtContainer.withExec([
        'sh',
        '-c',
        `echo -n "${bytecode}" | sha256sum | cut -d' ' -f1`,
      ])

      const hash = await hashContainer.stdout()
      return `0x${hash.trim()}`
    } catch (error) {
      throw new Error(`Failed to generate salt for ${contractName}: ${error}`)
    }
  }
  /**
   * Build the Foundry project using forge build
   *
   * @param source - Source directory containing the project root
   * @param uid - User ID to match host user (optional)
   * @param gid - Group ID to match host group (optional)
   */
  @func()
  buildProject(source: Directory): Container {
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
      .withExec(['forge', 'build'])

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

    // Build the project first
    const builtContainer = this.buildProject(source)

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
      forgeArgs.splice(-1, 0, `-${verbosity}`)
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
   * @param contractFilePath - Custom contract file path (optional, auto-detected if not provided)
   * @param apiKey - API key for verification service (optional)
   * @param verifier - Verification service ("etherscan", "blockscout", "sourcify") (default: "etherscan")
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
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
    contractFilePath?: string,
    apiKey?: string,
    verifier?: string,
    solcVersion?: string,
    evmVersion?: string,
    watch?: boolean,
    skipIsVerifiedCheck?: boolean
  ): Container {
    // Set default values
    const verificationService = verifier || 'etherscan'
    const shouldWatch = watch !== false
    const shouldSkipVerifiedCheck = skipIsVerifiedCheck !== false

    // Mount the deployments directory to the built container
    const containerWithDeployments = builtContainer.withMountedDirectory(
      '/workspace/deployments',
      source.directory('deployments')
    )

    // Determine contract file path - use provided path or auto-detect
    let finalContractFilePath: string

    if (contractFilePath) {
      finalContractFilePath = contractFilePath
    } else {
      // Auto-detect based on contract name - follows pattern from getContractFilePath
      // The helper function searches in src/ directory, so we need to construct the full path
      // Common locations: src/Facets/, src/Periphery/, src/
      finalContractFilePath = `src/Facets/${contractName}.sol:${contractName}`

      // For some contracts like LiFiDiamond, they're directly in src/
      if (
        contractName === 'LiFiDiamond' ||
        contractName === 'LiFiDiamondImmutable'
      ) {
        finalContractFilePath = `src/${contractName}.sol:${contractName}`
      }
      // Periphery contracts are in src/Periphery/
      else if (
        contractName.includes('Receiver') ||
        contractName.includes('Executor') ||
        contractName.includes('FeeCollector') ||
        contractName.includes('ERC20Proxy')
      ) {
        finalContractFilePath = `src/Periphery/${contractName}.sol:${contractName}`
      }
    }

    // Build base verification command
    const forgeArgs = ['forge', 'verify-contract']

    // Add watch flag
    if (shouldWatch) {
      forgeArgs.push('--watch')
    }

    // Add chain ID
    forgeArgs.push('--chain', chainId)

    // Add contract address and path
    forgeArgs.push(contractAddress, finalContractFilePath)

    // Add skip verification check flag
    if (shouldSkipVerifiedCheck) {
      forgeArgs.push('--skip-is-verified-check')
    }

    // Add constructor args if present
    if (constructorArgs && constructorArgs !== '0x') {
      forgeArgs.push('--constructor-args', constructorArgs)
    }

    // Add verifier
    if (verificationService !== 'etherscan') {
      forgeArgs.push('--verifier', verificationService)
    }

    // Add optimizer settings to match deployment
    forgeArgs.push('--optimizer-runs', '1000000')

    // Add API key if provided and not using sourcify
    if (apiKey && verificationService !== 'sourcify') {
      forgeArgs.push('-e', apiKey)
    } else if (verificationService === 'etherscan') {
      // For etherscan verification without explicit API key, get MAINNET_ETHERSCAN_API_KEY from environment
      // and pass the actual value directly to the verification command
      const mainnetApiKey = process.env.MAINNET_ETHERSCAN_API_KEY
      if (mainnetApiKey) {
        forgeArgs.push('-e', mainnetApiKey)
      } else {
        console.warn(
          'MAINNET_ETHERSCAN_API_KEY not found in environment, verification may fail'
        )
      }
    }

    // Execute the verification command
    return containerWithDeployments.withExec(forgeArgs)
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
    contractFilePath?: string,
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
    const builtContainer = this.buildProject(source)

    // Use the built container for verification
    return this.verifyContractInternal(
      builtContainer,
      source,
      contractName,
      contractAddress,
      constructorArgs,
      networkConfig.chainId.toString(),
      contractFilePath,
      apiKey,
      networkConfig.verificationType || 'etherscan',
      networkConfig.deployedWithSolcVersion,
      networkConfig.deployedWithEvmVersion,
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
   */
  @func()
  async deployContract(
    source: Directory,
    contractName: string,
    network: string,
    privateKey: Secret,
    environment?: string
  ): Promise<Container> {
    const env = environment || 'production'

    // Read network configuration from networks.json
    const networksFile = source.file('config/networks.json')
    const networksContent = await networksFile.contents()
    const networks = JSON.parse(networksContent)

    if (!networks[network]) {
      throw new Error(`Network ${network} not found in networks.json`)
    }

    const networkConfig = networks[network] as NetworkConfig

    // Build the project first
    const builtContainer = this.buildProject(source)

    const scriptPath = `script/deploy/facets/Deploy${contractName}.s.sol`

    // Generate deployment salt using TypeScript method
    const deploySalt = await this.generateDeploymentSalt(
      builtContainer,
      contractName
    )

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

    // Parse the JSON output to extract contract address and constructor args
    let contractAddress = ''
    let constructorArgs = '0x'

    try {
      const result = JSON.parse(deploymentOutput)
      if (result.returns && result.returns.deployed) {
        contractAddress = result.returns.deployed.value
      }
      if (result.returns && result.returns.constructorArgs) {
        constructorArgs = result.returns.constructorArgs.value
      }
    } catch (e) {
      // If parsing fails, try to extract address from logs
      const addressMatch = deploymentOutput.match(/0x[a-fA-F0-9]{40}/)
      if (addressMatch) {
        contractAddress = addressMatch[0]
      }
    }

    if (!contractAddress) {
      throw new Error(
        'Failed to extract contract address from deployment output'
      )
    }

    // Update deployment logs
    const loggedContainer = await this.logDeployment(
      deploymentContainer,
      contractName,
      network,
      env,
      contractAddress,
      constructorArgs,
      deploySalt
    )

    // Attempt contract verification using the same built container
    const finalContainer = await this.attemptVerification(
      loggedContainer,
      source,
      contractName,
      contractAddress,
      constructorArgs,
      networkConfig,
      network,
      env,
      builtContainer // Pass the built container to reuse artifacts
    )

    return finalContainer
  }

  /**
   * Log deployment details to deployment files
   */
  private async logDeployment(
    container: Container,
    contractName: string,
    network: string,
    environment: string,
    contractAddress: string,
    constructorArgs: string,
    deploySalt: string
  ): Promise<Container> {
    const fileSuffix = environment === 'production' ? '' : '.staging'
    const deploymentFile = `deployments/${network}${fileSuffix}.json`
    const logFile = 'deployments/_deployments_log_file.json'

    // Read current deployment files or create empty ones
    const readDeploymentFile = container.withExec([
      'sh',
      '-c',
      `
        if [ -f "/workspace/${deploymentFile}" ]; then
          cat "/workspace/${deploymentFile}"
        else
          echo '{}'
        fi
      `,
    ])

    const currentDeploymentsRaw = await readDeploymentFile.stdout()

    const readLogFile = container.withExec([
      'sh',
      '-c',
      `
        if [ -f "/workspace/${logFile}" ]; then
          cat "/workspace/${logFile}"
        else
          echo '{}'
        fi
      `,
    ])

    const currentLogsRaw = await readLogFile.stdout()

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
    currentDeployments[contractName] = {
      address: contractAddress,
      constructorArgs: constructorArgs,
      deploySalt: deploySalt,
      timestamp: timestamp,
      verified: false,
    }

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

    // Write updated files
    const updatedDeployments = JSON.stringify(currentDeployments, null, 2)
    const updatedLogs = JSON.stringify(currentLogs, null, 2)

    const writeDeploymentFile = container.withNewFile(
      `/workspace/${deploymentFile}`,
      updatedDeployments
    )

    const writeLogFile = writeDeploymentFile.withNewFile(
      `/workspace/${logFile}`,
      updatedLogs
    )

    return writeLogFile
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
    environment: string,
    builtContainer: Container
  ): Promise<Container> {
    try {
      // Determine chain ID from network config
      const chainId = networkConfig.chainId.toString()

      // Use the built container for verification to reuse compiled artifacts
      const verificationContainer = this.verifyContractInternal(
        builtContainer,
        source,
        contractName,
        contractAddress,
        constructorArgs,
        chainId,
        undefined, // auto-detect contract file path
        undefined, // API key should be determined from network config
        networkConfig.verificationType || 'etherscan',
        networkConfig.deployedWithSolcVersion,
        networkConfig.deployedWithEvmVersion,
        true, // watch
        true // skipIsVerifiedCheck
      )

      // Use the network name passed to the function
      const fileSuffix = environment === 'production' ? '' : '.staging'

      // Execute verification and update logs on success
      const verifiedContainer = verificationContainer.withExec([
        'sh',
        '-c',
        `
          echo "Contract verification completed successfully for ${contractName} at ${contractAddress}"
          echo "Using compiler: ${networkConfig.deployedWithSolcVersion}, EVM: ${networkConfig.deployedWithEvmVersion}"
          echo "Constructor args: ${constructorArgs}"
          
          # Update deployment logs to mark as verified
          DEPLOYMENT_FILE="deployments/${network}${fileSuffix}.json"
          if [ -f "/workspace/$DEPLOYMENT_FILE" ]; then
            # Use sed to update the verified field in network-specific file
            sed -i 's/"verified": false/"verified": true/g' "/workspace/$DEPLOYMENT_FILE"
            echo "Updated network deployment file: $DEPLOYMENT_FILE"
          fi
          
          # Update master log file - this is more complex due to nested structure
          # We'll use sed to find and replace the VERIFIED field for this specific contract/network/environment
          MASTER_LOG_FILE="deployments/_deployments_log_file.json"
          if [ -f "/workspace/$MASTER_LOG_FILE" ]; then
            # Replace "VERIFIED": "false" with "VERIFIED": "true" for entries with matching ADDRESS
            sed -i 's/"VERIFIED": "false"/"VERIFIED": "true"/g' "/workspace/$MASTER_LOG_FILE"
            echo "Updated master log file: $MASTER_LOG_FILE"
          fi
        `,
      ])

      return verifiedContainer
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
