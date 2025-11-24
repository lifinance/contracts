import { readFileSync } from 'fs'
import { resolve } from 'path'

import { defineCommand } from 'citty'
import { consola } from 'consola'

import { EnvironmentEnum } from '../../common/types'
import {
  getEnvironment,
  getPrivateKey,
  loadForgeArtifact,
} from '../../deploy/tron/utils'
import type { Environment, ITransactionReceipt } from '../types'
import { formatGasUsage, formatReceipt } from '../utils/formatter'
import {
  isValidAddress,
  parseArgument,
  parseFunctionSignature,
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
      description: 'Environment (mainnet or testnet)',
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
    rpcUrl: {
      type: 'string',
      description: 'Custom RPC URL (overrides environment variable)',
    },
  },
  async run({ args }) {
    try {
      // Validate inputs
      if (!isValidAddress(args.address))
        throw new Error(`Invalid contract address: ${args.address}`)

      const env = args.env as Environment
      if (env !== 'mainnet' && env !== 'testnet')
        throw new Error('Environment must be "mainnet" or "testnet"')

      // Get private key
      const privateKey = args.privateKey || (await getPrivateKey())
      if (!privateKey)
        throw new Error('Private key is required for sending transactions')

      // Initialize TronWeb with private key and optional custom RPC URL
      const tronWeb = initTronWeb(env, privateKey, args.rpcUrl)

      // Parse function signature
      const funcSig = parseFunctionSignature(args.signature)
      consola.info(`Preparing to call ${funcSig.name} on ${args.address}`)

      // Parse parameters
      // Special handling for arrays: need to properly parse JSON arrays in any position
      let params: string[] = []
      if (args.params) {
        const paramsStr = args.params.trim()

        // Check if any parameter is an array type
        const hasArrayParam = funcSig.inputs.some((input) =>
          input.type.endsWith('[]')
        )

        if (hasArrayParam) {
          // Smart parsing: handle arrays in any position
          // Strategy: parse by finding JSON arrays and splitting around them
          const parsed: string[] = []
          let currentPos = 0
          let bracketDepth = 0
          let inString = false
          let stringChar = ''

          for (let i = 0; i < paramsStr.length; i++) {
            const char = paramsStr[i]

            // Track string boundaries to avoid splitting inside strings
            if (
              (char === '"' || char === "'") &&
              (i === 0 || paramsStr[i - 1] !== '\\')
            ) {
              if (!inString) {
                inString = true
                stringChar = char
              } else if (char === stringChar) {
                inString = false
              }
            }

            // Track bracket depth (only when not in string)
            if (!inString) {
              if (char === '[') bracketDepth++
              else if (char === ']') bracketDepth--

              // When we hit a comma at depth 0, we've found a parameter boundary
              if (char === ',' && bracketDepth === 0) {
                const param = paramsStr.slice(currentPos, i).trim()
                if (param) parsed.push(param)
                currentPos = i + 1
              }
            }
          }

          // Add the last parameter
          if (currentPos < paramsStr.length) {
            const param = paramsStr.slice(currentPos).trim()
            if (param) parsed.push(param)
          }

          params = parsed.length > 0 ? parsed : [paramsStr]
        } else {
          // No arrays, simple comma split
          params = paramsStr.split(',').map((p) => p.trim())
        }
      }

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
      // For functions with array parameters, we need to use the ABI directly
      // Try to load the ABI if it's a known contract, otherwise use contract().at()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let contract: any
      try {
        // Try to detect if this is a diamond call by checking for common facet functions
        const functionName = funcSig.name
        const isArrayFunction = funcSig.inputs.some((input) =>
          input.type.endsWith('[]')
        )

        if (isArrayFunction) {
          // For array functions, we need to load the ABI
          // Dynamically discover facets from deployment files
          let artifact = null

          try {
            // Determine network and environment
            const environment = await getEnvironment()
            const networkName =
              environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'
            const fileSuffix =
              environment === EnvironmentEnum.production ? '' : 'staging.'
            const deploymentPath = resolve(
              process.cwd(),
              `deployments/${networkName}.${fileSuffix}json`
            )

            // Read deployment file to get all facet contracts
            const deployments = JSON.parse(
              readFileSync(deploymentPath, 'utf-8')
            )

            // Filter for contracts ending with "Facet"
            const facetNames = Object.keys(deployments).filter((name) =>
              name.endsWith('Facet')
            )

            consola.debug(
              `Found ${
                facetNames.length
              } facets in deployment file: ${facetNames.join(', ')}`
            )

            // Try each facet's ABI to find the function
            for (const facetName of facetNames) {
              try {
                const candidateArtifact = await loadForgeArtifact(facetName)
                const hasFunction = candidateArtifact.abi.some(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (item: any) =>
                    item.type === 'function' && item.name === functionName
                )
                if (hasFunction) {
                  artifact = candidateArtifact
                  consola.debug(`Using ABI from ${facetName}`)
                  break
                }
              } catch {
                // Facet artifact not found, try next
                continue
              }
            }
          } catch (error) {
            // Deployment file not found or can't be read, continue to fallback
            consola.debug(
              'Could not read deployment file, will use fallback ABI'
            )
          }

          if (artifact) {
            contract = tronWeb.contract(artifact.abi, args.address)
          } else {
            // Fallback: create a minimal ABI with just this function
            const minimalABI = [
              {
                type: 'function',
                name: functionName,
                inputs: funcSig.inputs.map((input) => ({
                  name: input.name || '',
                  type: input.type,
                })),
                outputs: funcSig.outputs.map((output) => ({
                  name: output.name || '',
                  type: output.type,
                })),
                stateMutability: 'nonpayable',
              },
            ]
            contract = tronWeb.contract(minimalABI, args.address)
          }
        } else {
          // For non-array functions, use the simpler contract().at()
          contract = await tronWeb.contract().at(args.address)
        }
      } catch (error) {
        consola.warn(
          'Failed to load ABI, using default contract instance:',
          error
        )
        contract = await tronWeb.contract().at(args.address)
      }

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
