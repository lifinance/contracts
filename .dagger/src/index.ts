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
import * as fs from 'fs/promises'

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
    const builtContainer = this.buildProject(
      source,
      networkConfig.deployedWithSolcVersion,
      networkConfig.deployedWithEvmVersion
    )

    const scriptPath = `script/deploy/facets/Deploy${contractName}.s.sol`

    // Generate deployment salt
    let deploySalt: string
    // Read the bytecode from compiled artifacts
    const artifactPath = `/workspace/out/${contractName}.sol/${contractName}.json`
    const artifactContainer = builtContainer.withExec(['cat', artifactPath])
    const artifactContent = await artifactContainer.stdout()

    const artifact = JSON.parse(artifactContent)
    const bytecode = artifact.bytecode?.object || artifact.bytecode

    if (!bytecode) {
      throw new Error(`No bytecode found for contract ${contractName}`)
    }

    // Generate SHA256 hash of the bytecode
    const hashContainer = builtContainer.withExec([
      'sh',
      '-c',
      `echo -n "${bytecode}" | sha256sum | cut -d' ' -f1`,
    ])

    const hash = await hashContainer.stdout()
    deploySalt = `0x${hash.trim()}`

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

    // Get salt for logging from environment variable (different from deployment salt)
    const logSalt = process.env.SALT || ''

    // Update deployment logs locally
    await this.logDeployment(
      source,
      contractName,
      network,
      env,
      contractAddress,
      constructorArgs,
      logSalt
    )

    // Attempt contract verification using the deployment container
    const finalContainer = await this.attemptVerification(
      deploymentContainer,
      source,
      contractName,
      contractAddress,
      constructorArgs,
      networkConfig,
      network,
      env
    )

    // Create a new directory with the updated deployment files
    // We need to read the locally modified files and create a new directory
    const deploymentsContainer = dag
      .container()
      .from('alpine:latest')
      .withWorkdir('/deployments')

    // Read all files from the local deployments directory and add them to the container
    const deploymentFiles = await fs.readdir('./deployments')
    let containerWithFiles = deploymentsContainer

    for (const file of deploymentFiles) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(`./deployments/${file}`, 'utf-8')
        containerWithFiles = containerWithFiles.withNewFile(
          `/deployments/${file}`,
          content
        )
      }
    }

    return containerWithFiles.directory('/deployments')
  }

  /**
   * Update deployment logs to mark contract as verified locally
   *
   * @param contractName - Name of the verified contract
   * @param network - Target network name
   * @param environment - Deployment environment
   * @param contractAddress - Address of the verified contract
   */
  @func()
  async updateVerificationLogs(
    contractName: string,
    network: string,
    environment: string,
    contractAddress: string
  ): Promise<void> {
    const fileSuffix = environment === 'production' ? '' : '.staging'
    const deploymentFile = `./deployments/${network}${fileSuffix}.json`
    const logFile = './deployments/_deployments_log_file.json'

    // Read current deployment files
    let currentDeploymentsRaw = '{}'
    try {
      currentDeploymentsRaw = await fs.readFile(deploymentFile, 'utf-8')
    } catch (e) {
      // File doesn't exist, use empty object
    }

    let currentLogsRaw = '{}'
    try {
      currentLogsRaw = await fs.readFile(logFile, 'utf-8')
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

    // Write updated files
    const updatedDeployments = JSON.stringify(currentDeployments, null, 2)
    const updatedLogs = JSON.stringify(currentLogs, null, 2)

    await fs.writeFile(deploymentFile, updatedDeployments)
    await fs.writeFile(logFile, updatedLogs)

    console.log(
      `Contract verification completed successfully for ${contractName} at ${contractAddress}`
    )
    console.log(`Updated network deployment file: ${deploymentFile}`)
    console.log(`Updated master log file: ${logFile}`)
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
  ): Promise<void> {
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

    // Write updated files locally using fs
    const updatedDeployments = JSON.stringify(currentDeployments, null, 2)
    const updatedLogs = JSON.stringify(currentLogs, null, 2)

    // Ensure deployments directory exists
    await fs.mkdir('./deployments', { recursive: true })

    await fs.writeFile(
      `./deployments/${deploymentFileName}`,
      updatedDeployments
    )
    await fs.writeFile(`./deployments/${logFileName}`, updatedLogs)

    console.log(`Deployment logged for ${contractName} at ${contractAddress}`)
    console.log(
      `Updated network deployment file: ./deployments/${deploymentFileName}`
    )
    console.log(`Updated master log file: ./deployments/${logFileName}`)
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
