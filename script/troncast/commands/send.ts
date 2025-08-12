import { defineCommand } from 'citty'
import { consola } from 'consola'

import { getPrivateKey } from '../../deploy/tron/utils'
import type { Environment, ITransactionReceipt } from '../types'
import { formatReceipt, formatGasUsage } from '../utils/formatter'
import {
  parseFunctionSignature,
  parseArgument,
  isValidAddress,
} from '../utils/parser'
import { initTronWeb, parseValue, waitForConfirmation } from '../utils/tronweb'

export const sendCommand = defineCommand({
  meta: {
    name: 'send',
    description: 'Send a transaction to a Tron contract',
  },
  args: {
    address: {
      type: 'positional',
      description: 'Contract address',
      required: true,
    },
    signature: {
      type: 'positional',
      description: 'Function signature (e.g., "transfer(address,uint256)")',
      required: true,
    },
    params: {
      type: 'positional',
      description: 'Function parameters',
      required: false,
    },
    env: {
      type: 'string',
      description: 'Environment (mainnet or staging)',
      default: 'mainnet',
    },
    privateKey: {
      type: 'string',
      description: 'Private key for signing',
    },
    value: {
      type: 'string',
      description: 'TRX value to send (e.g., "0.1tron", "100000sun")',
    },
    feeLimit: {
      type: 'string',
      description: 'Maximum fee in TRX',
      default: '1000',
    },
    energyLimit: {
      type: 'string',
      description: 'Energy limit',
    },
    confirm: {
      type: 'boolean',
      description: 'Wait for confirmation',
      default: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Simulate without sending',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    try {
      // Validate inputs
      if (!isValidAddress(args.address))
        throw new Error(`Invalid contract address: ${args.address}`)

      const env = args.env as Environment
      if (env !== 'mainnet' && env !== 'staging')
        throw new Error('Environment must be "mainnet" or "staging"')

      // Get private key
      const privateKey = args.privateKey || (await getPrivateKey())
      if (!privateKey)
        throw new Error('Private key is required for sending transactions')

      // Initialize TronWeb with private key
      const tronWeb = initTronWeb(env, privateKey)

      // Parse function signature
      const funcSig = parseFunctionSignature(args.signature)
      consola.info(`Preparing to call ${funcSig.name} on ${args.address}`)

      // Parse parameters
      const params = args.params
        ? args.params.split(',').map((p) => p.trim())
        : []
      if (params.length !== funcSig.inputs.length)
        throw new Error(
          `Expected ${funcSig.inputs.length} parameters, got ${params.length}`
        )

      const parsedParams = params.map((param, i) =>
        parseArgument(funcSig.inputs[i]?.type || 'string', param)
      )

      // Build transaction options
      const feeLimitInSun = tronWeb.toSun(parseFloat(args.feeLimit as string))
      const options: Record<string, unknown> = {
        feeLimit:
          typeof feeLimitInSun === 'string'
            ? parseInt(feeLimitInSun)
            : Number(feeLimitInSun),
      }

      if (args.value) {
        options.callValue = parseValue(args.value as string)
        consola.info(`Sending ${args.value} with transaction`)
      }

      if (args.energyLimit) {
        options.userFeePercentage = 100
        options.originEnergyLimit = parseInt(args.energyLimit as string)
      }

      // Get contract instance
      const contract = await tronWeb.contract().at(args.address)

      if (args.dryRun) {
        consola.info('Dry run mode - transaction will not be sent')

        // Estimate costs
        const estimatedEnergy = args.energyLimit
          ? parseInt(args.energyLimit as string)
          : 100000
        const estimatedBandwidth = 350
        const cost = estimatedEnergy * 0.00021 + estimatedBandwidth * 0.001

        const gasUsage = formatGasUsage({
          energy: estimatedEnergy,
          bandwidth: estimatedBandwidth,
          cost,
        })

        consola.info('Estimated costs:')
        consola.log(gasUsage)
        return
      }

      // Execute transaction
      consola.info('Sending transaction...')

      let txId
      if (parsedParams.length > 0)
        txId = await contract[funcSig.name](...parsedParams).send(options)
      else txId = await contract[funcSig.name]().send(options)

      consola.success(`Transaction sent: ${txId}`)

      if (args.confirm) {
        consola.info('Waiting for confirmation...')
        const receipt = (await waitForConfirmation(
          tronWeb,
          txId
        )) as ITransactionReceipt

        if (args.json) consola.log(JSON.stringify(receipt, null, 2))
        else consola.log(formatReceipt(receipt))

        if (receipt.result === 'FAILED')
          throw new Error(
            `Transaction failed: ${receipt.resMessage || 'Unknown error'}`
          )
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(errorMessage)
      process.exit(1)
    }
  },
})
