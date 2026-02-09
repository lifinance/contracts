/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 * Shared by confirm-safe-tx.ts and execute-pending-timelock-tx.ts.
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import type { Abi, Address, Hex } from 'viem'
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  toFunctionSelector,
} from 'viem'

import networksData from '../../../config/networks.json'
import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { buildExplorerContractPageUrl } from '../../utils/viemScriptHelpers'

import { decodeDiamondCut } from './safe-utils'

export interface IFormatDecodedTxContext {
  chainId: number
  network: string
}

export interface IWhitelistContractSelectorMeta {
  contractLabel?: string
  signature?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let whitelistCache: unknown | undefined
function getWhitelistJson(): unknown {
  if (whitelistCache) return whitelistCache
  const whitelistPath = path.join(process.cwd(), 'config', 'whitelist.json')
  const raw = fs.readFileSync(whitelistPath, 'utf8')
  whitelistCache = JSON.parse(raw)
  return whitelistCache
}

function safeNormalizeAddress(address: string): string {
  try {
    return getAddress(address as Address).toLowerCase()
  } catch {
    return address.toLowerCase()
  }
}

function computeSelectorFromSignature(signature: string): string {
  const hash = keccak256(stringToHex(signature))
  return `0x${hash.slice(2, 10)}`
}

function lookupWhitelistMetaForContractSelector(
  network: string,
  contractAddress: string,
  selector: string
): IWhitelistContractSelectorMeta {
  const whitelist = getWhitelistJson()
  if (!isRecord(whitelist)) return {}

  const networkKey = network.toLowerCase()
  const addr = safeNormalizeAddress(contractAddress)
  const sel = selector.toLowerCase()

  const peripheryRoot = whitelist['PERIPHERY']
  if (isRecord(peripheryRoot)) {
    const peripheryNetwork = peripheryRoot[networkKey]
    if (Array.isArray(peripheryNetwork)) {
      const entry = peripheryNetwork.find((e) => {
        if (!isRecord(e)) return false
        const address = typeof e.address === 'string' ? e.address : ''
        return safeNormalizeAddress(address) === addr
      })
      if (isRecord(entry)) {
        const entryName =
          typeof entry.name === 'string' ? entry.name : undefined
        const selectorsArr = entry.selectors
        let signature: string | undefined
        if (Array.isArray(selectorsArr)) {
          const selectorEntry = selectorsArr.find((s) => {
            if (!isRecord(s)) return false
            const sSel = typeof s.selector === 'string' ? s.selector : ''
            return sSel.toLowerCase() === sel
          })
          if (isRecord(selectorEntry)) {
            const sig = selectorEntry.signature
            if (typeof sig === 'string') signature = sig
          }
        }
        return {
          contractLabel: entryName ? `PERIPHERY/${entryName}` : 'PERIPHERY',
          signature: signature ? String(signature) : undefined,
        }
      }
    }
  }

  for (const [sectionKey, sectionVal] of Object.entries(whitelist)) {
    if (!Array.isArray(sectionVal)) continue
    for (const item of sectionVal) {
      if (!isRecord(item)) continue
      const contracts = item.contracts
      if (!isRecord(contracts)) continue
      const contractsByNetwork = contracts[networkKey]
      if (!Array.isArray(contractsByNetwork)) continue
      const contractEntry = contractsByNetwork.find((c) => {
        if (!isRecord(c)) return false
        const address = typeof c.address === 'string' ? c.address : ''
        return safeNormalizeAddress(address) === addr
      })
      if (!isRecord(contractEntry)) continue
      let signature: string | undefined
      const functions = contractEntry.functions
      if (isRecord(functions)) {
        const sig = functions[sel]
        if (typeof sig === 'string') signature = sig
      }
      const itemName = typeof item.name === 'string' ? item.name : undefined
      return {
        contractLabel: itemName ? `${sectionKey}/${itemName}` : sectionKey,
        signature: signature ? String(signature) : undefined,
      }
    }
  }
  return {}
}

export async function getTargetName(
  address: Address,
  network: string
): Promise<string> {
  try {
    const normalizedAddress = getAddress(address).toLowerCase()
    const networkKey = network.toLowerCase() as SupportedChain
    const networkConfig = networksData[networkKey as keyof typeof networksData]
    if (networkConfig?.safeAddress) {
      const safeAddress = getAddress(networkConfig.safeAddress).toLowerCase()
      if (safeAddress === normalizedAddress) return '(Multisig Safe)'
    }
    try {
      const deploymentsUnknown = await getDeployments(
        networkKey,
        EnvironmentEnum.production
      )
      const deployments =
        isRecord(deploymentsUnknown) && isRecord(deploymentsUnknown.default)
          ? (deploymentsUnknown.default as Record<string, unknown>)
          : (deploymentsUnknown as unknown)
      if (isRecord(deployments)) {
        const diamond = deployments.LiFiDiamond
        if (typeof diamond === 'string' && diamond.startsWith('0x')) {
          try {
            const diamondAddress = getAddress(diamond as Address).toLowerCase()
            if (diamondAddress === normalizedAddress) return '(LiFiDiamond)'
          } catch {
            // ignore
          }
        }
        const timelock = deployments.LiFiTimelockController
        if (typeof timelock === 'string' && timelock.startsWith('0x')) {
          try {
            const timelockAddress = getAddress(
              timelock as Address
            ).toLowerCase()
            if (timelockAddress === normalizedAddress)
              return '(LiFiTimelockController)'
          } catch {
            // ignore
          }
        }
        for (const [name, value] of Object.entries(deployments)) {
          if (typeof value !== 'string' || !value.startsWith('0x')) continue
          try {
            const addr = getAddress(value as Address).toLowerCase()
            if (addr === normalizedAddress) return `(${name})`
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // deployments might not exist
    }
  } catch {
    // ignore
  }
  return ''
}

async function getDeploymentsRecord(
  network: string
): Promise<Record<string, unknown> | undefined> {
  const networkKey = network.toLowerCase() as SupportedChain
  try {
    const deploymentsUnknown = await getDeployments(
      networkKey,
      EnvironmentEnum.production
    )
    const deployments =
      isRecord(deploymentsUnknown) && isRecord(deploymentsUnknown.default)
        ? deploymentsUnknown.default
        : deploymentsUnknown
    if (!isRecord(deployments)) return undefined
    return deployments
  } catch {
    return undefined
  }
}

async function getTargetSuffix(
  network: string,
  address: string
): Promise<string> {
  const name = await getTargetName(address as Address, network)
  const explorerUrl = buildExplorerContractPageUrl(network, address)
  const namePart = name ? ` \u001b[33m${name}\u001b[0m` : ''
  const explorerPart = explorerUrl ? ` \u001b[36m${explorerUrl}\u001b[0m` : ''
  return `${namePart}${explorerPart}`
}

async function getPeripheryDeploymentCheckSuffix(
  network: string,
  peripheryName: string,
  peripheryAddress: string
): Promise<string> {
  let providedAddress: Address
  try {
    providedAddress = getAddress(peripheryAddress as Address)
  } catch {
    return ` \u001b[31m(❌ invalid periphery address)\u001b[0m`
  }
  const deployments = await getDeploymentsRecord(network)
  if (!deployments) return ` \u001b[90m(deployments unavailable)\u001b[0m`
  const expectedRaw = deployments[peripheryName]
  if (typeof expectedRaw !== 'string' || !expectedRaw)
    return ` \u001b[90m(no deployments entry for '${peripheryName}')\u001b[0m`
  let expectedAddress: Address
  try {
    expectedAddress = getAddress(expectedRaw as Address)
  } catch {
    return ` \u001b[31m(❌ invalid deployments address for '${peripheryName}')\u001b[0m`
  }
  if (expectedAddress.toLowerCase() === providedAddress.toLowerCase())
    return ` \u001b[32m(✅ matches deployments)\u001b[0m`
  return ` \u001b[31m(❌ mismatch: expected ${expectedAddress})\u001b[0m`
}

async function formatDiamondCutSummary(
  diamondCutArgs: readonly unknown[],
  network: string
): Promise<void> {
  if (!diamondCutArgs || diamondCutArgs.length < 1) return
  const facetCutsUnknown = diamondCutArgs[0]
  if (!Array.isArray(facetCutsUnknown)) return
  consola.info('\u001b[35mDiamondCut summary:\u001b[0m')
  for (const cut of facetCutsUnknown) {
    let facetAddress: string | undefined
    let action: number | undefined
    let selectorsCount: number | undefined
    if (Array.isArray(cut)) {
      facetAddress = typeof cut[0] === 'string' ? cut[0] : undefined
      const a = cut[1]
      if (typeof a === 'number') action = a
      else if (typeof a === 'bigint') action = Number(a)
      const selectors = cut[2]
      if (Array.isArray(selectors)) selectorsCount = selectors.length
    } else if (isRecord(cut)) {
      const fa =
        typeof cut.facetAddress === 'string'
          ? cut.facetAddress
          : typeof cut[0] === 'string'
          ? (cut[0] as string)
          : undefined
      facetAddress = fa
      const a = cut.action ?? cut[1]
      if (typeof a === 'number') action = a
      else if (typeof a === 'bigint') action = Number(a)
      const selectors = cut.functionSelectors ?? cut[2]
      if (Array.isArray(selectors)) selectorsCount = selectors.length
    }
    if (!facetAddress || typeof facetAddress !== 'string') continue
    const actionLabel =
      action === 0
        ? 'ADD'
        : action === 1
        ? 'REPLACE'
        : action === 2
        ? 'REMOVE'
        : 'UNKNOWN'
    const selectorInfo =
      typeof selectorsCount === 'number' ? ` selectors=${selectorsCount}` : ''
    const suffix = await getTargetSuffix(network, facetAddress)
    consola.info(
      `  - ${actionLabel}: \u001b[32m${facetAddress}\u001b[0m${suffix}${selectorInfo}`
    )
  }
}

function formatBatchSetContractSelectorWhitelist(
  args: readonly unknown[],
  network?: string
): void {
  if (!args || args.length < 3) {
    consola.warn('Invalid arguments for batchSetContractSelectorWhitelist')
    return
  }
  const contracts = args[0] as readonly string[]
  const selectors = args[1] as readonly string[]
  const whitelisted = args[2] as boolean
  if (contracts.length !== selectors.length) {
    consola.warn(
      `Mismatch: contracts array length (${contracts.length}) != selectors array length (${selectors.length})`
    )
    return
  }
  const contractToSelectors = new Map<string, string[]>()
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i]?.toLowerCase()
    const selector = selectors[i]
    if (!contract || !selector) continue
    if (!contractToSelectors.has(contract))
      contractToSelectors.set(contract, [])
    const selectorList = contractToSelectors.get(contract)
    if (selectorList) selectorList.push(selector)
  }
  const actionText = whitelisted ? 'Adding pairs' : 'Removing pairs'
  const actionColor = whitelisted ? '\u001b[32m' : '\u001b[33m'
  consola.info(`Action: ${actionColor}${actionText}\u001b[0m`)
  consola.info(`Total pairs: ${contracts.length}`)
  consola.info('Pairs:')
  contractToSelectors.forEach((selectorList, contract) => {
    const originalContract =
      contracts.find((c) => c.toLowerCase() === contract) || contract
    let contractLabel = ''
    if (network) {
      const meta = lookupWhitelistMetaForContractSelector(
        network,
        originalContract,
        selectorList[0] ?? ''
      )
      if (meta.contractLabel)
        contractLabel = ` \u001b[35m(${meta.contractLabel})\u001b[0m`
    }
    let contractLine = `  Contract: \u001b[34m${originalContract}\u001b[0m${contractLabel}`
    if (network) {
      const explorerUrl = buildExplorerContractPageUrl(
        network,
        originalContract
      )
      if (explorerUrl) contractLine += ` \u001b[36m${explorerUrl}\u001b[0m`
    }
    consola.info(contractLine)
    consola.info('    Selectors:')
    selectorList.forEach((selector) => {
      if (!network) {
        consola.info(`      - \u001b[33m${selector}\u001b[0m`)
        return
      }
      const meta = lookupWhitelistMetaForContractSelector(
        network,
        originalContract,
        selector
      )
      const signature = meta.signature?.trim()
      if (!signature) {
        consola.info(
          `      - \u001b[33m${selector}\u001b[0m \u001b[90m(signature unknown in whitelist)\u001b[0m`
        )
        return
      }
      const expected = computeSelectorFromSignature(signature)
      const ok = expected.toLowerCase() === selector.toLowerCase()
      const status = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
      const mismatch = ok ? '' : ` \u001b[31m(expected ${expected})\u001b[0m`
      consola.info(
        `      - \u001b[33m${selector}\u001b[0m \u001b[36m${signature}\u001b[0m ${status}${mismatch}`
      )
    })
  })
}

let diamondAbiCache: Abi | undefined
function getDiamondAbi(): Abi | undefined {
  if (diamondAbiCache !== undefined) return diamondAbiCache
  try {
    const diamondPath = path.join(process.cwd(), 'diamond.json')
    if (!fs.existsSync(diamondPath)) return undefined
    const raw = fs.readFileSync(diamondPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    diamondAbiCache = Array.isArray(parsed) ? (parsed as Abi) : undefined
    return diamondAbiCache
  } catch {
    return undefined
  }
}

/**
 * Resolves a function selector to the matching ABI item from diamond.json (Diamond ABI).
 * Used to decode payloads dynamically instead of hardcoding selectors.
 */
function getDiamondAbiItemForSelector(selector: string): Abi[number] | null {
  const abi = getDiamondAbi()
  if (!abi) return null
  const normalizedSelector = selector.toLowerCase()
  for (const item of abi) {
    if (item.type !== 'function') continue
    try {
      const itemSelector = toFunctionSelector(item).toLowerCase()
      if (itemSelector === normalizedSelector) return item
    } catch {
      continue
    }
  }
  return null
}

function formatDecodedArg(arg: unknown): string {
  if (arg === undefined || arg === null) return String(arg)
  if (typeof arg === 'bigint') return arg.toString()
  if (typeof arg === 'object') return JSON.stringify(arg)
  return String(arg)
}

/**
 * pretty-format for a Diamond call payload using the Diamond ABI.
 * Resolves selector via diamond.json and decodes
 */
function tryFormatDiamondPayload(payload: Hex): string | undefined {
  if (!payload || payload === '0x') return undefined
  const selector = payload.slice(0, 10).toLowerCase()
  const abiItem = getDiamondAbiItemForSelector(selector)
  if (!abiItem || abiItem.type !== 'function') return undefined
  const name = abiItem.name
  try {
    const decoded = decodeFunctionData({
      abi: [abiItem],
      data: payload,
    })
    if (!decoded.args || decoded.args.length === 0) return `${name}()`
    const inputs =
      'inputs' in abiItem && Array.isArray(abiItem.inputs) ? abiItem.inputs : []
    const parts = decoded.args.map((arg: unknown, i: number) => {
      const paramName =
        (inputs[i] && typeof inputs[i] === 'object' && 'name' in inputs[i]
          ? (inputs[i] as { name: string }).name
          : undefined) ?? `arg${i}`
      return `${paramName}=${formatDecodedArg(arg)}`
    })
    return `${name}(${parts.join(', ')})`
  } catch {
    return `${name}(<failed to decode>)`
  }
}

async function formatTimelockScheduleBatch(
  args: readonly unknown[],
  network: string
): Promise<void> {
  if (!args || args.length < 6) {
    consola.warn('Invalid arguments for timelock scheduleBatch')
    return
  }
  const targets = args[0] as readonly string[]
  const values = args[1] as readonly unknown[]
  const payloads = args[2] as readonly string[]
  const predecessor = args[3]
  const salt = args[4]
  const delay = args[5]
  if (
    !Array.isArray(targets) ||
    !Array.isArray(values) ||
    !Array.isArray(payloads)
  ) {
    consola.warn(
      'Invalid scheduleBatch arg types (expected targets/values/payloads arrays)'
    )
    return
  }
  const n = Math.max(targets.length, values.length, payloads.length)
  const mismatch =
    targets.length === values.length && values.length === payloads.length
      ? ''
      : ` \u001b[31m(length mismatch: targets=${targets.length}, values=${values.length}, payloads=${payloads.length})\u001b[0m`
  consola.info('Timelock ScheduleBatch Details:')
  consola.info('-'.repeat(80))
  consola.info(`Operations:  \u001b[32m${n}\u001b[0m${mismatch}`)
  consola.info(`Predecessor: \u001b[32m${String(predecessor)}\u001b[0m`)
  consola.info(`Salt:        \u001b[32m${String(salt)}\u001b[0m`)
  consola.info(`Delay:       \u001b[32m${String(delay)}\u001b[0m seconds`)
  consola.info('-'.repeat(80))
  for (let i = 0; i < n; i++) {
    const target = targets[i]
    const value = values[i]
    const payload = payloads[i]
    const idx = String(i).padStart(2, '0')
    const targetDisplay = String(target ?? '')
    let targetNameSuffix = ''
    if (typeof target === 'string')
      targetNameSuffix = await getTargetSuffix(network, target)
    const valueStr =
      typeof value === 'bigint' ? value.toString() : String(value ?? '0')
    const payloadStr =
      typeof payload === 'string' ? (payload as Hex) : ('0x' as Hex)
    const pretty = tryFormatDiamondPayload(payloadStr)
    const selector =
      payloadStr && payloadStr !== '0x' ? payloadStr.slice(0, 10) : '0x'
    consola.info(
      `[${idx}] target=\u001b[32m${targetDisplay}\u001b[0m${targetNameSuffix}`
    )
    consola.info(`     value=\u001b[32m${valueStr}\u001b[0m`)
    consola.info(`     selector=\u001b[36m${selector}\u001b[0m`)
    if (pretty) consola.info(`     call=\u001b[34m${pretty}\u001b[0m`)
    else {
      const preview =
        payloadStr.length > 96 ? `${payloadStr.slice(0, 96)}…` : payloadStr
      consola.info(`     payload=\u001b[90m${preview}\u001b[0m`)
    }
  }
}

// Known ABIs for reliable decoding of common Safe/timelock calls
const ABI_DIAMOND_CUT = parseAbi([
  'function diamondCut((address,uint8,bytes4[])[],address,bytes)',
])
const ABI_SCHEDULE = parseAbi([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
])
const ABI_SCHEDULE_BATCH = parseAbi([
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
])
const ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST = parseAbi([
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])
const ABI_REGISTER_PERIPHERY_CONTRACT = parseAbi([
  'function registerPeripheryContract(string,address)',
])
const ABI_GRANT_ROLE = parseAbi(['function grantRole(bytes32,address)'])

// OpenZeppelin TimelockController / AccessControl role names (keccak256 of role string)
const KNOWN_ROLE_NAMES: Record<string, string> = {}
for (const name of [
  'TIMELOCK_ADMIN_ROLE',
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
]) {
  const hash = keccak256(stringToHex(name))
  KNOWN_ROLE_NAMES[hash.toLowerCase()] = name
}

function getRoleName(roleHash: string): string {
  const normalized = roleHash.startsWith('0x')
    ? roleHash.toLowerCase()
    : `0x${roleHash}`.toLowerCase()
  return KNOWN_ROLE_NAMES[normalized] ?? ''
}

/**
 * Decodes a transaction's function call using diamond ABI
 * @param data - Transaction data
 * @returns Decoded function name and data if available
 */
export async function decodeTransactionData(data: Hex): Promise<{
  functionName?: string
  decodedData?: unknown
}> {
  if (!data || data === '0x') return {}

  try {
    const selector = data.substring(0, 10)

    // First try to find function in diamond ABI
    try {
      const projectRoot = process.cwd()
      const diamondPath = path.join(projectRoot, 'diamond.json')

      if (fs.existsSync(diamondPath)) {
        const abiData = JSON.parse(fs.readFileSync(diamondPath, 'utf8'))
        if (Array.isArray(abiData))
          // Search for matching function selector in diamond ABI
          for (const abiItem of abiData)
            if (abiItem.type === 'function')
              try {
                const calculatedSelector = toFunctionSelector(abiItem)
                if (calculatedSelector === selector) {
                  consola.info(
                    `Using diamond ABI for function: ${abiItem.name}`
                  )
                  return {
                    functionName: abiItem.name,
                    decodedData: {
                      functionName: abiItem.name,
                      contractName: 'Diamond',
                    },
                  }
                }
              } catch (error) {
                // Skip invalid ABI items
                continue
              }
      }
    } catch (error) {
      consola.warn(`Error reading diamond ABI: ${error}`)
    }

    // Fallback to external API
    consola.info('No local ABI found, fetching from openchain.xyz...')
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`
    const response = await fetch(url)
    const responseData = await response.json()

    if (
      responseData.ok &&
      responseData.result &&
      responseData.result.function &&
      responseData.result.function[selector]
    ) {
      const functionName = responseData.result.function[selector][0].name

      try {
        const decodedData = {
          functionName,
          args: responseData.result.function[selector][0].args,
        }

        return {
          functionName,
          decodedData,
        }
      } catch (error) {
        consola.warn(`Could not decode function data: ${error}`)
        return { functionName }
      }
    }

    return {}
  } catch (error) {
    consola.warn(`Error decoding transaction data: ${error}`)
    return {}
  }
}

function getAbiForKnownFunction(functionName: string): Abi | null {
  const name = functionName.split('(')[0]?.trim() ?? functionName
  switch (name) {
    case 'diamondCut':
      return ABI_DIAMOND_CUT
    case 'schedule':
      return ABI_SCHEDULE
    case 'scheduleBatch':
      return ABI_SCHEDULE_BATCH
    case 'batchSetContractSelectorWhitelist':
      return ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST
    case 'registerPeripheryContract':
      return ABI_REGISTER_PERIPHERY_CONTRACT
    case 'grantRole':
      return ABI_GRANT_ROLE
    default:
      return null
  }
}

async function formatGrantRole(
  args: readonly unknown[],
  network: string
): Promise<void> {
  if (!args || args.length < 2) return
  const role = args[0]
  const account = args[1]
  const roleStr = typeof role === 'string' ? role : String(role ?? '')
  const accountStr =
    typeof account === 'string' ? account : String(account ?? '')
  const roleName = getRoleName(roleStr)
  const roleLabel = roleName ? ` \u001b[33m(${roleName})\u001b[0m` : ''
  consola.info(`Function: \u001b[34mgrantRole\u001b[0m`)
  consola.info(`  Role:   \u001b[32m${roleStr}\u001b[0m${roleLabel}`)
  const accountSuffix = await getTargetSuffix(network, accountStr)
  consola.info(`  Account: \u001b[32m${accountStr}\u001b[0m${accountSuffix}`)
}

/**
 * Decodes transaction data and prints a human-readable summary.
 * Used by execute-pending-timelock-tx and confirm-safe-tx.
 */
export async function formatDecodedTxDataForDisplay(
  data: Hex,
  context: IFormatDecodedTxContext
): Promise<void> {
  if (!data || data === '0x') {
    consola.info('Data: (empty)')
    return
  }

  const { chainId, network } = context

  try {
    const { functionName } = await decodeTransactionData(data)
    const knownAbi = functionName ? getAbiForKnownFunction(functionName) : null
    let decoded: { functionName: string; args?: readonly unknown[] } | null =
      null

    if (knownAbi) {
      try {
        decoded = decodeFunctionData({ abi: knownAbi, data })
      } catch {
        // fall through to generic
      }
    }
    if (!decoded && functionName) {
      try {
        // Dynamic signature from openchain; parseAbi may throw for invalid format
        const sig = `function ${functionName}`
        const abiInterface = parseAbi([sig] as [string])
        decoded = decodeFunctionData({ abi: abiInterface, data })
      } catch {
        // fall through
      }
    }

    if (decoded?.functionName === 'diamondCut' && decoded.args) {
      await formatDiamondCutSummary(decoded.args, network)
      await decodeDiamondCut(decoded, chainId, network)
      return
    }

    const scheduleArgs =
      decoded?.functionName === 'schedule' ? decoded.args : undefined
    if (scheduleArgs && scheduleArgs.length >= 6) {
      consola.info('Timelock Schedule Details:')
      consola.info('-'.repeat(80))
      const [target, value, innerData, predecessor, salt, delay] = scheduleArgs
      const targetName = await getTargetName(target as Address, network)
      const targetDisplay = targetName
        ? `${target} \u001b[33m${targetName}\u001b[0m`
        : target
      consola.info(`Target:      \u001b[32m${targetDisplay}\u001b[0m`)
      consola.info(`Value:       \u001b[32m${value}\u001b[0m`)
      consola.info(`Predecessor: \u001b[32m${predecessor}\u001b[0m`)
      consola.info(`Salt:        \u001b[32m${salt}\u001b[0m`)
      consola.info(`Delay:       \u001b[32m${delay}\u001b[0m seconds`)
      consola.info('-'.repeat(80))
      if (innerData && innerData !== '0x')
        await formatDecodedTxDataForDisplay(innerData as Hex, context)
      return
    }

    if (decoded?.functionName === 'scheduleBatch' && decoded.args) {
      await formatTimelockScheduleBatch(decoded.args, network)
      return
    }

    if (
      decoded?.functionName === 'batchSetContractSelectorWhitelist' &&
      decoded.args
    ) {
      formatBatchSetContractSelectorWhitelist(decoded.args, network)
      return
    }

    if (
      decoded?.functionName === 'registerPeripheryContract' &&
      decoded.args &&
      decoded.args.length >= 2
    ) {
      consola.info(`Function: \u001b[34m${decoded.functionName}\u001b[0m`)
      const peripheryName = String(decoded.args[0] ?? '')
      const peripheryAddress = String(decoded.args[1] ?? '')
      const deploymentSuffix = await getPeripheryDeploymentCheckSuffix(
        network,
        peripheryName,
        peripheryAddress
      )
      let peripheryLine = `Periphery Address: \u001b[34m${peripheryAddress}\u001b[0m`
      peripheryLine += await getTargetSuffix(network, peripheryAddress)
      peripheryLine += deploymentSuffix
      consola.info(peripheryLine)
      return
    }

    if (
      decoded?.functionName === 'grantRole' &&
      decoded.args &&
      decoded.args.length >= 2
    ) {
      await formatGrantRole(decoded.args, network)
      return
    }

    if (decoded?.functionName) {
      consola.info(`Function: \u001b[34m${decoded.functionName}\u001b[0m`)
      const args = decoded.args
      if (args && args.length > 0) {
        consola.info('Decoded Arguments:')
        args.forEach((arg: unknown, index: number) => {
          let displayValue: unknown = arg
          if (typeof arg === 'bigint') displayValue = arg.toString()
          else if (typeof arg === 'object' && arg !== null)
            displayValue = JSON.stringify(arg)
          consola.info(`  [${index}]: \u001b[33m${displayValue}\u001b[0m`)
        })
      } else {
        consola.info('No arguments or failed to decode arguments')
      }
      return
    }

    if (functionName) {
      consola.info(`Function: \u001b[34m${functionName}\u001b[0m`)
      return
    }

    const preview = data.length > 66 ? `${data.slice(0, 66)}…` : data
    consola.info(`Data (raw): \u001b[90m${preview}\u001b[0m`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    consola.warn(`Failed to decode data: ${msg}`)
    const preview = data.length > 66 ? `${data.slice(0, 66)}…` : data
    consola.info(`Data (raw): \u001b[90m${preview}\u001b[0m`)
  }
}
