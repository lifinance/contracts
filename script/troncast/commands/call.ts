import { defineCommand } from 'citty'
import { consola } from 'consola'

import type { Environment } from '../types'
import { formatOutput } from '../utils/abi'
import {
  parseFunctionSignature,
  parseArgument,
  isValidAddress,
} from '../utils/parser'
import { initTronWeb } from '../utils/tronweb'

export const callCommand = defineCommand({
  meta: {
    name: 'call',
    description: 'Call a read-only function on a Tron contract',
  },
  args: {
    address: {
      type: 'positional',
      description: 'Contract address',
      required: true,
    },
    signature: {
      type: 'positional',
      description: 'Function signature (e.g., "balanceOf(address)")',
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
    block: {
      type: 'string',
      description: 'Block number for historical queries',
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
      if (env !== 'mainnet' && env !== 'testnet')
        throw new Error('Environment must be "mainnet" or "testnet"')

      // Initialize TronWeb
      const tronWeb = initTronWeb(env)

      // Parse function signature
      const funcSig = parseFunctionSignature(args.signature)
      consola.debug(`Calling ${funcSig.name} on ${args.address}`)

      // Parse parameters
      const params = args.params
        ? args.params.split(',').map((p) => p.trim())
        : []
      if (params.length !== funcSig.inputs.length)
        throw new Error(
          `Expected ${funcSig.inputs.length} parameters, got ${params.length}`
        )

      const parsedParams = params.map((param, i) => {
        const inputType = funcSig.inputs[i]?.type || 'string'
        consola.debug(`Parsing param ${i}: ${param} as ${inputType}`)
        return parseArgument(inputType, param)
      })

      // Execute raw call using triggerConstantContract
      let result
      try {
        // For addresses, ensure they're in the right format
        const formattedParams = parsedParams.map((param, i) => {
          if (
            funcSig.inputs[i]?.type === 'address' &&
            typeof param === 'string'
          ) {
            // Ensure address is in base58 format for TronWeb
            if (param.startsWith('0x')) return tronWeb.address.fromHex(param)

            return param
          }
          return param
        })

        consola.debug('Formatted params:', formattedParams)
        consola.debug(
          'Function signature:',
          funcSig.name +
            '(' +
            funcSig.inputs.map((input) => input.type).join(',') +
            ')'
        )

        // Build parameter object for TronWeb
        const parameter =
          formattedParams.length > 0
            ? formattedParams.map((param, i) => ({
                type: funcSig.inputs[i]?.type || 'string',
                value: param,
              }))
            : []

        result = await tronWeb.transactionBuilder.triggerConstantContract(
          args.address,
          funcSig.name +
            '(' +
            funcSig.inputs.map((input) => input.type).join(',') +
            ')',
          {},
          parameter,
          tronWeb.defaultAddress?.base58 || tronWeb.defaultAddress?.hex || ''
        )
      } catch (callError) {
        const errorMessage =
          callError instanceof Error ? callError.message : 'Unknown error'
        consola.debug('Call error details:', callError)
        throw new Error(`Call failed: ${errorMessage}`)
      }

      // Check if call was successful
      if (!result || !result.result) {
        const errorMsg = result?.constant_result?.[0]
          ? tronWeb.toUtf8(result.constant_result[0])
          : 'Unknown error'
        throw new Error(`Call failed: ${errorMsg}`)
      }

      // Decode the result
      type DecodedResult =
        | string
        | number
        | boolean
        | bigint
        | Record<string, unknown>
        | unknown[]
        | null
      let decodedResult: DecodedResult = null
      if (
        funcSig.outputs.length > 0 &&
        result.constant_result &&
        result.constant_result[0]
      ) {
        const types = funcSig.outputs.map((output) => output.type)
        try {
          // Remove '0x' prefix if present
          const hexResult = result.constant_result[0].startsWith('0x')
            ? result.constant_result[0].slice(2)
            : result.constant_result[0]

          // Decode based on type
          if (types.length === 1 && types[0] === 'address') {
            // Special handling for addresses
            decodedResult = '0x' + hexResult.slice(-40)
            // Convert to base58 if it's a valid hex address
            if (decodedResult.length === 42)
              try {
                decodedResult = tronWeb.address.fromHex(decodedResult)
              } catch {
                // Keep as hex if conversion fails
              }
          } else {
            // Use TronWeb's decoder for other types
            const decoded = tronWeb.utils.abi.decodeParams(
              [], // names (not used)
              types,
              '0x' + hexResult
            )
            decodedResult = decoded.length === 1 ? decoded[0] : decoded
          }
        } catch (decodeError) {
          const errorMessage =
            decodeError instanceof Error
              ? decodeError.message
              : 'Unknown decode error'
          consola.debug('Failed to decode result:', errorMessage)
          decodedResult = result.constant_result[0]
        }
      }

      // Format output
      if (args.json) {
        // Handle BigInt serialization
        const jsonResult = JSON.stringify(
          decodedResult,
          (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          2
        )
        consola.log(jsonResult)
      } else if (funcSig.outputs.length === 0)
        consola.success('Call executed successfully (no return value)')
      else if (funcSig.outputs.length === 1) {
        const firstOutput = funcSig.outputs[0]
        if (firstOutput) {
          const formatted = formatOutput(firstOutput.type, decodedResult)
          consola.log(formatted)
        }
      }
      // Multiple return values
      else
        funcSig.outputs.forEach((output, i: number) => {
          let value: unknown
          if (Array.isArray(decodedResult)) value = decodedResult[i]
          else if (
            decodedResult &&
            typeof decodedResult === 'object' &&
            output.name
          )
            value = (decodedResult as Record<string, unknown>)[output.name]
          else if (decodedResult && typeof decodedResult === 'object')
            value = (decodedResult as Record<string, unknown>)[i]
          else value = decodedResult

          const formatted = formatOutput(output.type, value)
          const label = output.name || `output${i}`
          consola.log(`${label}: ${formatted}`)
        })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(errorMessage)
      process.exit(1)
    }
  },
})
