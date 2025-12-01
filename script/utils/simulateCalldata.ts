#!/usr/bin/env bun

import { execSync, spawnSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import axios from 'axios'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { getRPCEnvVarName } from './network'
import { getViemChainForNetworkName } from './viemScriptHelpers'

interface ISimulationResult {
  method: 'viem' | 'foundry' | 'tenderly'
  success: boolean
  error?: string
  revertReason?: string
  gasEstimate?: bigint
  returnData?: Hex
  trace?: string | unknown
  details?: Record<string, unknown>
}

interface IViemSimulationResult extends ISimulationResult {
  method: 'viem'
  callTrace?: unknown
  prestateTrace?: unknown
}

interface IFoundrySimulationResult extends ISimulationResult {
  method: 'foundry'
  trace?: string
}

interface ITenderlySimulationResult extends ISimulationResult {
  method: 'tenderly'
  gasUsed?: bigint
  logs?: unknown[]
  stateDiff?: unknown
}

/**
 * Simulate calldata using Viem (RPC call)
 */
async function simulateWithViem(
  publicClient: PublicClient,
  target: Address,
  calldata: Hex,
  value = 0n,
  from?: Address,
  blockNumber?: bigint,
  detailed = true
): Promise<IViemSimulationResult> {
  const result: IViemSimulationResult = {
    method: 'viem',
    success: false,
  }

  try {
    // Prepare block number for calls
    const blockNumberParam = blockNumber ? { blockNumber } : undefined

    // Try to estimate gas first (this will fail if transaction would revert)
    try {
      const gasEstimate = await publicClient.estimateGas({
        to: target,
        data: calldata,
        value,
        account: from || zeroAddress,
        ...(blockNumberParam || {}),
      })
      result.gasEstimate = gasEstimate
    } catch (error: unknown) {
      // Extract revert reason if available
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      result.error = errorMessage
      result.revertReason = extractRevertReason(errorMessage)

      // Try to get trace even if gas estimation failed
      try {
        const traces = await getViemTrace(
          publicClient,
          target,
          calldata,
          value,
          from,
          blockNumber,
          detailed
        )
        if (traces.callTrace || traces.prestateTrace) {
          result.trace = traces.callTrace || traces.prestateTrace
          result.callTrace = traces.callTrace
          result.prestateTrace = traces.prestateTrace
          result.details = {
            ...result.details,
            traceAvailable: true,
            callTraceAvailable: !!traces.callTrace,
            prestateTraceAvailable: !!traces.prestateTrace,
          }
        }
      } catch (traceError) {
        const errorMsg =
          traceError instanceof Error ? traceError.message : String(traceError)
        consola.debug(`[viem] Failed to get trace: ${errorMsg}`)
        result.details = {
          ...result.details,
          traceAvailable: false,
          traceError: errorMsg,
        }
      }

      return result
    }

    // Try to call the contract
    try {
      const returnData = await publicClient.call({
        to: target,
        data: calldata,
        value,
        account: from || zeroAddress,
        ...(blockNumberParam || {}),
      })

      result.success = true
      result.returnData = returnData.data

      // Get trace for successful calls
      try {
        const traces = await getViemTrace(
          publicClient,
          target,
          calldata,
          value,
          from,
          blockNumber,
          detailed
        )
        if (traces.callTrace || traces.prestateTrace) {
          result.trace = traces.callTrace || traces.prestateTrace
          result.callTrace = traces.callTrace
          result.prestateTrace = traces.prestateTrace
          result.details = {
            ...result.details,
            traceAvailable: true,
            callTraceAvailable: !!traces.callTrace,
            prestateTraceAvailable: !!traces.prestateTrace,
          }
        } else {
          result.details = {
            ...result.details,
            traceAvailable: false,
            traceError:
              'Trace returned undefined (RPC may not support debug_traceCall)',
          }
        }
      } catch (traceError) {
        // Trace is optional, but log the error so user knows why trace isn't available
        const errorMsg =
          traceError instanceof Error ? traceError.message : String(traceError)
        consola.warn(`[viem] Failed to get trace: ${errorMsg}`)
        result.details = {
          ...result.details,
          traceAvailable: false,
          traceError: errorMsg,
        }
      }

      return result
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      result.error = errorMessage
      result.revertReason = extractRevertReason(errorMessage)

      // Try to get trace even if call failed
      try {
        const traces = await getViemTrace(
          publicClient,
          target,
          calldata,
          value,
          from,
          blockNumber,
          detailed
        )
        if (traces.callTrace || traces.prestateTrace) {
          result.trace = traces.callTrace || traces.prestateTrace
          result.callTrace = traces.callTrace
          result.prestateTrace = traces.prestateTrace
          result.details = {
            ...result.details,
            traceAvailable: true,
            callTraceAvailable: !!traces.callTrace,
            prestateTraceAvailable: !!traces.prestateTrace,
          }
        }
      } catch (traceError) {
        const errorMsg =
          traceError instanceof Error ? traceError.message : String(traceError)
        consola.debug(`[viem] Failed to get trace: ${errorMsg}`)
        result.details = {
          ...result.details,
          traceAvailable: false,
          traceError: errorMsg,
        }
      }

      return result
    }
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

/**
 * Get execution trace using debug_traceCall RPC method
 * Returns multiple trace types for comprehensive debugging
 */
async function getViemTrace(
  publicClient: PublicClient,
  target: Address,
  calldata: Hex,
  value = 0n,
  from?: Address,
  blockNumber?: bigint,
  detailed = true
): Promise<{ callTrace?: unknown; prestateTrace?: unknown }> {
  const traces: { callTrace?: unknown; prestateTrace?: unknown } = {}
  const blockNumberForTrace =
    blockNumber || (await publicClient.getBlockNumber())

  consola.debug(
    `[viem] Attempting to get trace at block ${blockNumberForTrace.toString()}`
  )

  const traceParams = {
    to: target,
    data: calldata,
    value: `0x${value.toString(16)}`,
    from: from || zeroAddress,
  }

  // Get detailed call trace with full stack information
  try {
    consola.debug('[viem] Fetching callTracer trace...')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callTrace = await (publicClient.request as any)({
      method: 'debug_traceCall',
      params: [
        traceParams,
        blockNumberForTrace.toString(),
        {
          tracer: 'callTracer',
          tracerConfig: {
            withLog: true, // Include event logs
            withOutput: true, // Include output data
            withPrecompiles: true, // Include precompiled contract calls
          },
          timeout: '30s',
        },
      ],
    })
    // Validate that we got a trace (not null/undefined)
    if (callTrace !== null && callTrace !== undefined) {
      traces.callTrace = callTrace
      consola.debug('[viem] Call trace retrieved successfully')
    } else {
      consola.debug('[viem] callTracer returned null/undefined')
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    consola.debug(`[viem] callTracer failed: ${errorMsg}`)
    // Don't throw, continue to try other tracers
  }

  // Get prestate trace for state changes (if detailed mode)
  if (detailed) {
    try {
      consola.debug('[viem] Fetching prestateTracer trace...')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prestateTrace = await (publicClient.request as any)({
        method: 'debug_traceCall',
        params: [
          traceParams,
          blockNumberForTrace.toString(),
          {
            tracer: 'prestateTracer',
            timeout: '30s',
          },
        ],
      })
      traces.prestateTrace = prestateTrace
      consola.debug('[viem] Prestate trace retrieved successfully')
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.debug(`[viem] prestateTracer failed: ${errorMsg}`)
      // Don't throw, prestate trace is optional
    }
  }

  // If we got at least one trace, return it
  if (traces.callTrace || traces.prestateTrace) {
    return traces
  }

  // If no traces were successful, try with "latest" block tag as fallback
  // Some RPC providers prefer "latest" over block numbers
  if (!blockNumber) {
    try {
      consola.debug('[viem] Retrying with "latest" block tag...')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callTrace = await (publicClient.request as any)({
        method: 'debug_traceCall',
        params: [
          traceParams,
          'latest',
          {
            tracer: 'callTracer',
            tracerConfig: {
              withLog: true,
              withOutput: true,
              withPrecompiles: true,
            },
            timeout: '30s',
          },
        ],
      })
      if (callTrace !== null && callTrace !== undefined) {
        traces.callTrace = callTrace
        consola.debug('[viem] Call trace retrieved successfully with "latest"')
        return traces
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.debug(`[viem] Retry with "latest" also failed: ${errorMsg}`)
    }
  }

  // If still no traces, throw an error with helpful message
  throw new Error(
    'Failed to retrieve traces from RPC provider. The RPC may not support debug_traceCall, or the method may be disabled. Try using Foundry or Tenderly simulation methods instead.'
  )
}

/**
 * Simulate calldata using Foundry cast run
 */
async function simulateWithFoundry(
  network: string,
  target: Address,
  calldata: Hex,
  value = 0n,
  from?: Address,
  blockNumber?: bigint
): Promise<IFoundrySimulationResult> {
  const result: IFoundrySimulationResult = {
    method: 'foundry',
    success: false,
  }

  // Get RPC URL for the network
  // Use the same logic as getViemChainForNetworkName to get RPC URL
  const envKey = getRPCEnvVarName(network)
  const rpcUrl = process.env[envKey]

  if (!rpcUrl) {
    result.error = `Could not find RPC URL for network ${network}. Please set ${envKey} environment variable.`
    return result
  }

  // Build cast call command parts (outside try block for error handling)
  // cast call expects: cast call <target> --data <calldata> [options]
  const commandParts = ['cast', 'call', target, '--data', calldata]

  if (value > 0n) {
    commandParts.push('--value', value.toString())
  }

  if (from) {
    commandParts.push('--from', from)
  }

  if (blockNumber) {
    commandParts.push('--block', blockNumber.toString())
    consola.info(`[foundry] Using block number: ${blockNumber.toString()}`)
  } else {
    consola.info('[foundry] Using latest block (no block number specified)')
  }

  commandParts.push('--trace', '--rpc-url', rpcUrl)

  const command = commandParts.join(' ')

  try {
    // Check if cast is available
    try {
      execSync('which cast', { stdio: 'ignore' })
    } catch {
      result.error =
        'Foundry cast not found. Please install Foundry: https://book.getfoundry.sh/getting-started/installation'
      return result
    }

    consola.info(`[foundry] Executing: ${command}`)
    consola.debug(`[foundry] Full command: ${command}`)

    // Use spawnSync to get better access to stdout/stderr separately
    const cmd = commandParts[0]
    const args = commandParts.slice(1)

    if (!cmd) {
      result.error = 'Invalid command: empty command parts'
      return result
    }

    const spawnResult = spawnSync(cmd, args, {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large traces
    })

    if (spawnResult.error) {
      // Command not found or other spawn error
      const errorMsg = spawnResult.error.message
      result.error = errorMsg
      result.revertReason = extractRevertReason(errorMsg)
      result.trace = errorMsg
      result.details = {
        command,
        error: errorMsg,
        exitCode: undefined,
      }

      if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
        result.error =
          'Foundry cast not found. Please install Foundry: https://book.getfoundry.sh/getting-started/installation'
      }

      return result
    }

    const stdout = spawnResult.stdout?.toString() || ''
    const stderr = spawnResult.stderr?.toString() || ''
    const exitCode = spawnResult.status

    if (exitCode !== 0) {
      // Command executed but failed
      const errorOutput =
        stderr || stdout || `Command failed with exit code ${exitCode}`
      result.error = errorOutput
      result.revertReason = extractRevertReason(errorOutput)
      result.trace =
        [stdout, stderr].filter(Boolean).join('\n--- STDERR ---\n') ||
        errorOutput
      result.details = {
        command,
        stdout,
        stderr,
        exitCode,
        fullError: errorOutput,
      }
      return result
    }

    // Success
    result.success = true
    result.trace = stdout
    result.details = {
      command,
      output: stdout,
      blockNumber: blockNumber?.toString(),
      args: commandParts.slice(1), // Show the actual args array for debugging
    }
    return result
  } catch (error: unknown) {
    // Fallback error handling
    const errorMsg = error instanceof Error ? error.message : String(error)
    const command = commandParts.join(' ')
    result.error = errorMsg
    result.revertReason = extractRevertReason(errorMsg)
    result.trace = errorMsg
    result.details = {
      command,
      error: errorMsg,
    }
    return result
  }
}

/**
 * Simulate calldata using Tenderly API
 *
 * Requires TENDERLY_ACCESS_KEY environment variable.
 * Project and username are hardcoded for LiFi organization.
 */
async function simulateWithTenderly(
  network: string,
  chainId: number,
  target: Address,
  calldata: Hex,
  value = 0n,
  from?: Address,
  _blockNumber?: bigint // Unused - always using 'latest' for better Tenderly compatibility
): Promise<ITenderlySimulationResult> {
  const result: ITenderlySimulationResult = {
    method: 'tenderly',
    success: false,
  }

  try {
    // Hardcoded Tenderly configuration for LiFi organization
    const project = 'backend'
    const username = 'lifinance'

    const accessKey = process.env.TENDERLY_ACCESS_KEY
    if (!accessKey) {
      result.error = 'TENDERLY_ACCESS_KEY environment variable not set'
      return result
    }

    // Use a default from address if not provided
    const fromAddress = from || zeroAddress

    // Validate addresses
    if (!isAddress(fromAddress)) {
      result.error = `Invalid from address: ${fromAddress}`
      return result
    }
    if (!isAddress(target)) {
      result.error = `Invalid target address: ${target}`
      return result
    }

    // Build simulation payload according to Tenderly API spec
    // Reference: https://docs.tenderly.co/simulations/single-simulations#simulate-via-api
    const simulationPayload: Record<string, string | number> = {
      network_id: chainId.toString(), // Tenderly expects string
      from: fromAddress.toLowerCase(),
      to: target.toLowerCase(),
      input: calldata,
      value: Number(value.toString()), // Convert to number
      gas: 30_000_000, // Required field - use a high gas limit for simulations
      gas_price: 0, // Include gas_price as per docs example
    }

    // Add block_number if provided, otherwise omit (Tenderly will use latest)
    // According to docs, block_number should be a number, not 'latest' string
    if (_blockNumber) {
      simulationPayload.block_number = Number(_blockNumber)
      consola.debug(`[tenderly] Using block number: ${_blockNumber.toString()}`)
    }
    // If no blockNumber, omit the field - Tenderly will use latest block

    const url = `https://api.tenderly.co/api/v1/account/${username}/project/${project}/simulate`

    consola.debug(
      `[tenderly] Simulating transaction on ${network} (chainId: ${chainId})`
    )
    consola.debug(`[tenderly] Using project: ${project}, username: ${username}`)
    consola.debug(`[tenderly] API URL: ${url}`)
    consola.debug(
      `[tenderly] Payload: ${JSON.stringify(simulationPayload, null, 2)}`
    )

    // Send payload directly, NOT wrapped in simulations array
    // Reference: https://docs.tenderly.co/simulations/single-simulations#simulate-via-api
    const response = await axios.post(
      url,
      simulationPayload, // Send payload directly, not wrapped
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': accessKey,
        },
        timeout: 30000,
      }
    )

    // Response is the simulation result directly, not wrapped in simulation_results array
    const simulation = response.data
    if (!simulation) {
      result.error = 'No simulation results returned from Tenderly'
      return result
    }

    if (simulation.status === false) {
      result.error =
        simulation.transaction?.error_message || 'Simulation failed'
      result.revertReason = simulation.transaction?.error_message
      result.gasUsed = simulation.transaction?.gas_used
        ? BigInt(simulation.transaction.gas_used)
        : undefined
      result.logs = simulation.transaction?.logs
      return result
    }

    result.success = true
    result.gasUsed = simulation.transaction?.gas_used
      ? BigInt(simulation.transaction.gas_used)
      : undefined
    result.returnData = simulation.transaction?.output
    result.logs = simulation.transaction?.logs
    result.stateDiff = simulation.transaction?.state_diff

    // Extract trace data from Tenderly response
    // Tenderly response has call_trace at the root level of the simulation object
    // Store the entire simulation object as trace (it contains call_trace)
    result.trace = simulation

    result.details = {
      gasUsed: result.gasUsed?.toString(),
      logsCount: result.logs?.length || 0,
      stateDiff: result.stateDiff,
      traceAvailable: !!simulation,
    }

    return result
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const errorMessage =
        error.response?.data?.error?.message ||
        error.message ||
        'Tenderly API error'

      // Add helpful context for different error types
      if (error.response?.status === 404) {
        result.error = `${errorMessage}. Project: backend, Username: lifinance. Please verify these values match your Tenderly account.`
      } else if (error.response?.status === 500) {
        const requestPayload = error.config?.data
          ? JSON.parse(error.config.data)
          : null
        result.error = `${errorMessage}. This may indicate an issue with the request payload or Tenderly service. Check the details below.`
        result.details = {
          status: error.response?.status,
          data: error.response?.data,
          url: error.config?.url,
          requestPayload: requestPayload,
          chainId,
          network,
        }
      } else {
        result.error = errorMessage
        result.details = {
          status: error.response?.status,
          data: error.response?.data,
          url: error.config?.url,
        }
      }
    } else {
      result.error = error instanceof Error ? error.message : String(error)
    }
    return result
  }
}

/**
 * Format calldata for display (show full data, truncated if too long)
 */
function formatCalldata(input: string | undefined, maxLength = 200): string {
  if (!input || input === '0x') return '0x'
  if (input.length <= maxLength) return input
  return `${input.slice(0, maxLength)}... (${input.length} chars)`
}

/**
 * Format return value for display (try to decode if possible)
 */
function formatReturnValue(output: string | undefined): string {
  if (!output || output === '0x' || output.length <= 2) return ''

  // If it's a single value (32 bytes = 66 chars including 0x), try to format it nicely
  if (output.length === 66) {
    // Check if it matches the address pattern (24 leading zeros + 40 hex chars)
    // Pattern: 0x + 24 zeros + 40 hex chars = 66 total
    const addressPattern = /^0x000000000000000000000000[a-fA-F0-9]{40}$/
    if (addressPattern.test(output)) {
      const addr = `0x${output.slice(26)}`
      // If it's not all zeros, treat it as an address
      // Addresses have at least some non-zero bytes in the lower 20 bytes
      if (addr !== '0x0000000000000000000000000000000000000000') {
        // Check if the address part has significant non-zero content (not just a tiny number)
        const addrValue = BigInt(addr)
        // If the address value is very small (< 2^64), it's probably a number, not an address
        if (addrValue >= 2n ** 64n) {
          return ` => (${addr})`
        }
        // Otherwise, it's a small number padded as address, decode as number
      } else {
        // All zeros = number 0
        return ` => (0)`
      }
    }

    // Try to decode as a number
    try {
      const num = BigInt(output)
      if (num === 0n) {
        return ` => (0)`
      } else if (num < 2n ** 128n) {
        // Show as decimal for reasonable-sized numbers
        return ` => (${num.toString()})`
      } else {
        // Very large number, show as hex
        return ` => (${output})`
      }
    } catch {
      // Not a valid number, show as hex
      return ` => (${output})`
    }
  }

  // For longer outputs (multiple return values), show preview
  if (output.length > 66) {
    return ` => (${output.slice(0, 66)}...)`
  }

  // Fallback: show as-is
  return ` => (${output})`
}

/**
 * Parse Tenderly trace into a readable stack trace format (similar to Foundry)
 */
function parseTenderlyTrace(trace: unknown): string {
  if (!trace || typeof trace !== 'object') {
    return 'Unable to parse trace: Invalid format'
  }

  const traceObj = trace as Record<string, unknown>
  const lines: string[] = []

  // Extract call stack from Tenderly's call_trace structure
  // Handles both formats:
  // 1. Object format with nested calls array
  // 2. Flat array format where subtraces indicates nested calls
  const extractCallStack = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object') return

    const nodeObj = node as Record<string, unknown>
    const indent = '  '.repeat(depth)

    // Extract Tenderly-specific fields
    const to = nodeObj.to as string | undefined
    const input = nodeObj.input as string | undefined
    const output = nodeObj.output as string | undefined
    const value = nodeObj.value as string | number | null | undefined
    const gasUsed = nodeObj.gas_used as string | number | undefined
    const functionName = nodeObj.function_name as string | undefined
    const contractName = nodeObj.contract_name as string | undefined
    const callType = nodeObj.call_type as string | undefined
    const calls = nodeObj.calls as unknown[] | null | undefined
    const error = nodeObj.error as string | undefined
    const errorOp = nodeObj.error_op as string | undefined
    const errorLineNumber = nodeObj.error_line_number as number | undefined

    // Format function identifier
    let functionIdentifier = 'unknown'
    if (
      functionName &&
      functionName !== 'fallback' &&
      functionName !== '_fallback'
    ) {
      functionIdentifier = functionName
    } else if (input && input.length >= 10 && input !== '0x') {
      // Extract function signature from input (first 4 bytes)
      functionIdentifier = `0x${input.slice(2, 10)}`
    } else if (
      callType &&
      callType !== 'CALL' &&
      callType !== 'DELEGATECALL' &&
      callType !== 'STATICCALL'
    ) {
      functionIdentifier = callType
    } else if (callType) {
      // For generic CALL types, try to use function signature
      functionIdentifier = callType
    }

    // Format contract address/name
    const contractInfo = contractName
      ? `${contractName} (${to?.slice(0, 10)}...)`
      : to || 'unknown'

    // Build call line with function identifier
    const callLine = `${indent}[${depth}] ${contractInfo}::${functionIdentifier}`
    const gasInfo = gasUsed ? ` (gas: ${gasUsed})` : ''

    // Format value (handle null, string "0", or number 0)
    let valueInfo = ''
    if (
      value !== null &&
      value !== undefined &&
      value !== '0' &&
      value !== '0x0' &&
      value !== 0
    ) {
      const valueStr = typeof value === 'string' ? value : value.toString()
      valueInfo = ` (value: ${valueStr})`
    }

    lines.push(callLine + gasInfo + valueInfo)

    // Add error/revert information if present
    if (error || errorOp) {
      let errorMsg = error || ''
      // Clean up error message format (remove "value:" prefix if present)
      if (errorMsg.startsWith('value:"') && errorMsg.endsWith('"')) {
        errorMsg = errorMsg.slice(7, -1)
      }
      const errorIndicator = errorOp === 'REVERT' ? '❌ REVERT' : '❌ ERROR'
      let errorLine = `${indent}  ${errorIndicator}: ${errorMsg}`
      if (errorLineNumber) {
        errorLine += ` (line ${errorLineNumber})`
      }
      lines.push(errorLine)
    }

    // Add calldata (input) - show full data
    if (input && input !== '0x' && input.length > 2) {
      const formattedInput = formatCalldata(input)
      lines.push(`${indent}  ↳ Calldata: ${formattedInput}`)
    }

    // Add return value (output) - try to decode and format nicely
    // Only show if there's no error (errors typically don't have outputs)
    if (!error && output && output !== '0x' && output.length > 2) {
      const formattedOutput = formatReturnValue(output)
      if (formattedOutput) {
        lines.push(`${indent}  ↳ Return${formattedOutput}`)
      } else {
        const outputPreview =
          output.length > 66 ? `${output.slice(0, 66)}...` : output
        lines.push(`${indent}  ↳ Return: ${outputPreview}`)
      }
    }

    // Recursively process nested calls (object format with calls array)
    if (calls && Array.isArray(calls) && calls.length > 0) {
      calls.forEach((call) => {
        extractCallStack(call, depth + 1)
      })
    }
  }

  // Parse flat array format where subtraces indicates nested structure
  const parseFlatArrayFormat = (
    callArray: unknown[],
    startIndex = 0,
    depth = 0
  ): number => {
    if (startIndex >= callArray.length) return startIndex

    const call = callArray[startIndex] as Record<string, unknown>
    const indent = '  '.repeat(depth)

    // Extract fields
    const to = call.to as string | undefined
    const input = call.input as string | undefined
    const output = call.output as string | undefined
    const value = call.value as string | number | null | undefined
    const gasUsed = call.gas_used as string | number | undefined
    const callType = call.call_type as string | undefined
    const subtraces = (call.subtraces as number) || 0
    const error = call.error as string | undefined
    const errorOp = call.error_op as string | undefined
    const errorLineNumber = call.error_line_number as number | undefined

    // Format function identifier
    let functionIdentifier = 'unknown'
    if (input && input.length >= 10 && input !== '0x') {
      functionIdentifier = `0x${input.slice(2, 10)}`
    } else if (callType) {
      functionIdentifier = callType
    }

    // Format contract address
    const contractInfo = to || 'unknown'

    // Build call line
    const callLine = `${indent}[${depth}] ${contractInfo}::${functionIdentifier}`
    const gasInfo = gasUsed ? ` (gas: ${gasUsed})` : ''

    // Format value
    let valueInfo = ''
    if (
      value !== null &&
      value !== undefined &&
      value !== '0' &&
      value !== '0x0' &&
      value !== 0
    ) {
      const valueStr = typeof value === 'string' ? value : value.toString()
      valueInfo = ` (value: ${valueStr})`
    }

    lines.push(callLine + gasInfo + valueInfo)

    // Add error/revert information if present
    if (error || errorOp) {
      let errorMsg = error || ''
      // Clean up error message format (remove "value:" prefix if present)
      if (errorMsg.startsWith('value:"') && errorMsg.endsWith('"')) {
        errorMsg = errorMsg.slice(7, -1)
      }
      const errorIndicator = errorOp === 'REVERT' ? '❌ REVERT' : '❌ ERROR'
      let errorLine = `${indent}  ${errorIndicator}: ${errorMsg}`
      if (errorLineNumber) {
        errorLine += ` (line ${errorLineNumber})`
      }
      lines.push(errorLine)
    }

    // Add calldata (input) - show full data
    if (input && input !== '0x' && input.length > 2) {
      const formattedInput = formatCalldata(input)
      lines.push(`${indent}  ↳ Calldata: ${formattedInput}`)
    }

    // Add return value (output) - try to decode and format nicely
    // Only show if there's no error (errors typically don't have outputs)
    if (!error && output && output !== '0x' && output.length > 2) {
      const formattedOutput = formatReturnValue(output)
      if (formattedOutput) {
        lines.push(`${indent}  ↳ Return${formattedOutput}`)
      } else {
        const outputPreview =
          output.length > 66 ? `${output.slice(0, 66)}...` : output
        lines.push(`${indent}  ↳ Return: ${outputPreview}`)
      }
    }

    // Process nested calls (next subtraces items are children)
    let nextIndex = startIndex + 1
    for (let i = 0; i < subtraces; i++) {
      nextIndex = parseFlatArrayFormat(callArray, nextIndex, depth + 1)
    }

    return nextIndex
  }

  // Tenderly trace structure can be in different formats:
  // Format 1: trace.call_trace is an object with nested calls array
  // Format 2: trace.transaction.call_trace is an array of call objects
  // Format 3: trace.transaction.call_trace is an object with nested calls

  let callTraceToProcess: unknown = null

  if (traceObj.call_trace) {
    callTraceToProcess = traceObj.call_trace
  } else if ((traceObj.transaction as Record<string, unknown>)?.call_trace) {
    callTraceToProcess = (traceObj.transaction as Record<string, unknown>)
      .call_trace
  } else if (
    (traceObj.transaction_info as Record<string, unknown>)?.call_trace
  ) {
    callTraceToProcess = (traceObj.transaction_info as Record<string, unknown>)
      .call_trace
  }

  if (callTraceToProcess) {
    // Handle array format (new Tenderly API format - flat array with subtraces)
    if (Array.isArray(callTraceToProcess)) {
      parseFlatArrayFormat(callTraceToProcess, 0, 0)
    } else {
      // Handle object format (old format with nested calls array)
      extractCallStack(callTraceToProcess, 0)
    }
  } else if (traceObj.transaction) {
    // Fallback: try transaction structure directly
    extractCallStack(traceObj.transaction, 0)
  } else if (traceObj.calls) {
    // Fallback: try direct calls array
    const calls = traceObj.calls as unknown[]
    if (Array.isArray(calls)) {
      calls.forEach((call) => {
        extractCallStack(call, 0)
      })
    }
  } else {
    // Last resort: try to extract from root object
    extractCallStack(traceObj, 0)
  }

  if (lines.length === 0) {
    return 'No call stack found in trace. Trace structure may be different than expected.'
  }

  return lines.join('\n')
}

