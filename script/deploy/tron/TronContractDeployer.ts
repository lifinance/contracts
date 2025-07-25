import { TronWeb } from 'tronweb'

import type {
  ITronDeploymentConfig,
  ITronCostEstimate,
  ITronDeploymentResult,
  IForgeArtifact,
} from './types.js'
import {
  ENERGY_PRICE,
  BANDWIDTH_PRICE,
  DEFAULT_SAFETY_MARGIN,
  calculateTransactionBandwidth,
} from './utils.js'

export class TronContractDeployer {
  private tronWeb: any
  private config: ITronDeploymentConfig

  public constructor(config: ITronDeploymentConfig) {
    this.config = {
      safetyMargin: DEFAULT_SAFETY_MARGIN,
      maxRetries: 3,
      confirmationTimeout: 60000,
      verbose: false,
      dryRun: false,
      userFeePercentage: 100,
      originEnergyLimit: 0,
      ...config,
    }

    this.tronWeb = new TronWeb({
      fullHost: this.config.fullHost,
      privateKey: this.config.privateKey,
    })

    if (this.config.verbose)
      console.log('🔧 TronWeb initialized:', {
        network: this.config.fullHost,
        address: this.tronWeb.defaultAddress.base58,
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
      // 1. Estimate deployment costs
      const costEstimate = await this.estimateDeploymentCost(
        artifact,
        constructorParams
      )

      if (this.config.verbose) console.log('💰 Cost Estimate:', costEstimate)

      // 2. Check account balance
      await this.validateAccountBalance(costEstimate.totalTrx)

      // 3. Deploy contract (or simulate if dry run)
      if (this.config.dryRun)
        return this.simulateDeployment(artifact, costEstimate)

      const deploymentResult = await this.executeDeployment(
        artifact,
        constructorParams,
        costEstimate
      )

      // 4. Wait for confirmation
      const receipt = await this.waitForTransactionReceipt(
        deploymentResult.transactionId
      )

      // 5. Calculate actual costs
      const actualCost = this.calculateActualCost(receipt)

      const result: ITronDeploymentResult = {
        ...deploymentResult,
        receipt,
        actualCost,
      }

      if (this.config.verbose)
        console.log('✅ Deployment completed:', {
          contractAddress: result.contractAddress,
          transactionId: result.transactionId,
          estimatedCost: costEstimate.totalTrx,
          actualCost: actualCost.trxCost,
        })

      return result
    } catch (error: any) {
      console.error('❌ Deployment failed:', error)
      throw error
    }
  }

  /**
   * Estimate deployment costs
   */
  public async estimateDeploymentCost(
    artifact: IForgeArtifact,
    constructorParams: any[] = []
  ): Promise<ITronCostEstimate> {
    try {
      const energyEstimate = await this.estimateEnergyConsumption(
        artifact,
        constructorParams
      )
      const bandwidth = await this.estimateBandwidthConsumption(
        artifact,
        constructorParams
      )
      const energyFactor = this.getEnergyFactor(artifact.bytecode.object)

      const safetyMargin = this.config.safetyMargin ?? DEFAULT_SAFETY_MARGIN
      const adjustedEnergy = Math.ceil(
        energyEstimate * (1 + energyFactor) * safetyMargin
      )

      const energyCost = adjustedEnergy * ENERGY_PRICE
      const bandwidthCost = bandwidth * BANDWIDTH_PRICE
      const totalTrx = energyCost + bandwidthCost

      return {
        energy: adjustedEnergy,
        bandwidth,
        totalTrx,
        feeLimit: this.tronWeb.toSun(totalTrx.toString()),
        breakdown: {
          energyCost,
          bandwidthCost,
          energyFactor,
          safetyMargin,
        },
      }
    } catch (error: any) {
      if (this.config.verbose)
        console.warn(
          '⚠️  Primary estimation failed, using fallback:',
          error.message
        )

      return this.fallbackCostEstimation(artifact, constructorParams)
    }
  }

  /**
   * Primary energy estimation
   */
  private async estimateEnergyConsumption(
    artifact: IForgeArtifact,
    constructorParams: any[]
  ): Promise<number> {
    try {
      const estimateParams = {
        data: artifact.bytecode.object,
        feeLimit: this.tronWeb.toSun('1000'),
        callValue: 0,
        shouldPollResponse: false,
      }

      const result = await this.tronWeb.transactionBuilder.estimateEnergy(
        null,
        null,
        estimateParams,
        constructorParams,
        this.tronWeb.defaultAddress.hex
      )

      return result.energy_required || result.energy_used || 50000
    } catch (error: any) {
      throw new Error(`Energy estimation failed: ${error.message}`)
    }
  }

  /**
   * Estimate bandwidth consumption
   */
  private async estimateBandwidthConsumption(
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
            originEnergyLimit: this.config.originEnergyLimit,
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
   * Get energy factor based on bytecode complexity
   */
  private getEnergyFactor(bytecode: string): number {
    const complexity = bytecode.length / 2

    if (complexity > 50000) return 0.5
    if (complexity > 20000) return 0.3
    return 0.1
  }

  /**
   * Fallback cost estimation
   */
  private fallbackCostEstimation(
    artifact: IForgeArtifact,
    _constructorParams: any[]
  ): ITronCostEstimate {
    const bytecodeSize = artifact.bytecode.object.length / 2

    const baseEnergy = Math.max(50000, bytecodeSize * 2)
    const safetyMargin = this.config.safetyMargin ?? DEFAULT_SAFETY_MARGIN
    const estimatedEnergy = Math.ceil(baseEnergy * safetyMargin)
    const estimatedBandwidth = Math.ceil((bytecodeSize + 300) * 1.2)

    const energyCost = estimatedEnergy * ENERGY_PRICE
    const bandwidthCost = estimatedBandwidth * BANDWIDTH_PRICE

    if (this.config.verbose)
      console.log('📊 Using fallback estimation based on bytecode size')

    return {
      energy: estimatedEnergy,
      bandwidth: estimatedBandwidth,
      totalTrx: energyCost + bandwidthCost,
      feeLimit: this.tronWeb.toSun((energyCost + bandwidthCost).toString()),
      breakdown: {
        energyCost,
        bandwidthCost,
        energyFactor: 0.2,
        safetyMargin,
      },
    }
  }

  /**
   * Validate account has sufficient balance
   */
  private async validateAccountBalance(requiredTrx: number): Promise<void> {
    try {
      const balance = await this.tronWeb.trx.getBalance(
        this.tronWeb.defaultAddress.hex
      )
      const balanceTrx = this.tronWeb.fromSun(balance)

      if (balanceTrx < requiredTrx)
        throw new Error(
          `Insufficient balance: ${balanceTrx} TRX available, ${requiredTrx} TRX required`
        )

      if (this.config.verbose)
        console.log(
          `💳 Account balance: ${balanceTrx} TRX (${requiredTrx} TRX required)`
        )
    } catch (error: any) {
      throw new Error(`Balance validation failed: ${error.message}`)
    }
  }

  /**
   * Execute the actual deployment
   */
  private async executeDeployment(
    artifact: IForgeArtifact,
    constructorParams: any[],
    costEstimate: ITronCostEstimate
  ): Promise<Omit<ITronDeploymentResult, 'receipt' | 'actualCost'>> {
    try {
      if (this.config.verbose) console.log('🚀 Deploying contract...')

      const deployTx =
        await this.tronWeb.transactionBuilder.createSmartContract(
          {
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            parameters: constructorParams,
            feeLimit: this.config.feeLimit || costEstimate.feeLimit,
            userFeePercentage: this.config.userFeePercentage,
            originEnergyLimit: this.config.originEnergyLimit,
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

      return {
        contractAddress,
        transactionId:
          broadcastResult.txid || broadcastResult.transaction?.txID,
        deploymentTransaction: signedTx,
        costEstimate,
      }
    } catch (error: any) {
      throw new Error(`Deployment execution failed: ${error.message}`)
    }
  }

  /**
   * Simulate deployment for dry run
   */
  private simulateDeployment(
    _artifact: IForgeArtifact,
    costEstimate: ITronCostEstimate
  ): ITronDeploymentResult {
    const mockAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    const mockTxId = '0x' + '0'.repeat(64)

    console.log('🧪 DRY RUN - Deployment simulation completed')
    console.log('📋 Simulated Results:', {
      contractAddress: mockAddress,
      estimatedCost: costEstimate.totalTrx,
      energyRequired: costEstimate.energy,
      bandwidthRequired: costEstimate.bandwidth,
    })

    return {
      contractAddress: mockAddress,
      transactionId: mockTxId,
      deploymentTransaction: {},
      receipt: {} as any,
      costEstimate,
      actualCost: {
        energyUsed: costEstimate.energy,
        bandwidthUsed: costEstimate.bandwidth,
        trxCost: costEstimate.totalTrx,
      },
    }
  }

  /**
   * Wait for transaction confirmation
   */
  public async waitForTransactionReceipt(
    transactionId: string,
    timeoutMs: number = this.config.confirmationTimeout ?? 60000
  ): Promise<any> {
    const startTime = Date.now()
    const pollInterval = 3000
    let retries = 0

    if (this.config.verbose)
      console.log(`⏳ Waiting for transaction confirmation: ${transactionId}`)

    while (Date.now() - startTime < timeoutMs) {
      try {
        const receipt = await this.tronWeb.trx.getTransactionInfo(transactionId)

        if (receipt && receipt.id) {
          if (receipt.result === 'FAILED')
            throw new Error(
              `Transaction failed: ${receipt.resMessage || 'Unknown error'}`
            )

          if (this.config.verbose)
            console.log('✅ Transaction confirmed:', {
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
          console.log(
            `⚠️  Retry ${retries}/${maxRetries} for transaction receipt`
          )
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
    const energyFee = receipt.receipt?.energy_fee || 0
    const netFee = receipt.receipt?.net_fee || 0

    const trxCost = this.tronWeb.fromSun(energyFee + netFee)

    return {
      energyUsed,
      bandwidthUsed,
      trxCost,
    }
  }

  /**
   * Utility sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get network information
   */
  public async getNetworkInfo(): Promise<{
    network: string
    block: number
    address: string
    balance: number
  }> {
    const block = await this.tronWeb.trx.getCurrentBlock()
    const balance = await this.tronWeb.trx.getBalance(
      this.tronWeb.defaultAddress.hex
    )

    return {
      network: this.config.fullHost,
      block: block.block_header.raw_data.number,
      address: this.tronWeb.defaultAddress.base58,
      balance: this.tronWeb.fromSun(balance),
    }
  }
}
