/**
 * High-level Tron contract deployment abstraction.
 * Wraps TronWeb to handle energy/bandwidth estimation, cost validation against account balance,
 * rate-limit retry logic, and receipt confirmation. Supports dry-run mode for cost previews.
 */

import { consola } from 'consola'

import { sleep } from '../../utils/delay'
import { fetchWithTimeout } from '../../utils/fetchWithTimeout'
import { retryWithRateLimit } from '../shared/rateLimit'

import {
  DEFAULT_SAFETY_MARGIN,
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
} from './constants'
import {
  calculateEstimatedCost,
  calculateTransactionBandwidth,
  getAccountAvailableResources,
} from './helpers/tronPricing'
import { buildTronWalletJsonPostHeaders } from './helpers/tronRpcConfig'
import {
  createTronWeb,
  resolveTronWebRpcUrlToFullHost,
} from './helpers/tronWebFactory'
import type {
  ITronDeploymentConfig,
  ITronCostEstimate,
  ITronDeploymentResult,
  IForgeArtifact,
} from './types'

export class TronContractDeployer {
  private tronWeb: any
  private config: ITronDeploymentConfig

  public constructor(config: ITronDeploymentConfig) {
    const pk = (config.privateKey ?? '').trim().replace(/^0x/, '')
    if (!pk || !/^[0-9A-Fa-f]{64}$/.test(pk))
      throw new Error(
        'Invalid Tron private key format. Expected a 64-character hexadecimal string (with or without "0x" prefix). ' +
          'Example: 0x1234...abcd or 1234...abcd'
      )

    const resolvedFullHost = resolveTronWebRpcUrlToFullHost(
      config.fullHost ?? '',
      config.tvmNetworkKey
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
      fullHost: resolvedFullHost,
      privateKey: pk,
    }

    this.tronWeb = createTronWeb({
      rpcUrl: resolvedFullHost,
      privateKey: this.config.privateKey,
      headers: this.config.headers,
      verbose: this.config.verbose,
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
   * Deploy a contract to Tron.
   * Estimates energy + bandwidth, validates account balance (accounting for delegated resources),
   * then broadcasts the deployment transaction with rate-limit retry.
   *
   * @param artifact - Forge build artifact (ABI + bytecode) for the contract to deploy.
   * @param constructorParams - ABI-encoded constructor arguments (default: none).
   * @returns Deployment result including contract address, transaction ID, and actual costs.
   * @throws If estimation, balance validation, broadcast, or confirmation fails.
   */
  public async deployContract(
    artifact: IForgeArtifact,
    constructorParams: any[] = []
  ): Promise<ITronDeploymentResult> {
    try {
      // Delay before first RPC to avoid 429 rate limits when called in sequence
      await sleep(2000)

      // Estimate deployment cost
      const costEstimate = await this.estimateCost(artifact, constructorParams)

      // Log cost breakdown so user can verify estimate (helps debug 429/balance issues)
      consola.info('Cost estimate:', {
        energy: costEstimate.energy,
        bandwidth: costEstimate.bandwidth,
        energyCostTrx: costEstimate.breakdown.energyCost.toFixed(4),
        bandwidthCostTrx: costEstimate.breakdown.bandwidthCost.toFixed(4),
        totalTrx: costEstimate.totalTrx.toFixed(4),
        safetyMargin: costEstimate.breakdown.safetyMargin,
      })

      await sleep(2000)

      // Reduce required TRX by the portion covered by delegated energy/bandwidth
      const address = this.tronWeb.defaultAddress.base58
      const { availableEnergy, availableBandwidth } =
        await getAccountAvailableResources(this.config.fullHost, address)
      const energyPrice =
        costEstimate.energy > 0
          ? costEstimate.breakdown.energyCost / costEstimate.energy
          : 0
      const bandwidthPrice =
        costEstimate.bandwidth > 0
          ? costEstimate.breakdown.bandwidthCost / costEstimate.bandwidth
          : 0
      const energyCovered = Math.min(costEstimate.energy, availableEnergy)
      const bandwidthCovered = Math.min(
        costEstimate.bandwidth,
        availableBandwidth
      )
      const trxCoveredByDelegation =
        energyCovered * energyPrice + bandwidthCovered * bandwidthPrice
      const requiredTrx = Math.max(
        0,
        costEstimate.totalTrx - trxCoveredByDelegation
      )
      if (trxCoveredByDelegation > 0) {
        consola.info(
          `Delegated resources: ${availableEnergy} energy, ${availableBandwidth} bandwidth → ` +
            `~${trxCoveredByDelegation.toFixed(
              2
            )} TRX covered. Required TRX: ${requiredTrx.toFixed(4)}`
        )
      }

      // Validate account balance (only the TRX not covered by delegation)
      await this.validateAccountBalance(requiredTrx)

      if (this.config.dryRun)
        return this.simulateDeployment(artifact, costEstimate)

      // Sleep before broadcast to avoid 429 after estimate + getAccountResources burst
      await sleep(8000)

      // Execute deployment with dynamic energy limit (retry on 429)
      const deploymentResult = await retryWithRateLimit(
        () => this.executeDeployment(artifact, constructorParams, costEstimate),
        3,
        10000,
        (attempt, delay) =>
          consola.warn(
            `Rate limit (429) or connection issue, retry ${attempt}/3 in ${
              delay / 1000
            }s...`
          )
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
   * Estimates total deployment cost (energy + bandwidth) in TRX, including a safety margin.
   * Fetches current network prices, then calculates fee limit in SUN (rounded up to integer).
   *
   * @param artifact - Forge artifact for the contract being deployed.
   * @param constructorParams - Constructor arguments (used to size the encoded payload).
   * @returns Cost breakdown with energy/bandwidth counts and TRX totals.
   * @throws If energy estimation or price fetching fails.
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
      await sleep(2000)

      const estimatedBandwidth = await this.estimateBandwidth(
        artifact,
        constructorParams
      )
      await sleep(2000)

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
   * Estimates the bandwidth (bytes) consumed by the deployment transaction.
   * Falls back to a size-based heuristic (`bytecodeSize + 200` × 1.2) if the
   * `createSmartContract` dry-run call fails.
   *
   * @param artifact - Forge artifact containing the bytecode to deploy.
   * @param constructorParams - Constructor arguments appended to the payload.
   * @returns Estimated bandwidth in bytes.
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
        fee_limit: TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
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

      let response: Response
      try {
        response = await fetchWithTimeout(
          apiUrl,
          {
            method: 'POST',
            headers: buildTronWalletJsonPostHeaders(
              this.config.fullHost,
              this.config.verbose ?? false
            ),
            body: JSON.stringify(payload),
          },
          TRON_WALLET_API_FETCH_TIMEOUT_MS
        )
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError')
          throw new Error(
            `triggerconstantcontract timed out after ${TRON_WALLET_API_FETCH_TIMEOUT_MS}ms`
          )
        throw e
      }

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
   * Checks that the deployer account holds at least `requiredTrx` TRX (after subtracting
   * any coverage from delegated energy/bandwidth). Throws if insufficient.
   *
   * @param requiredTrx - TRX amount that must be paid from account balance (not covered by delegation).
   * @throws If balance is below the required amount or the balance call fails.
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
   * Builds, signs, and broadcasts the deployment transaction.
   * Uses `costEstimate.energy` as `originEnergyLimit` and `costEstimate.feeLimit` as the fee cap.
   * Called inside a `retryWithRateLimit` wrapper in `deployContract`.
   *
   * @param artifact - Forge artifact to deploy.
   * @param constructorParams - ABI-encoded constructor arguments.
   * @param costEstimate - Pre-computed energy/bandwidth estimate (used for feeLimit and originEnergyLimit).
   * @returns Partial deployment result (without receipt or actual cost).
   * @throws If broadcast fails or the transaction ID is missing from the response.
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
   * Polls `getTransactionInfo` until a receipt with a non-empty `id` is returned.
   *
   * @param transactionId - Tron transaction ID from the broadcast response.
   * @param timeoutMs - Maximum wait time in ms (default: 60 000 ms / 1 minute).
   * @returns Raw Tron transaction info/receipt object.
   * @throws If the transaction result is `'FAILED'`, confirmation times out, or max retries are exceeded.
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

      await sleep(pollInterval)
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

  // sleep is now imported from utils/delay.ts

  /**
   * Returns basic network and account info useful for debugging (block height, address, balance).
   *
   * @returns Object with `network` (RPC URL), current `block` number, deployer `address`, and `balance` in TRX.
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