/**
 * Save trace to a file for later analysis
 */
function saveTraceToFile(
  trace: unknown,
  method: string,
  network: string,
  target: Address,
  success: boolean
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logDir = join(process.cwd(), 'logs', 'simulations')

  // Create logs directory if it doesn't exist
  try {
    mkdirSync(logDir, { recursive: true })
  } catch (error) {
    consola.warn(`Failed to create log directory: ${error}`)
    return ''
  }

  const filename = `trace-${method}-${network}-${target.slice(
    0,
    10
  )}-${timestamp}.json`
  const filepath = join(logDir, filename)

  try {
    const traceData = {
      metadata: {
        method,
        network,
        target,
        success,
        timestamp: new Date().toISOString(),
      },
      trace,
    }

    writeFileSync(filepath, JSON.stringify(traceData, null, 2), 'utf-8')
    return filepath
  } catch (error) {
    consola.warn(`Failed to save trace to file: ${error}`)
    return ''
  }
}

/**
 * Extract revert reason from error message
 */
function extractRevertReason(errorMessage: string): string | undefined {
  // Try to extract revert reason from common error formats
  const patterns = [
    /execution reverted: (.+)/i,
    /revert (.+)/i,
    /reverted with reason string (.+)/i,
    /reverted with custom error (.+)/i,
    /Error: (.+)/i,
  ]

  for (const pattern of patterns) {
    const match = errorMessage.match(pattern)
    if (match && match[1]) {
      return match[1].trim()
    }
  }

  return undefined
}

