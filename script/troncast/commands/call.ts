import { defineCommand } from 'citty'
import { consola } from 'consola'
import type { AbiFunction} from 'viem';
import { decodeFunctionResult, parseAbi } from 'viem'

import type { Environment } from '../types'
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

      // Use parseAbi with typecast
      const abi = parseAbi([`function ${args.signature}`] as readonly string[])

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
      if (!result?.result?.result) {
        const errorMsg = result?.constant_result?.[0]
          ? tronWeb.toUtf8(result.constant_result[0])
          : 'Unknown error'
        throw new Error(`Call failed: ${errorMsg}`)
      }

      if (!(abi[0] as AbiFunction)?.outputs.length) {
        if (result.constant_result.length) 
          console.log(`0x${result.constant_result[0]}`)
        
        return
      }

      const decodedResult = decodeFunctionResult({
        abi,
        functionName: funcSig.name,
        data: `0x${result.constant_result[0]}`,
      })

      // Helper function to convert addresses in the result
      const convertAddressesToTron = (value: any): any => {
        if (typeof value === 'string') {
          // Check if it's a hex address (0x followed by 40 hex chars)
          if (/^0x[a-fA-F0-9]{40}$/i.test(value))
            return tronWeb.address.fromHex(value)

          return value
        } else if (Array.isArray(value))
          return value.map(convertAddressesToTron)
        else if (typeof value === 'object' && value !== null) {
          const converted: any = {}
          for (const key in value)
            converted[key] = convertAddressesToTron(value[key])

          return converted
        }
        return value
      }

      const convertedResult = convertAddressesToTron(decodedResult)

      // Simply stringify with spaces instead of commas, keeping brackets
      const output = JSON.stringify(convertedResult, null, 0)
        .replace(/,/g, ' ') // Replace commas with spaces
        .replace(/"/g, '') // Remove quotes

      console.log(output)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(errorMessage)
      process.exit(1)
    }
  },
})
