import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import { calculateEstimatedCost } from './price-utils'
import type {
  ITronDeploymentConfig,
  ITronCostEstimate,
  ITronDeploymentResult,
  IForgeArtifact,
} from './types'
import { DEFAULT_SAFETY_MARGIN, calculateTransactionBandwidth } from './utils'

// Import TronWeb - the simple approach that was working

export class TronContractDeployer {
  private tronWeb: any
  private config: ITronDeploymentConfig

  public constructor(config: ITronDeploymentConfig) {
    // Validate Tron private key format (allow optional "0x" prefix)
    const rawKey = config.privateKey?.replace(/^0x/i, '')
    if (!rawKey || !/^[0-9A-Fa-f]{64}$/.test(rawKey))
      throw new Error(
        'Invalid Tron private key format. Expected a 64-character hexadecimal string (with or without "0x" prefix). ' +
          'Example: 0x1234...abcd or 1234...abcd'
      )

    this.config = {
      safetyMargin: DEFAULT_SAFETY_MARGIN,
      maxRetries: 3,
      confirmationTimeout: 60000,
      verbose: false,
      dryRun: false,
      userFeePercentage: 100,
      originEnergyLimit: 0,
      ...config,
      privateKey: rawKey,
    }

    this.tronWeb = new TronWeb({
      fullHost: this.config.fullHost,
      privateKey: this.config.privateKey,
    })

    if (this.config.verbose)
      consola.debug('TronWeb initialized:', {
        network: this.config.fullHost,
        address: [
          this.tronWeb.defaultAddress.base58.slice(0, 6),
          '…',
          this.tronWeb.defaultAddress.base58.slice(-4),
        ].join(''),
      })
  }

  /**
   * Deploy a contract
   */
  public async deployContract(
    artifact: IForgeArtifact,
    constructorParams: any[] = []
  ): Promise<ITronDeploymentResult> {
    try {
      // Estimate deployment cost
      const costEstimate = await this.estimateCost(artifact, constructorParams)

      if (this.config.verbose)
        consola.debug('Estimated deployment cost:', {
          energy: costEstimate.energy,
          bandwidth: costEstimate.bandwidth,
          totalTrx: costEstimate.totalTrx.toFixed(4),
        })

      // Validate account balance
      await this.validateAccountBalance(costEstimate.totalTrx)

      if (this.config.dryRun)
        return this.simulateDeployment(artifact, costEstimate)

      // Execute deployment with dynamic energy limit
      const deploymentResult = await this.executeDeployment(
        artifact,
        constructorParams,
        costEstimate
      )

      // Wait for confirmation
      const receipt = await this.waitForTransactionReceipt(
        deploymentResult.transactionId,
        this.config.confirmationTimeout
      )

      // Calculate actual costs
      const actualCost = this.calculateActualCost(receipt)

      return {
        ...deploymentResult,
        receipt,
        actualCost,
      }
    } catch (error: any) {
      throw new Error(`Contract deployment failed: ${error.message}`)
    }
  }

  /**
   * Estimate deployment cost
   */
  private async estimateCost(
    artifact: IForgeArtifact,
    constructorParams: any[]
  ): Promise<ITronCostEstimate> {
    try {
      // Get energy estimation using triggerConstantContract
      const estimatedEnergy = await this.estimateDeploymentEnergy(
        artifact,
        constructorParams
      )

      const estimatedBandwidth = await this.estimateBandwidth(
        artifact,
        constructorParams
      )

      // Get current prices from the network
      const { energyCost, bandwidthCost, totalCost } =
        await calculateEstimatedCost(
          this.tronWeb,
          estimatedEnergy,
          estimatedBandwidth
        )

      // Ensure fee limit is an integer (Tron requires integer SUN values)
      // Use Math.ceil to round up to avoid underestimating
      const feeLimitSun = Math.ceil(
        Number(this.tronWeb.toSun(totalCost.toString()))
      )

      if (this.config.verbose)
        consola.debug('Fee calculation:', {
          estimatedEnergy,
          estimatedBandwidth,
          energyCost: `${energyCost} TRX`,
          bandwidthCost: `${bandwidthCost} TRX`,
          totalCost: `${totalCost} TRX`,
          feeLimitSun: `${feeLimitSun} SUN (integer)`,
        })

      return {
        energy: estimatedEnergy,
        bandwidth: estimatedBandwidth,
        totalTrx: totalCost,
        feeLimit: feeLimitSun,
        breakdown: {
          energyCost,
          bandwidthCost,
          energyFactor: 1, // We're using actual estimates, not factored
          safetyMargin: this.config.safetyMargin || DEFAULT_SAFETY_MARGIN,
        },
      }
    } catch (error: any) {
      throw new Error(`Cost estimation failed: ${error.message}`)
    }
  }