/**
 * Format and display simulation results
 */
function displayResults(
  results: ISimulationResult[],
  target: Address,
  network: string
): void {
  // Display each result with clear separators
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (!result) continue // Skip if result is undefined

    // Add spacing before each method (except the first)
    if (i > 0) {
      consola.log('')
      consola.log('')
    }

    // Colored separator line announcing the method
    const methodColors: Record<string, string> = {
      viem: '\x1b[36m', // Cyan
      foundry: '\x1b[33m', // Yellow
      tenderly: '\x1b[35m', // Magenta
    }
    const resetColor = '\x1b[0m'
    const color = methodColors[result.method] || ''

    consola.log(color + '═'.repeat(80) + resetColor)
    consola.log(color + `Method: ${result.method.toUpperCase()}` + resetColor)
    consola.log(color + '═'.repeat(80) + resetColor)

    if (result.success) {
      consola.success('✅ Simulation succeeded')

      // For Viem, always show the three key items prominently
      if (result.method === 'viem') {
        const viemResult = result as IViemSimulationResult
        const details = result.details as { traceError?: string } | undefined
        consola.log('')
        consola.log('📊 Viem Simulation Summary:')
        consola.log(`   Status: ✅ SUCCEEDED`)
        if (result.gasEstimate) {
          consola.log(`   Gas Estimate: ${result.gasEstimate.toString()}`)
        } else {
          consola.log(`   Gas Estimate: Not available`)
        }
        if (viemResult.callTrace || viemResult.prestateTrace || result.trace) {
          consola.log(`   Stack Trace: ✅ Available (see below)`)
        } else {
          const traceErrorMsg = details?.traceError
            ? ` - ${details.traceError}`
            : ''
          consola.log(`   Stack Trace: ⚠️  Not available${traceErrorMsg}`)
        }
        consola.log('')
      } else {
        // For other methods, show gas estimate normally
        if (result.gasEstimate) {
          consola.log(`Gas Estimate: ${result.gasEstimate.toString()}`)
        }
        if ((result as ITenderlySimulationResult).gasUsed) {
          consola.log(
            `Gas Used: ${(
              result as ITenderlySimulationResult
            ).gasUsed?.toString()} (actual from simulation)`
          )
        }
      }

      if (result.returnData) {
        consola.log(`Return Data: ${result.returnData}`)
      }
      if ((result as ITenderlySimulationResult).logs) {
        const logs = (result as ITenderlySimulationResult).logs || []
        consola.log(`Logs: ${logs.length} events emitted`)
      }

      // Show trace for Viem if available (for both success and failure)
      if (result.method === 'viem') {
        const viemResult = result as IViemSimulationResult
        const details = result.details as
          | {
              traceError?: string
              callTraceAvailable?: boolean
              prestateTraceAvailable?: boolean
            }
          | undefined

        if (viemResult.callTrace) {
          consola.log('\n📋 Viem Call Trace (Full Stack):')
          consola.log(JSON.stringify(viemResult.callTrace, null, 2))
        } else if (details?.traceError) {
          consola.log(`\n⚠️  Trace Error: ${details.traceError}`)
        }

        if (viemResult.prestateTrace) {
          consola.log('\n📋 Viem Prestate Trace (State Changes):')
          consola.log(JSON.stringify(viemResult.prestateTrace, null, 2))
        }

        // Fallback to generic trace if available
        if (
          result.trace &&
          !viemResult.callTrace &&
          !viemResult.prestateTrace
        ) {
          consola.log('\n📋 Viem Execution Trace:')
          consola.log(JSON.stringify(result.trace, null, 2))
        }
      }
    } else {
      consola.error('❌ Simulation failed')

      // For Viem failures, always show the three key items prominently
      if (result.method === 'viem') {
        const viemResult = result as IViemSimulationResult
        const details = result.details as { traceError?: string } | undefined
        consola.log('')
        consola.log('📊 Viem Simulation Summary:')
        consola.log(`   Status: ❌ FAILED`)
        if (result.gasEstimate) {
          consola.log(`   Gas Estimate: ${result.gasEstimate.toString()}`)
        } else {
          consola.log(
            `   Gas Estimate: Not available (failed before gas estimation)`
          )
        }
        if (viemResult.callTrace || viemResult.prestateTrace || result.trace) {
          consola.log(`   Stack Trace: ✅ Available (see below)`)
        } else {
          const traceErrorMsg = details?.traceError
            ? ` - ${details.traceError}`
            : ''
          consola.log(`   Stack Trace: ⚠️  Not available${traceErrorMsg}`)
        }
        consola.log('')
      }

      if (result.revertReason) {
        consola.error(`Revert Reason: ${result.revertReason}`)
      }
      if (result.error) {
        consola.error(`Error: ${result.error}`)
      }

      // For Foundry failures, always show the full trace/error output
      if (result.method === 'foundry') {
        const foundryResult = result as IFoundrySimulationResult
        const details = result.details as
          | {
              command?: string
              stdout?: string
              stderr?: string
              exitCode?: number
              fullError?: string
              error?: string
            }
          | undefined

        // Always show the trace if available
        if (foundryResult.trace) {
          consola.log('\n📋 Foundry Error Output/Trace:')
          consola.log(foundryResult.trace)
        }

        // Show command details only for failures (command already shown when executing)
        if (details) {
          if (details.exitCode !== undefined && details.exitCode !== null) {
            consola.log(`\nExit Code: ${details.exitCode}`)
          }
          // Only show stdout/stderr if they contain useful error information
          if (
            details.stderr &&
            !details.stderr.includes('Usage:') &&
            !details.stderr.includes('--help')
          ) {
            consola.log(`\nSTDERR:\n${details.stderr}`)
          }
          if (details.stdout && details.stdout.length > 0 && !details.stderr) {
            consola.log(`\nSTDOUT:\n${details.stdout}`)
          }
        }
      }

      // For Tenderly failures, show more details
      if (result.method === 'tenderly' && result.details) {
        consola.log('\n📋 Tenderly Error Details:')
        consola.log(JSON.stringify(result.details, null, 2))
      }

      // Show trace for Viem failures if available
      if (result.method === 'viem') {
        const viemResult = result as IViemSimulationResult
        if (viemResult.callTrace) {
          consola.log('\n📋 Viem Call Trace (Full Stack):')
          consola.log(JSON.stringify(viemResult.callTrace, null, 2))
        }
        if (viemResult.prestateTrace) {
          consola.log('\n📋 Viem Prestate Trace (State Changes):')
          consola.log(JSON.stringify(viemResult.prestateTrace, null, 2))
        }
        // Fallback to generic trace if available
        if (
          result.trace &&
          !viemResult.callTrace &&
          !viemResult.prestateTrace
        ) {
          consola.log('\n📋 Viem Execution Trace:')
          consola.log(JSON.stringify(result.trace, null, 2))
        }
        // Show error if no traces available
        if (
          !viemResult.callTrace &&
          !viemResult.prestateTrace &&
          !result.trace
        ) {
          const details = result.details as
            | {
                traceAvailable?: boolean
                traceError?: string
                callTraceAvailable?: boolean
                prestateTraceAvailable?: boolean
              }
            | undefined
          if (details?.traceError) {
            consola.log(`\n⚠️  Viem Trace: ${details.traceError}`)
          } else if (
            details?.callTraceAvailable === false ||
            details?.prestateTraceAvailable === false
          ) {
            consola.log(
              '\n⚠️  Viem Trace: Partial failure (some tracers may not be supported by RPC)'
            )
          } else {
            consola.log(
              '\n⚠️  Viem Trace: Not available (RPC may not support debug_traceCall)'
            )
          }
        }
      }
    }

    // Show trace for Foundry (for successful simulations)
    // Note: Command is already shown when executing, so we only show the trace
    if (
      result.success &&
      result.method === 'foundry' &&
      (result as IFoundrySimulationResult).trace
    ) {
      consola.log('\n📋 Foundry Execution Trace:')
      consola.log('─'.repeat(80))
      consola.log((result as IFoundrySimulationResult).trace)
      consola.log('─'.repeat(80))
    }

    // Show trace for Tenderly (for successful simulations)
    if (result.success && result.method === 'tenderly') {
      const tenderlyResult = result as ITenderlySimulationResult

      if (tenderlyResult.trace) {
        // Save full trace to file for AI analysis
        const traceFilePath = saveTraceToFile(
          tenderlyResult.trace,
          'tenderly',
          network,
          target,
          result.success
        )

        if (traceFilePath) {
          consola.log(`\n💾 Full trace saved to: ${traceFilePath}`)
          consola.log('   (You can feed this file to AI for analysis)')
        }

        // Parse and display readable stack trace
        consola.log('\n📋 Tenderly Execution Stack Trace:')
        consola.log('─'.repeat(80))
        try {
          // Ensure we're passing the correct trace structure
          // The trace should be the simulation object with call_trace at root
          const traceToParse = tenderlyResult.trace
          if (!traceToParse) {
            consola.warn('No trace data available to parse')
          } else {
            const parsedTrace = parseTenderlyTrace(traceToParse)
            if (parsedTrace.includes('No call stack found')) {
              consola.warn(
                'Parser could not find call stack. Trace structure may be unexpected.'
              )
              consola.debug(
                'Trace keys:',
                Object.keys((traceToParse as Record<string, unknown>) || {})
              )
            }
            consola.log(parsedTrace)
          }
        } catch (error) {
          consola.warn(`Failed to parse trace: ${error}`)
          if (error instanceof Error) {
            consola.debug(`Error details: ${error.message}`)
            consola.debug(`Stack: ${error.stack}`)
          }
          consola.log('(Full trace available in saved file above)')
        }
        consola.log('─'.repeat(80))

        if (traceFilePath) {
          consola.log(`\n💡 Tip: View full trace with: cat ${traceFilePath}`)
        }
      } else {
        // Check if trace is available in details
        const details = result.details as
          | { traceAvailable?: boolean }
          | undefined
        if (details?.traceAvailable === false) {
          consola.log('\n⚠️  Tenderly Trace: Not available in response')
        }
      }
    }
  }

  // Comparison summary
  consola.log('\n' + '='.repeat(80))
  consola.log('Summary')
  consola.log('='.repeat(80))

  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  consola.log(`Successful simulations: ${successful.length}/${results.length}`)
  consola.log(`Failed simulations: ${failed.length}/${results.length}`)

  if (successful.length > 0) {
    consola.log('\nSuccessful methods:')
    successful.forEach((r) => {
      consola.success(`  - ${r.method}`)
    })

    // Warn if only Viem succeeded but others failed
    // This is important because Viem's call is read-only and doesn't simulate state changes
    const onlyViemSucceeded =
      successful.length === 1 &&
      successful[0]?.method === 'viem' &&
      failed.length > 0
    if (onlyViemSucceeded) {
      consola.warn(
        '\n⚠️  WARNING: Only Viem succeeded, but other methods failed.'
      )
      consola.warn(
        "   Viem's `call` method is read-only and does NOT simulate state changes."
      )
      consola.warn(
        '   A successful Viem call does NOT guarantee the transaction will succeed.'
      )
      consola.warn(
        '   For accurate simulation, use Tenderly or Foundry which simulate full state changes.'
      )
    }
  }

  if (failed.length > 0) {
    consola.log('\nFailed methods:')
    failed.forEach((r) => {
      consola.error(
        `  - ${r.method}: ${r.revertReason || r.error || 'Unknown error'}`
      )
    })
  }

  // Compare gas estimates if available (show briefly, don't clutter output)
  const gasEstimates = results
    .map((r) => ({
      method: r.method,
      gas: r.gasEstimate || (r as ITenderlySimulationResult).gasUsed,
      type: r.gasEstimate ? 'estimate' : 'used',
    }))
    .filter((g) => g.gas !== undefined)

  if (gasEstimates.length > 1) {
    consola.debug('\nGas Estimates Comparison:')
    gasEstimates.forEach((g) => {
      const typeLabel = g.type === 'estimate' ? '(estimate)' : '(actual used)'
      consola.debug(`  ${g.method}: ${g.gas?.toString()} ${typeLabel}`)
    })
  }

  consola.log('')
}

