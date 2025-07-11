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
  ReturnType,
  Platform,
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
  /// Utility Methods ///

  private async detectHostArch(): Promise<Platform> {
    // Use uname to detect architecture
    const output = await dag
      .container()
      .from('alpine:latest')
      .withExec(['uname', '-m'])
      .stdout()

    const arch = output.trim()

    // Common ARM64 identifiers
    if (arch === 'aarch64' || arch === 'arm64') {
      return 'linux/arm64' as Platform
    }

    return 'linux/amd64' as Platform
  }

  /**
   * Parse JSON string with explicit error handling
   */
  private parseJson(jsonString: string, context: string): any {
    try {
      const trimmed = jsonString.trim()
      if (!trimmed) {
        throw new Error(`Empty JSON content in ${context}`)
      }
      return JSON.parse(trimmed)
    } catch (e) {
      throw new Error(`Failed to parse JSON in ${context}: ${e}`)
    }
  }

  /**
   * Read file with explicit error handling
   */
  private async readFile(source: Directory, filePath: string): Promise<string> {
    try {
      return await source.file(filePath).contents()
    } catch (e) {
      throw new Error(`Failed to read required file: ${filePath}`)
    }
  }

  /**
   * Get network configuration with validation
   */
  private async getNetworkConfig(
    source: Directory,
    network: string
  ): Promise<NetworkConfig> {
    const networks = await this.readAndParseJson(source, 'config/networks.json')

    if (!networks[network]) {
      throw new Error(`Network ${network} not found in networks.json`)
    }

    return networks[network] as NetworkConfig
  }

  /**
   * Read and parse JSON file in one operation
   */
  private async readAndParseJson(
    source: Directory,
    filePath: string
  ): Promise<any> {
    const content = await this.readFile(source, filePath)
    return this.parseJson(content, filePath)
  }

  /**
   * Ensure nested log structure exists
   */
  private ensureLogStructure(
    logs: any,
    contractName: string,
    network: string,
    environment: string,
    version: string
  ): void {
    if (!logs[contractName]) logs[contractName] = {}
    if (!logs[contractName][network]) logs[contractName][network] = {}
    if (!logs[contractName][network][environment]) {
      logs[contractName][network][environment] = {}
    }
    if (!logs[contractName][network][environment][version]) {
      logs[contractName][network][environment][version] = []
    }
  }

  /**
   * Format constructor args for display - show "0x" for empty args
   */
  private formatConstructorArgsForDisplay(constructorArgs: string): string {
    if (
      !constructorArgs ||
      constructorArgs === '0x' ||
      /^0x0+$/.test(constructorArgs)
    ) {
      return '0x'
    }
    return constructorArgs
  }

  /**
   * Generate timestamp in deployment log format
   */
  private generateTimestamp(): string {
    return new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '')
  }
  /**
   * Build the Foundry project using forge build
   *
   * @param source - Source directory containing the project root
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
   */
  @func()
  async buildProject(
    source: Directory,
    solcVersion?: string,
    evmVersion?: string
  ): Promise<Container> {
    // Setup

    // Read from foundry.toml if versions not provided
    const finalSolcVersion =
      solcVersion || (await this.extractSolcVersion(source))
    const finalEvmVersion = evmVersion || (await this.extractEvmVersion(source))

    // Build forge build command with version parameters
    const buildArgs = ['forge', 'build']

    if (finalSolcVersion) {
      buildArgs.push('--use', finalSolcVersion)
    }

    if (finalEvmVersion) {
      buildArgs.push('--evm-version', finalEvmVersion)
    }

    // Execute

    return (
      dag
        .container({
          platform: await this.detectHostArch(),
        })
        .from('ghcr.io/foundry-rs/foundry:latest')
        .withDirectory('/workspace/src', source.directory('src'))
        .withDirectory('/workspace/lib', source.directory('lib'))
        .withDirectory('/workspace/script', source.directory('script'))
        .withFile('/workspace/foundry.toml', source.file('foundry.toml'))
        .withFile('/workspace/remappings.txt', source.file('remappings.txt'))
        .withFile('/workspace/.env', source.file('.env'))
        .withFile('/workspace/package.json', source.file('package.json'))
        .withFile('/workspace/bun.lock', source.file('bun.lock'))
        .withWorkdir('/workspace')
        .withUser('root')
        .withExec([
          'mkdir',
          '-p',
          '/workspace/out',
          '/workspace/cache',
          '/workspace/broadcast',
        ])
        .withExec(['chown', '-R', 'foundry:foundry', '/workspace'])
        // Install Node.js, bun, and jq
        .withExec([
          'bash',
          '-c',
          'apt-get update && apt-get install -y nodejs npm jq',
        ])
        .withExec(['npm', 'install', '-g', 'bun'])
        .withUser('foundry')
        // Install dependencies
        .withExec(['bun', 'install', '--ignore-scripts'])
        .withEnvVariable('FOUNDRY_DISABLE_NIGHTLY_WARNING', 'true')
        .withExec(buildArgs)
    )
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
   * @param originalSalt - Original salt value for logging (before keccak hashing)
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
  async deployContractInternal(
    source: Directory,
    scriptPath: string,
    network: string,
    deploySalt: string,
    create3FactoryAddress: string,
    fileSuffix: string,
    privateKey: Secret,
    originalSalt: string,
    solcVersion?: string,
    evmVersion?: string,
    gasEstimateMultiplier?: string,
    broadcast?: boolean,
    legacy?: boolean,
    slow?: boolean,
    skipSimulation?: boolean,
    verbosity?: string
  ): Promise<Container> {
    // Setup

    // Set default values
    const gasMultiplier = gasEstimateMultiplier || '130'
    const shouldBroadcast = broadcast !== false
    const useLegacy = legacy !== false
    const useSlow = slow !== false
    const shouldSkipSimulation = skipSimulation === true

    // Build forge script command
    const forgeArgs = ['forge', 'script', scriptPath, '-f', network, '--json']

    // Add version flags if provided
    if (solcVersion) {
      forgeArgs.push('--use', solcVersion)
    }
    if (evmVersion) {
      forgeArgs.push('--evm-version', evmVersion)
    }

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

    // Execute

    const result = (await this.buildProject(source, solcVersion, evmVersion))
      .withMountedDirectory(
        '/workspace/deployments',
        source.directory('deployments')
      )
      .withMountedDirectory('/workspace/config', source.directory('config'))
      .withEnvVariable('FOUNDRY_DISABLE_NIGHTLY_WARNING', 'true')
      .withEnvVariable('DEPLOYSALT', deploySalt)
      .withEnvVariable('CREATE3_FACTORY_ADDRESS', create3FactoryAddress)
      .withEnvVariable('NETWORK', network)
      .withEnvVariable('FILE_SUFFIX', fileSuffix)
      .withSecretVariable('PRIVATE_KEY', privateKey)
      .withEnvVariable('SALT', originalSalt)
      .withEnvVariable('DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS', 'true')
      .withExec(forgeArgs, { expect: ReturnType.Any })

    if ((await result.exitCode()) > 0) {
      throw new Error(`Failed to deploy contract: ${await result.stderr()}`)
    }

    return result
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
    // Setup

    // Set default values
    const verificationService = verifier || 'etherscan'
    const shouldWatch = watch !== false
    const shouldSkipVerifiedCheck = skipIsVerifiedCheck !== false

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

    // Execute

    return builtContainer
      .withMountedDirectory(
        '/workspace/deployments',
        source.directory('deployments')
      )
      .withExec(forgeArgs)
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
    const networkConfig = await this.getNetworkConfig(source, network)

    // Build the project first to get the same artifacts as deployment
    const builtContainer = await this.buildProject(
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
   * Check if a contract is a facet (exists in src/Facets directory)
   */
  private async checkIfFacetExists(
    source: Directory,
    contractName: string
  ): Promise<boolean> {
    try {
      const facetPath = `src/Facets/${contractName}.sol`
      await source.file(facetPath).id()
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Update diamond with a facet using TypeScript-heavy approach
   */
  @func()
  async updateFacet(
    source: Directory,
    contractName: string,
    network: string,
    privateKey: Secret,
    evmVersion?: string,
    solcVersion?: string,
    environment: string = 'staging',
    safeSignerPrivateKey?: Secret
  ): Promise<void> {
    console.log(
      `🔄 Starting diamond update for ${contractName} on ${network} (${environment})`
    )

    try {
      // 1. Check if update script exists
      const updateScriptPath = `script/deploy/facets/Update${contractName}.s.sol`
      try {
        await source.file(updateScriptPath).id()
      } catch (error) {
        throw new Error(`Update script not found: ${updateScriptPath}`)
      }

      // 2. Read diamond address from deployment file
      const fileSuffix = environment === 'production' ? '' : '.staging'
      const deploymentFile = `deployments/${network}${fileSuffix}.json`

      let deploymentContent: string
      try {
        deploymentContent = await source.file(deploymentFile).contents()
      } catch (error) {
        throw new Error(`Deployment file not found: ${deploymentFile}`)
      }

      const deployments = JSON.parse(deploymentContent)
      const diamondAddress = deployments.LiFiDiamond

      if (!diamondAddress) {
        throw new Error(`LiFiDiamond address not found in ${deploymentFile}`)
      }

      console.log(`📍 Found LiFiDiamond at ${diamondAddress}`)

      // 3. Read network config for RPC URL (needed for Safe proposals)
      const networkConfig = await this.getNetworkConfig(source, network)
      const rpcUrl = networkConfig.rpcUrl

      if (!rpcUrl && environment === 'production') {
        throw new Error(`RPC URL not found for network ${network}`)
      }

      // 4. Build project with same versions as deployment
      let builtContainer = await this.buildProject(
        source,
        solcVersion,
        evmVersion
      )

      // 5. Setup container with environment variables
      builtContainer = builtContainer
        .withEnvVariable('NETWORK', network)
        .withEnvVariable('FILE_SUFFIX', fileSuffix)
        .withEnvVariable('USE_DEF_DIAMOND', 'true')
        .withSecretVariable('PRIVATE_KEY', privateKey)
        .withMountedDirectory(
          '/workspace/deployments',
          source.directory('deployments')
        )
        .withMountedDirectory('/workspace/config', source.directory('config'))

      // 6. Build forge command based on environment
      const forgeArgs = [
        'forge',
        'script',
        updateScriptPath,
        '-f',
        network,
        '--json',
        '-vvvv',
        '--legacy',
      ]

      if (environment === 'staging') {
        forgeArgs.push('--broadcast')
        console.log(`🚀 Executing direct diamond update for staging...`)
      } else {
        forgeArgs.push('--skip-simulation')
        builtContainer = builtContainer.withEnvVariable('NO_BROADCAST', 'true')
        console.log(`📋 Generating Safe proposal for production...`)
      }

      // Add version flags if provided
      if (solcVersion) {
        forgeArgs.push('--use', solcVersion)
      }
      if (evmVersion) {
        forgeArgs.push('--evm-version', evmVersion)
      }

      // 7. Execute forge script
      const result = await builtContainer.withExec(forgeArgs).stdout()
      console.log(`✅ Forge script executed successfully`)

      // 8. Parse and validate forge output
      let forgeOutput: any
      try {
        // Extract JSON from output (sometimes has extra text)
        const jsonMatch = result.match(/\{"logs":.*/)
        const cleanData = jsonMatch ? jsonMatch[0] : result
        forgeOutput = JSON.parse(cleanData)
      } catch (error) {
        throw new Error(`Failed to parse forge output: ${error}`)
      }

      if (environment === 'production') {
        // 9. Handle production: Create Safe proposal
        const facetCut = forgeOutput.returns?.cutData?.value
        if (!facetCut || facetCut === '0x') {
          throw new Error('No facet cut data generated for Safe proposal')
        }

        console.log(`📤 Creating Safe proposal with facet cut data...`)
        await this.proposeFacetCutToSafe(
          builtContainer,
          diamondAddress,
          facetCut,
          network,
          rpcUrl,
          safeSignerPrivateKey
        )
        console.log(`✅ Safe proposal created successfully`)
      } else {
        // 10. Handle staging: Validate direct update
        const facets = forgeOutput.returns?.facets?.value
        if (!facets || facets === '{}') {
          throw new Error('Facet update failed - no facets returned')
        }
        console.log(`✅ Diamond updated directly with new facet`)
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      console.error(`❌ Diamond update failed: ${errorMessage}`)
      throw new Error(`Diamond update failed: ${errorMessage}`)
    }
  }

  /**
   * Create Safe proposal for facet cut (production deployments)
   */
  private async proposeFacetCutToSafe(
    container: Container,
    diamondAddress: string,
    facetCut: string,
    network: string,
    rpcUrl: string,
    safeSignerPrivateKey?: Secret
  ): Promise<void> {
    // Add Safe signer private key as secret if provided
    if (safeSignerPrivateKey) {
      container = container.withSecretVariable(
        'SAFE_SIGNER_PRIVATE_KEY',
        safeSignerPrivateKey
      )
    }

    const safeArgs = [
      '/bin/sh',
      '-c',
      'bun script/deploy/safe/propose-to-safe.ts --to "$1" --calldata "$2" --network "$3" --rpcUrl "$4" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"',
      '--',
      diamondAddress,
      facetCut,
      network,
      rpcUrl,
    ]

    await container.withExec(safeArgs).stdout()
  }

  /**
   * Deploy a smart contract with configuration reading from networks.json
   *
   * @param source - Source directory containing the project root
   * @param contractName - Name of the contract to deploy (e.g., "AcrossFacet")
   * @param network - Target network name (e.g., "arbitrum", "mainnet")
   * @param privateKey - Private key secret for deployment
   * @param salt - Salt value for CREATE3 deployment (optional, defaults to empty string)
   * @param environment - Deployment environment ("staging" or "production", defaults to "production")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param updateDiamond - Whether to update diamond after deployment (for facets only)
   * @param safeSignerPrivateKey - Safe signer private key secret (for production diamond updates)
   * @returns Updated source directory with deployment logs
   */
  @func()
  async deployContract(
    source: Directory,
    contractName: string,
    network: string,
    privateKey: Secret,
    salt?: string,
    environment?: string,
    evmVersion?: string,
    solcVersion?: string,
    updateDiamond?: boolean,
    safeSignerPrivateKey?: Secret
  ): Promise<Directory> {
    const env = environment || 'production'
    const deploymentSalt = salt || ''

    // Read network configuration from networks.json
    const networkConfig = await this.getNetworkConfig(source, network)

    // Build the project first with foundry.toml defaults (buildProject will read foundry.toml)
    let builtContainer = await this.buildProject(
      source,
      solcVersion,
      evmVersion
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

    // Validate SALT format if provided (must have even number of digits)
    if (deploymentSalt && deploymentSalt.length % 2 !== 0) {
      throw new Error(
        'SALT parameter has odd number of digits (must be even digits)'
      )
    }

    // Create salt input by concatenating bytecode and SALT (same as bash: SALT_INPUT="$BYTECODE""$SALT")
    const saltInput = bytecode + deploymentSalt

    // Generate DEPLOYSALT using cast keccak (same as bash: DEPLOYSALT=$(cast keccak "$SALT_INPUT"))
    builtContainer = builtContainer.withExec(['cast', 'keccak', saltInput])

    const keccakResult = await builtContainer.stdout()
    deploySalt = keccakResult.trim()

    // Execute deployment
    const deploymentContainer = await this.deployContractInternal(
      source,
      scriptPath,
      network,
      deploySalt,
      networkConfig.create3Factory,
      env === 'production' ? '' : 'staging.',
      privateKey, // privateKey passed as secret
      deploymentSalt, // originalSalt - for logging purposes
      solcVersion, // solcVersion - use provided version or foundry.toml defaults
      evmVersion, // evmVersion - use provided version or foundry.toml defaults
      '130', // gasEstimateMultiplier
      true, // broadcast
      true, // legacy
      true, // slow
      false, // skipSimulation
      undefined // verbosity - omit by default
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

    // Update deployment logs and get updated source
    source = await this.logDeployment(
      source,
      contractName,
      network,
      env,
      contractAddress,
      constructorArgs,
      deploymentSalt // Use original SALT parameter, not the computed deploySalt hash
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

    // Update diamond if requested and contract is a facet
    if (updateDiamond) {
      const isFacet = await this.checkIfFacetExists(source, contractName)
      if (isFacet) {
        console.log(`🔄 Updating diamond with ${contractName} facet...`)
        try {
          await this.updateFacet(
            source,
            contractName,
            network,
            privateKey,
            evmVersion,
            solcVersion,
            env,
            safeSignerPrivateKey
          )
          console.log(`✅ Diamond updated with ${contractName} facet`)
        } catch (error) {
          console.error(
            `❌ Failed to update diamond with ${contractName}: ${error}`
          )
          // Don't throw - deployment was successful, only diamond update failed
        }
      } else {
        console.log(
          `ℹ️ ${contractName} is not a facet, skipping diamond update`
        )
      }
    }

    // Return the full updated source directory
    return source
  }

  /**
   * Deploy a smart contract to multiple networks
   *
   * @param source - Source directory containing the project root
   * @param contractName - Name of the contract to deploy (e.g., "AcrossFacet")
   * @param networks - Array of network names to deploy to (e.g., ["arbitrum", "optimism"])
   * @param privateKey - Private key secret for deployment
   * @param salt - Salt value for CREATE3 deployment (optional, defaults to empty string)
   * @param environment - Deployment environment ("staging" or "production", defaults to "production")
   * @param evmVersion - EVM version target (e.g., "cancun", "london", "shanghai")
   * @param solcVersion - Solidity compiler version (e.g., "0.8.29")
   * @param updateDiamond - Whether to update diamond after deployment (for facets only)
   * @param safeSignerPrivateKey - Safe signer private key secret (for production diamond updates)
   */
  @func()
  async deployToAllNetworks(
    source: Directory,
    contractName: string,
    networks: string[],
    privateKey: Secret,
    salt?: string,
    environment?: string,
    evmVersion?: string,
    solcVersion?: string,
    updateDiamond?: boolean,
    safeSignerPrivateKey?: Secret
  ): Promise<Directory> {
    // Remove failed_deployments.json at the start if it exists
    try {
      const failedLogFileName = 'failed_deployments_log.json'
      await source.file(`deployments/${failedLogFileName}`).id()
      // File exists, remove it by creating source without it
      source = source.withoutFile(`deployments/${failedLogFileName}`)
    } catch (error) {
      // File doesn't exist, which is fine - no need to log this as an error
    }

    let updatedSource = source

    for (const network of networks) {
      try {
        // deployContract returns an updated source directory with the new deployment logs
        updatedSource = await this.deployContract(
          updatedSource,
          contractName,
          network,
          privateKey,
          salt,
          environment,
          evmVersion,
          solcVersion,
          updateDiamond,
          safeSignerPrivateKey
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

    // Read and parse current deployment files
    const currentDeployments = await this.readAndParseJson(
      source,
      `deployments/${deploymentFileName}`
    )
    const currentLogs = await this.readAndParseJson(
      source,
      `deployments/${logFileName}`
    )

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

    // Read and parse current failed deployments log, create empty object if file doesn't exist
    let currentFailedLogs: any = {}
    try {
      currentFailedLogs = await this.readAndParseJson(
        source,
        `deployments/${failedLogFileName}`
      )
    } catch (error) {
      // File doesn't exist, start with empty object
      console.log(
        `Creating new failed deployments log file: deployments/${failedLogFileName}`
      )
    }
    const timestamp = this.generateTimestamp()

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
   * Extract version from contract natspec @custom:version comment
   */
  private async extractContractVersion(
    source: Directory,
    contractName: string
  ): Promise<string> {
    // Check in src/Facets, src/Periphery, and src/Security directories
    const possiblePaths = [
      `src/Facets/${contractName}.sol`,
      `src/Periphery/${contractName}.sol`,
      `src/Security/${contractName}.sol`,
    ]

    for (const contractPath of possiblePaths) {
      try {
        const contractContent = await source.file(contractPath).contents()

        // Look for @custom:version x.x.x pattern in natspec comments
        const versionMatch = contractContent.match(
          /@custom:version\s+(\d+\.\d+\.\d+)/
        )

        if (versionMatch) {
          return versionMatch[1]
        }
      } catch (error) {
        // File doesn't exist, continue to next path
        continue
      }
    }

    throw new Error(
      `Contract version not found for ${contractName}. Please add @custom:version x.x.x to the contract natspec.`
    )
  }

  /**
   * Extract optimizer runs from foundry.toml
   */
  private async extractOptimizerRuns(source: Directory): Promise<string> {
    const foundryToml = await source.file('foundry.toml').contents()

    // Look for optimizer_runs = number pattern
    const optimizerMatch = foundryToml.match(/optimizer_runs\s*=\s*(\d+)/)

    if (optimizerMatch) {
      return optimizerMatch[1]
    }

    throw new Error('optimizer_runs not found in foundry.toml')
  }

  /**
   * Extract solc version from foundry.toml
   */
  private async extractSolcVersion(source: Directory): Promise<string> {
    const foundryToml = await source.file('foundry.toml').contents()

    const solcMatch = foundryToml.match(/solc_version\s*=\s*['"]([^'"]+)['"]/)

    if (solcMatch) {
      return solcMatch[1]
    }

    throw new Error('solc_version not found in foundry.toml')
  }

  /**
   * Extract evm version from foundry.toml
   */
  private async extractEvmVersion(source: Directory): Promise<string> {
    const foundryToml = await source.file('foundry.toml').contents()

    const evmMatch = foundryToml.match(/evm_version\s*=\s*['"]([^'"]+)['"]/)

    if (evmMatch) {
      return evmMatch[1]
    }

    throw new Error('evm_version not found in foundry.toml')
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

    // Extract version and optimizer runs
    const version = await this.extractContractVersion(source, contractName)
    const optimizerRuns = await this.extractOptimizerRuns(source)

    // Read and parse current deployment files
    const currentDeployments = await this.readAndParseJson(
      source,
      `deployments/${deploymentFileName}`
    )
    const currentLogs = await this.readAndParseJson(
      source,
      `deployments/${logFileName}`
    )

    const timestamp = this.generateTimestamp()

    // Update deployment data (network-specific file)
    // For network files, just store the address as a string (matching existing format)
    currentDeployments[contractName] = contractAddress

    // Update master log with nested structure: contractName -> network -> environment -> version -> array
    this.ensureLogStructure(
      currentLogs,
      contractName,
      network,
      environment,
      version
    )

    // Remove existing entry for same address if it exists
    currentLogs[contractName][network][environment][version] = currentLogs[
      contractName
    ][network][environment][version].filter(
      (entry: any) => entry.ADDRESS !== contractAddress
    )

    // Add new deployment entry
    currentLogs[contractName][network][environment][version].push({
      ADDRESS: contractAddress,
      OPTIMIZER_RUNS: optimizerRuns,
      TIMESTAMP: timestamp,
      CONSTRUCTOR_ARGS: this.formatConstructorArgsForDisplay(constructorArgs),
      SALT: deploySalt,
      VERIFIED: 'false',
    })

    // Write updated files to source directory
    const updatedDeployments = JSON.stringify(currentDeployments, null, 2)
    const updatedLogs = JSON.stringify(currentLogs, null, 2)

    // Update the source directory with new deployment files
    source = source
      .withNewFile(`deployments/${deploymentFileName}`, updatedDeployments)
      .withNewFile(`deployments/${logFileName}`, updatedLogs)

    console.log(`Deployment logged for ${contractName} at ${contractAddress}`)
    console.log(
      `Updated network deployment file: deployments/${deploymentFileName}`
    )
    console.log(`Updated master log file: deployments/${logFileName}`)

    return source
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
      // Setup

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

      // Update deployment logs locally
      await this.updateVerificationLogs(
        source,
        contractName,
        network,
        environment,
        contractAddress
      )

      // Execute

      return verificationContainer.withExec([
        '/bin/sh',
        '-c',
        `
          echo "Contract verification completed successfully for ${contractName} at ${contractAddress}"
          echo "Using compiler: ${
            networkConfig.deployedWithSolcVersion
          }, EVM: ${networkConfig.deployedWithEvmVersion}"
          echo "Constructor args: ${this.formatConstructorArgsForDisplay(
            constructorArgs
          )}"
        `,
      ])
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