  /**
   * Estimate bandwidth
   */
  private async estimateBandwidth(
    artifact: IForgeArtifact,
    constructorParams: any[]
  ): Promise<number> {
    try {
      const deployTx =
        await this.tronWeb.transactionBuilder.createSmartContract(
          {
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            parameters: constructorParams,
            feeLimit: this.tronWeb.toSun('1000'),
            userFeePercentage: this.config.userFeePercentage,
            originEnergyLimit: 1000000,
          },
          this.tronWeb.defaultAddress.hex
        )

      return calculateTransactionBandwidth(deployTx)
    } catch (error) {
      const bytecodeSize = artifact.bytecode.object.length / 2
      const estimatedTxSize = bytecodeSize + 200
      return Math.ceil(estimatedTxSize * 1.2)
    }
  }

  /**
   * Estimate deployment energy using triggerConstantContract
   */
  private async estimateDeploymentEnergy(
    artifact: IForgeArtifact,
    constructorParams: any[]
  ): Promise<number> {
    try {
      if (this.config.verbose)
        consola.debug('Estimating energy using triggerConstantContract...')

      // Encode constructor parameters if any
      let encodedParams = ''
      if (constructorParams.length > 0) {
        const constructorAbi = artifact.abi.find(
          (item) => item.type === 'constructor'
        )
        if (constructorAbi && constructorAbi.inputs)
          encodedParams = this.tronWeb.utils.abi.encodeParams(
            constructorAbi.inputs,
            constructorParams
          )
      }

      // Combine bytecode with encoded constructor params
      const deploymentData =
        artifact.bytecode.object + encodedParams.replace('0x', '')

      // Use the wallet address (base58 format) as the from address
      const fromAddress = this.tronWeb.defaultAddress.base58

      // Make direct API call to triggerconstantcontract endpoint (following TRON team's example)
      const apiUrl =
        this.config.fullHost.replace(/\/$/, '') +
        '/wallet/triggerconstantcontract'

      // For contract deployment estimation, following the TRON team's example
      const payload = {
        owner_address: fromAddress,
        contract_address: null, // null for deployment estimation
        function_selector: null, // null for deployment estimation
        parameter: '', // Empty for deployment
        fee_limit: 1000000000, // High limit for estimation only
        call_value: 0,
        data: deploymentData, // Contract bytecode + constructor params
        visible: true,
      }

      if (this.config.verbose) {
        consola.debug(
          'Calling triggerconstantcontract API for energy estimation...'
        )
        consola.debug(
          'Bytecode size:',
          artifact.bytecode.object.length / 2,
          'bytes'
        )
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `API call failed: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const result = await response.json()

      if (result.result?.result === false || result.energy_used === 0)
        throw new Error(
          `Contract deployment estimation failed. Please check your parameters. Response: ${JSON.stringify(
            result
          )}`
        )

      if (result.energy_used) {
        if (this.config.verbose)
          consola.debug(`Estimated energy usage: ${result.energy_used}`)

        // Add safety margin to the estimated energy
        const safetyMargin = this.config.safetyMargin || DEFAULT_SAFETY_MARGIN
        const estimatedEnergy = Math.ceil(result.energy_used * safetyMargin)

        if (this.config.verbose)
          consola.debug(
            `Energy with ${safetyMargin}x safety margin: ${estimatedEnergy}`
          )

        return estimatedEnergy
      }

      throw new Error('No energy estimation returned')
    } catch (error: any) {
      consola.error(
        ' Failed to estimate energy via triggerConstantContract:',
        error.message
      )
      throw new Error(
        `Energy estimation failed: ${error.message}. Cannot proceed with deployment.`
      )
    }
  }

  /**
   * Validate account balance
   */
  private async validateAccountBalance(requiredTrx: number): Promise<void> {
    try {
      const balance = await this.tronWeb.trx.getBalance(
        this.tronWeb.defaultAddress.base58
      )
      const balanceTrx = this.tronWeb.fromSun(balance)

      if (balanceTrx < requiredTrx)
        throw new Error(
          `Insufficient balance: ${balanceTrx} TRX available, ${requiredTrx} TRX required`
        )

      if (this.config.verbose)
        consola.debug(`Balance check passed: ${balanceTrx} TRX available`)
    } catch (error: any) {
      throw new Error(`Balance validation failed: ${error.message}`)
    }
  }

  /**
   * Execute deployment
   */
  private async executeDeployment(
    artifact: IForgeArtifact,
    constructorParams: any[],
    costEstimate: ITronCostEstimate
  ): Promise<Omit<ITronDeploymentResult, 'receipt' | 'actualCost'>> {
    try {
      if (this.config.verbose) consola.debug('Deploying contract...')

      // Use the estimated energy as originEnergyLimit
      const deployTx =
        await this.tronWeb.transactionBuilder.createSmartContract(
          {
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            parameters: constructorParams,
            feeLimit: costEstimate.feeLimit, // Always use the estimate
            userFeePercentage: this.config.userFeePercentage,
            originEnergyLimit: costEstimate.energy, // Use dynamic energy estimate
          },
          this.tronWeb.defaultAddress.hex
        )

      const signedTx = await this.tronWeb.trx.sign(deployTx)
      const broadcastResult = await this.tronWeb.trx.sendRawTransaction(
        signedTx
      )

      if (!broadcastResult.result)
        throw new Error(
          `Transaction broadcast failed: ${
            broadcastResult.message || 'Unknown error'
          }`
        )

      const contractAddress = this.tronWeb.address.fromHex(
        deployTx.contract_address || broadcastResult.contract_address
      )

      const transactionId =
        broadcastResult.txid || broadcastResult.transaction?.txID
      if (!transactionId)
        throw new Error('Transaction ID not found in broadcast result')

      return {
        contractAddress,
        transactionId,
        deploymentTransaction: signedTx,
        costEstimate,
      }
    } catch (error: any) {
      throw new Error(`Deployment execution failed: ${error.message}`)
    }
  }

  /**
   * Simulate deployment (dry run)
   */
  private simulateDeployment(
    _artifact: IForgeArtifact,
    costEstimate: ITronCostEstimate
  ): ITronDeploymentResult {
    const mockTxId = `DRY_RUN_${Date.now()}`
    const mockAddress = 'T' + 'X'.repeat(33)

    consola.info(' DRY RUN - Simulated deployment:', {
      contractAddress: mockAddress,
      transactionId: mockTxId,
      estimatedCost: costEstimate.totalTrx.toFixed(4) + ' TRX',
      energy: costEstimate.energy,
      bandwidth: costEstimate.bandwidth,
    })

    return {
      contractAddress: mockAddress,
      transactionId: mockTxId,
      deploymentTransaction: {},
      costEstimate,
      receipt: {
        id: mockTxId,
        blockNumber: 0,
        result: 'SUCCESS',
        receipt: {
          energy_usage_total: costEstimate.energy,
          net_usage: costEstimate.bandwidth,
        },
      },
      actualCost: {
        energyUsed: costEstimate.energy,
        bandwidthUsed: costEstimate.bandwidth,
        trxCost: costEstimate.totalTrx,
      },
    }
  }

  /**
   * Wait for transaction receipt
   */
  private async waitForTransactionReceipt(
    transactionId: string,
    timeoutMs = 60000
  ): Promise<any> {
    const startTime = Date.now()
    const pollInterval = 3000
    let retries = 0

    if (this.config.verbose)
      consola.info(` Waiting for transaction confirmation: ${transactionId}`)

    while (Date.now() - startTime < timeoutMs) {
      try {
        const receipt = await this.tronWeb.trx.getTransactionInfo(transactionId)

        if (receipt && receipt.id) {
          if (receipt.result === 'FAILED')
            throw new Error(
              `Transaction failed: ${receipt.resMessage || 'Unknown error'}`
            )

          if (this.config.verbose)
            consola.debug('Transaction confirmed:', {
              blockNumber: receipt.blockNumber,
              energyUsed: receipt.receipt?.energy_usage_total || 0,
              result: receipt.result,
            })

          return receipt
        }
      } catch (error: any) {
        retries++
        const maxRetries = this.config.maxRetries ?? 3
        if (retries >= maxRetries)
          throw new Error(
            `Failed to get transaction receipt after ${retries} retries: ${error.message}`
          )

        if (this.config.verbose)
          consola.warn(`Retry ${retries}/${maxRetries} for transaction receipt`)
      }

      await this.sleep(pollInterval)
    }

    throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`)
  }

  /**
   * Calculate actual deployment costs from receipt
   */
  private calculateActualCost(receipt: any): {
    energyUsed: number
    bandwidthUsed: number
    trxCost: number
  } {
    const energyUsed = receipt.receipt?.energy_usage_total || 0
    const bandwidthUsed = receipt.receipt?.net_usage || 0
    const energyFee = receipt.fee || 0

    const trxCost = this.tronWeb.fromSun(energyFee)

    return {
      energyUsed,
      bandwidthUsed,
      trxCost,
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get network info
   */
  public async getNetworkInfo(): Promise<{
    network: string
    block: number
    address: string
    balance: number
  }> {
    const block = await this.tronWeb.trx.getCurrentBlock()
    const balance = await this.tronWeb.trx.getBalance(
      this.tronWeb.defaultAddress.base58
    )

    return {
      network: this.config.fullHost,
      block: block.block_header.raw_data.number,
      address: this.tronWeb.defaultAddress.base58,
      balance: this.tronWeb.fromSun(balance),
    }
  }
}