/**
 * Main CLI command
 */
const main = defineCommand({
  meta: {
    name: 'simulate-calldata',
    description:
      'Simulate calldata execution using multiple methods (Viem, Foundry, Tenderly)',
  },
  args: {
    calldata: {
      type: 'string',
      description: 'The calldata to simulate (hex string starting with 0x)',
      required: true,
    },
    target: {
      type: 'string',
      description: 'The target contract address',
      required: true,
    },
    network: {
      type: 'string',
      description: 'The network name (e.g., arbitrum, mainnet, base)',
      required: true,
    },
    value: {
      type: 'string',
      description: 'Value to send with the transaction (in wei)',
      default: '0',
    },
    from: {
      type: 'string',
      description: 'From address (required for proper simulation)',
      required: true,
    },
    methods: {
      type: 'string',
      description:
        'Comma-separated list of methods to use: viem,foundry,tenderly,all',
      default: 'all',
    },
    blockNumber: {
      type: 'string',
      description: 'Optional block number to simulate at (defaults to latest)',
    },
    traceDetail: {
      type: 'string',
      description: 'Trace detail level: basic, detailed (default: detailed)',
      default: 'detailed',
    },
  },
  async run({ args }) {
    const calldata = args.calldata as string
    const target = args.target as string
    const network = args.network as string
    const value = (args.value as string) || '0'
    const from = args.from as string
    const methods = (args.methods as string) || 'all'
    const blockNumberStr = args.blockNumber as string | undefined
    // Handle empty string as undefined (when BLOCK_NUMBER="" is passed from shell)
    let blockNumber: bigint | undefined
    if (blockNumberStr && blockNumberStr.trim() !== '') {
      try {
        blockNumber = BigInt(blockNumberStr.trim())
        if (blockNumber < 0n) {
          consola.error('Block number must be non-negative')
          process.exit(1)
        }
      } catch (error) {
        consola.error(
          `Invalid block number: ${blockNumberStr}. Must be a valid integer.`
        )
        process.exit(1)
      }
    }
    const traceDetail = (
      (args.traceDetail as string) || 'detailed'
    ).toLowerCase()
    const detailedTrace = traceDetail === 'detailed'

    // Validate inputs
    if (
      !calldata ||
      typeof calldata !== 'string' ||
      !calldata.startsWith('0x')
    ) {
      consola.error('Invalid calldata. Must be a hex string starting with 0x')
      process.exit(1)
    }

    if (!target || !isAddress(target)) {
      consola.error('Invalid target address')
      process.exit(1)
    }

    if (!from || !isAddress(from)) {
      consola.error('Invalid from address. --from parameter is required')
      process.exit(1)
    }

    const calldataHex = calldata as Hex
    const targetAddress = getAddress(target)
    const fromAddress = getAddress(from)
    const valueBigInt = BigInt(value || '0')

    // Determine which methods to use
    const methodsList =
      methods === 'all'
        ? ['viem', 'foundry', 'tenderly']
        : (methods as string).split(',').map((m) => m.trim().toLowerCase())

    // Print simulation parameters once at the start
    consola.info(`[${network}] Simulating calldata`)
    consola.info(`[${network}] Target: ${targetAddress}`)
    consola.info(`[${network}] From: ${fromAddress}`)
    if (valueBigInt > 0n) {
      consola.info(
        `[${network}] Value: ${valueBigInt.toString()} wei (${formatEther(
          valueBigInt
        )} ETH)`
      )
    }
    if (blockNumber) {
      consola.info(`[${network}] Block Number: ${blockNumber.toString()}`)
    }
    consola.info(`[${network}] Methods: ${methodsList.join(', ')}`)
    consola.info(
      `[${network}] Calldata: ${calldataHex.substring(0, 66)}... (${
        calldataHex.length
      } chars)`
    )

    // Get network configuration
    let chainId: number
    let publicClient: PublicClient

    try {
      const chain = getViemChainForNetworkName(network)
      chainId = chain.id
      publicClient = createPublicClient({
        chain,
        transport: http(),
      })
    } catch (error) {
      consola.error(`[${network}] Failed to get network configuration:`, error)
      process.exit(1)
    }

    // Run simulations
    const results: ISimulationResult[] = []

    // Viem simulation
    if (methodsList.includes('viem')) {
      consola.start(`[${network}] Running Viem simulation...`)
      try {
        const result = await simulateWithViem(
          publicClient,
          targetAddress,
          calldataHex,
          valueBigInt,
          fromAddress,
          blockNumber,
          detailedTrace
        )
        results.push(result)
        if (result.success) {
          consola.success(`[${network}] Viem simulation completed`)
        } else {
          consola.warn(`[${network}] Viem simulation failed`)
        }
      } catch (error) {
        consola.error(`[${network}] Viem simulation error:`, error)
        results.push({
          method: 'viem',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Foundry simulation
    if (methodsList.includes('foundry')) {
      consola.start(`[${network}] Running Foundry simulation...`)
      try {
        const result = await simulateWithFoundry(
          network,
          targetAddress,
          calldataHex,
          valueBigInt,
          fromAddress,
          blockNumber
        )
        results.push(result)
        if (result.success) {
          consola.success(`[${network}] Foundry simulation completed`)
        } else {
          consola.warn(`[${network}] Foundry simulation failed`)
        }
      } catch (error) {
        consola.error(`[${network}] Foundry simulation error:`, error)
        results.push({
          method: 'foundry',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Tenderly simulation
    if (methodsList.includes('tenderly')) {
      consola.start(`[${network}] Running Tenderly simulation...`)
      try {
        const result = await simulateWithTenderly(
          network,
          chainId,
          targetAddress,
          calldataHex,
          valueBigInt,
          fromAddress,
          blockNumber
        )
        results.push(result)
        if (result.success) {
          consola.success(`[${network}] Tenderly simulation completed`)
        } else {
          consola.warn(`[${network}] Tenderly simulation failed`)
        }
      } catch (error) {
        consola.error(`[${network}] Tenderly simulation error:`, error)
        results.push({
          method: 'tenderly',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Display results
    displayResults(results, targetAddress, network)

    // Exit with error code if all simulations failed
    const allFailed = results.every((r) => !r.success)
    if (allFailed) {
      consola.error(`[${network}] All simulation methods failed`)
      process.exit(1)
    }

    // Exit with warning if some failed
    const someFailed = results.some((r) => !r.success)
    if (someFailed) {
      consola.warn(`[${network}] Some simulation methods failed`)
      process.exit(0)
    }
  },
})

runMain(main)
