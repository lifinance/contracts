/**
 * Safe Decode Utilities
 *
 * This module provides utilities for decoding Safe transaction data,
 * particularly for complex transactions like diamond cuts.
 * Shared by confirm-safe-tx.ts and execute-pending-timelock-tx.ts.
 */

import * as fs from 'fs'
import * as path from 'path'

import { formatAddressForNetworkCliDisplay } from '@lifi/tron-devkit'
import { consola } from 'consola'
import type { Abi, Address, Hex } from 'viem'
import {
  bytesToHex,
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
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'
import { buildExplorerContractPageUrl } from '../../utils/viemScriptHelpers'
import type {
  FacetCutActionEnum,
  IFacetCutEntry,
} from '../codehash/cut-classification'
import { tronHexSuffix } from '../tron/helpers/tronHexSuffix'

import {
  asPrintable,
  fieldNotice,
  MAX_FIELD_CHARS,
  printableField,
  UNBOUNDED,
} from './printable-field'
import { decodeDiamondCut } from './safe-utils'
import {
  getLocalSelectorInfo,
  resolveSelectorsViaFourByte,
} from './selector-registry'

export interface IFormatDecodedTxContext {
  chainId: number
  network: string
  /** When set, each line of decoded output is prefixed with this (e.g. under [00] in scheduleBatch). */
  indent?: string
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
    const normalizedAddress = normalizeAddressForNetwork(
      network,
      String(address)
    ).toLowerCase()
    const networkKey = network.toLowerCase() as SupportedChain
    const networkConfig = networksData[networkKey as keyof typeof networksData]
    if (networkConfig?.safeAddress) {
      const safeAddress = normalizeAddressForNetwork(
        network,
        networkConfig.safeAddress
      ).toLowerCase()
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
        if (typeof diamond === 'string') {
          if (
            normalizeAddressForNetwork(network, diamond).toLowerCase() ===
            normalizedAddress
          )
            return '(LiFiDiamond)'
        }
        const timelock = deployments.LiFiTimelockController
        if (typeof timelock === 'string') {
          if (
            normalizeAddressForNetwork(network, timelock).toLowerCase() ===
            normalizedAddress
          )
            return '(LiFiTimelockController)'
        }
        for (const [name, value] of Object.entries(deployments)) {
          if (typeof value !== 'string') continue
          if (
            normalizeAddressForNetwork(network, value).toLowerCase() ===
            normalizedAddress
          )
            return `(${name})`
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
  const displayAddr = formatAddressForNetworkCliDisplay(network, address)
  const explorerUrl = buildExplorerContractPageUrl(network, displayAddr)
  const namePart = name ? ` \u001b[33m${name}\u001b[0m` : ''
  const explorerPart = explorerUrl ? ` \u001b[36m${explorerUrl}\u001b[0m` : ''
  return `${namePart}${explorerPart}`
}

async function getPeripheryDeploymentCheckSuffix(
  network: string,
  storedName: string,
  printableName: string,
  peripheryAddress: string
): Promise<string> {
  let providedNormalized: Address
  try {
    providedNormalized = normalizeAddressForNetwork(
      network,
      peripheryAddress.trim()
    )
  } catch {
    return ` \u001b[31m(❌ invalid periphery address)\u001b[0m`
  }
  const deployments = await getDeploymentsRecord(network)
  if (!deployments) return ` \u001b[90m(deployments unavailable)\u001b[0m`
  const expectedRaw = deployments[storedName]
  if (typeof expectedRaw !== 'string' || !expectedRaw)
    return ` \u001b[90m(no deployments entry for '${printableName}')\u001b[0m`
  let expectedNormalized: Address
  try {
    expectedNormalized = normalizeAddressForNetwork(network, expectedRaw.trim())
  } catch {
    return ` \u001b[31m(❌ invalid deployments address for '${printableName}')\u001b[0m`
  }
  if (expectedNormalized.toLowerCase() === providedNormalized.toLowerCase())
    return ` \u001b[32m(✅ matches deployments)\u001b[0m`
  const expectedDisplay = formatAddressForNetworkCliDisplay(
    network,
    expectedNormalized
  )
  return ` \u001b[31m(❌ mismatch: expected ${expectedDisplay})\u001b[0m`
}

/**
 * Renders the contract/selector pairs of a `batchSetContractSelectorWhitelist`
 * call. Signatures are resolved per pair from `config/whitelist.json` first —
 * the only source that ties a signature to this contract on this network, and
 * so the only one that earns the ✓ — then from the shared selector registry,
 * then from the batched 4byte lookup. Without the latter two, a pair missing
 * from this network's whitelist entry leaves the signer eyeballing a raw
 * selector.
 */
export async function formatBatchSetContractSelectorWhitelist(
  args: readonly unknown[],
  network?: string,
  indent?: string
): Promise<void> {
  const pre = indent ?? ''
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
  // Case folding is only safe for hex addresses. Base58 is case-sensitive, so
  // folding a Tron address risks merging two distinct contracts into one group
  // and attributing the merged selectors to whichever address came first.
  const groupingKey = (address: string): string =>
    address.startsWith('0x') || address.startsWith('0X')
      ? address.toLowerCase()
      : address
  const contractToSelectors = new Map<string, string[]>()
  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i]
    const selector = selectors[i]
    if (!contract || !selector) continue
    const key = groupingKey(contract)
    if (!contractToSelectors.has(key)) contractToSelectors.set(key, [])
    const selectorList = contractToSelectors.get(key)
    if (selectorList) selectorList.push(selector)
  }

  // Every lookup and the rendering use the address as supplied, not the key.
  const rows = [...contractToSelectors.entries()].map(
    ([key, selectorList]) => ({
      contract: contracts.find((c) => groupingKey(c) === key) || key,
      selectorList,
    })
  )

  // One batched lookup for everything neither whitelist.json nor the local
  // registry can answer, so rendering below stays synchronous per selector.
  const fourByteSignatures = network
    ? await resolveSelectorsViaFourByte(
        rows.flatMap(({ contract, selectorList }) =>
          selectorList.filter(
            (selector) =>
              !lookupWhitelistMetaForContractSelector(
                network,
                contract,
                selector
              ).signature?.trim() && !getLocalSelectorInfo(selector)
          )
        )
      )
    : new Map<string, string>()

  const actionText = whitelisted ? 'Adding pairs' : 'Removing pairs'
  const actionColor = whitelisted ? '\u001b[32m' : '\u001b[33m'
  consola.info(`${pre}Action: ${actionColor}${actionText}\u001b[0m`)
  consola.info(`${pre}Total pairs: ${contracts.length}`)
  consola.info(`${pre}Pairs:`)
  rows.forEach(({ contract: originalContract, selectorList }) => {
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
    const displayContract = network
      ? formatAddressForNetworkCliDisplay(network, originalContract)
      : originalContract
    let contractLine = `  Contract: \u001b[34m${displayContract}\u001b[0m${contractLabel}`
    if (network) {
      const explorerUrl = buildExplorerContractPageUrl(network, displayContract)
      if (explorerUrl) contractLine += ` \u001b[36m${explorerUrl}\u001b[0m`
    }
    consola.info(`${pre}${contractLine}`)
    consola.info(`${pre}    Selectors:`)
    selectorList.forEach((selector) => {
      if (!network) {
        consola.info(`${pre}      - \u001b[33m${selector}\u001b[0m`)
        return
      }
      const meta = lookupWhitelistMetaForContractSelector(
        network,
        originalContract,
        selector
      )
      const signature = meta.signature?.trim()
      if (signature) {
        const expected = computeSelectorFromSignature(signature)
        const ok = expected.toLowerCase() === selector.toLowerCase()
        const status = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
        const mismatch = ok ? '' : ` \u001b[31m(expected ${expected})\u001b[0m`
        consola.info(
          `${pre}      - \u001b[33m${selector}\u001b[0m \u001b[36m${signature}\u001b[0m ${status}${mismatch}`
        )
        return
      }

      const local = getLocalSelectorInfo(selector)
      const fallbackSignature =
        local?.signature ?? fourByteSignatures.get(selector.toLowerCase())
      if (!fallbackSignature) {
        consola.info(
          `${pre}      - \u001b[33m${selector}\u001b[0m \u001b[90m(signature unknown)\u001b[0m`
        )
        return
      }
      // Sourced outside this network's whitelist entry, so the signature is
      // not evidence that this contract exposes it — label the origin rather
      // than showing the ✓ the whitelist path earns.
      const source = local?.source ?? '4byte.sourcify.dev'
      consola.info(
        `${pre}      - \u001b[33m${selector}\u001b[0m \u001b[36m${printableField(
          fallbackSignature
        )}\u001b[0m \u001b[90m(via ${source})\u001b[0m`
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

/** The shape a decoded argument has when it is a payload rather than a label. */
const HEX_PAYLOAD = /^0x[0-9a-fA-F]*$/u

/**
 * How long a decoded argument may be before it is clipped.
 *
 * A hex payload is what the signature covers, so its length is its own
 * disclosure and clipping it would hide the thing being approved — the same
 * reason the calldata field is unbounded. Anything else is a name or a label,
 * where a value past the bound is a terminal flood rather than information: a
 * 500,000-character periphery name pushed the target address and the
 * matches-deployments verdict off the screen entirely.
 * @param value - The decoded scalar, already stringified
 * @returns The code-point bound to render it under
 */
const scalarBound = (value: string): number =>
  HEX_PAYLOAD.test(value) ? UNBOUNDED : MAX_FIELD_CHARS

/**
 * One decoded scalar as printable text plus whatever that cost.
 *
 * A `string` ABI argument of a legitimately encoded call is arbitrary text the
 * proposer chose — `registerPeripheryContract(string,address)` decodes cleanly
 * with an ESC in its name — so it cannot reach the operator's terminal raw.
 * @param value - The decoded scalar
 * @param network - When set, an address is rendered in the network's format
 * @returns The text to print and the notice describing any repair
 */
function renderScalarArg(
  value: string,
  network?: string
): { text: string; notice: string } {
  if (
    network !== undefined &&
    value.startsWith('0x') &&
    /^0x[a-fA-F0-9]{40}$/.test(value)
  )
    return {
      text: `${formatAddressForNetworkCliDisplay(
        network,
        value
      )}${tronHexSuffix(network, value)}`,
      notice: '',
    }
  return asPrintable(value, scalarBound(value))
}

/**
 * Renders one decoded ABI argument for display.
 * @param arg - Decoded argument value (may be a bigint, tuple, or array).
 * @param network - When set, addresses are rendered in the network's format.
 * @returns Display string for the argument.
 */
export function formatDecodedArg(arg: unknown, network?: string): string {
  if (arg === undefined || arg === null) return String(arg)
  if (typeof arg === 'bigint') return arg.toString()
  // Tuple and array args (e.g. initFrax's (chainId, eid) pairs) carry nested
  // bigints, which plain JSON.stringify throws on — losing the whole decode and
  // leaving the operator approving a payload they were never shown. Nested
  // strings recurse so an address inside a tuple gets the same per-network
  // rendering as a top-level one instead of staying raw hex.
  if (typeof arg === 'object') {
    let repaired = false
    const json = JSON.stringify(arg, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'string') {
        const { text, notice } = renderScalarArg(value, network)
        if (notice) repaired = true
        return text
      }
      return value
    })
    // One notice after the JSON rather than per element: inside a JSON string
    // `JSON.stringify` escapes its colour codes into visible text and the
    // disclosure reads as part of the value.
    return repaired
      ? `${json}${fieldNotice(
          'a value inside this argument was sanitised or clipped for display'
        )}`
      : json
  }
  const { text, notice } = renderScalarArg(String(arg), network)
  return `${text}${notice}`
}

/**
 * pretty-format for a Diamond call payload using the Diamond ABI.
 * Resolves selector via diamond.json and decodes
 */
function tryFormatDiamondPayload(
  payload: Hex,
  network?: string
): string | undefined {
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
      const value = formatDecodedArg(arg, network)
      return `${paramName}=${value}`
    })
    return `${name}(${parts.join(', ')})`
  } catch {
    return `${name}(<failed to decode>)`
  }
}

/**
 * Formats timelock scheduleBatch args for display: for each call shows target, value, selector,
 * and when context is provided, fully decoded nested call (diamondCut with selector names,
 * registerPeripheryContract, grantRole, etc.). Otherwise falls back to a one-line summary or raw payload.
 * Exported for use by execute-pending-timelock-tx when displaying a batch operation.
 */
export async function formatTimelockScheduleBatch(
  args: readonly unknown[],
  network: string,
  context?: IFormatDecodedTxContext
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
  consola.info(`Predecessor: \u001b[32m${printableField(predecessor)}\u001b[0m`)
  consola.info(`Salt:        \u001b[32m${printableField(salt)}\u001b[0m`)
  consola.info(
    `Delay:       \u001b[32m${printableField(delay)}\u001b[0m seconds`
  )
  consola.info('-'.repeat(80))
  for (let i = 0; i < n; i++) {
    const target = targets[i]
    const value = values[i]
    const payload = payloads[i]
    const idx = String(i).padStart(2, '0')
    const targetRaw = String(target ?? '')
    // A target is either a valid address for this network or it is not. A valid
    // one cannot carry an escape, so it is formatted and keeps its name and
    // explorer link. An invalid one must not be sanitised into a different
    // address that still looks like one — the same mistake as keying a
    // deployments lookup on repaired text — so it is shown as stored, with a
    // notice and without a name or link: there is nothing left to vouch for,
    // and a link built from a non-address is worse than no link.
    let targetDisplay: string
    let targetNameSuffix = ''
    try {
      const normalisedTarget = normalizeAddressForNetwork(
        network,
        targetRaw.trim()
      )
      targetDisplay = formatAddressForNetworkCliDisplay(
        network,
        normalisedTarget
      )
      targetNameSuffix = await getTargetSuffix(network, normalisedTarget)
    } catch {
      targetDisplay = printableField(targetRaw)
      targetNameSuffix = fieldNotice(
        `not a valid address for ${network} — shown as stored, and no explorer link`
      )
    }
    const valueStr =
      typeof value === 'bigint'
        ? value.toString()
        : printableField(value ?? '0')
    const payloadStr =
      typeof payload === 'string' ? (payload as Hex) : ('0x' as Hex)
    const selector =
      payloadStr && payloadStr !== '0x' ? payloadStr.slice(0, 10) : '0x'
    consola.info(
      `[${idx}] target=\u001b[32m${targetDisplay}\u001b[0m${targetNameSuffix}`
    )
    consola.info(`     value=\u001b[32m${valueStr}\u001b[0m`)
    consola.info(`     selector=\u001b[36m${printableField(selector)}\u001b[0m`)
    if (context && payloadStr && payloadStr !== '0x') {
      consola.info('     Decoded call:')
      const nestedContext: IFormatDecodedTxContext = {
        ...context,
        indent: (context.indent ?? '') + '       ',
      }
      await formatDecodedTxDataForDisplay(payloadStr, nestedContext)
    } else {
      const pretty = tryFormatDiamondPayload(payloadStr, network)
      if (pretty) consola.info(`     call=\u001b[34m${pretty}\u001b[0m`)
      else {
        consola.info(
          `     payload=\u001b[90m${printableField(
            payloadStr,
            RAW_PAYLOAD_PREVIEW_CHARS
          )}\u001b[0m`
        )
      }
    }
  }
}

// Known ABIs for reliable decoding of common Safe/timelock calls
/** Shared `diamondCut` ABI — import from here; do not re-`parseAbi` the same signature elsewhere. */
export const ABI_DIAMOND_CUT = parseAbi([
  'function diamondCut((address,uint8,bytes4[])[],address,bytes)',
])
const ABI_SCHEDULE_BATCH = parseAbi([
  'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
])
const ABI_SCHEDULE_SINGLE = parseAbi([
  'function schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
])
const ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST = parseAbi([
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])
const ABI_REGISTER_PERIPHERY_CONTRACT = parseAbi([
  'function registerPeripheryContract(string,address)',
])
// grantRole / revokeRole / renounceRole share the (bytes32,address) shape
const ABI_ACCESS_CONTROL_ROLE = parseAbi([
  'function grantRole(bytes32,address)',
  'function revokeRole(bytes32,address)',
  'function renounceRole(bytes32,address)',
])
const ACCESS_CONTROL_ROLE_FUNCTIONS = new Set([
  'grantRole',
  'revokeRole',
  'renounceRole',
])

// OpenZeppelin TimelockController / AccessControl role names (keccak256 of role string)
const KNOWN_ROLE_NAMES: Record<string, string> = {
  // DEFAULT_ADMIN_ROLE is bytes32(0), not a keccak256 hash of its name
  [`0x${'00'.repeat(32)}`]: 'DEFAULT_ADMIN_ROLE',
}
for (const name of [
  'TIMELOCK_ADMIN_ROLE',
  'PROPOSER_ROLE',
  'EXECUTOR_ROLE',
  'CANCELLER_ROLE',
]) {
  const hash = keccak256(stringToHex(name))
  KNOWN_ROLE_NAMES[hash.toLowerCase()] = name
}

export function getRoleName(roleHash: string): string {
  const normalized = roleHash.startsWith('0x')
    ? roleHash.toLowerCase()
    : `0x${roleHash}`.toLowerCase()
  return KNOWN_ROLE_NAMES[normalized] ?? ''
}

/**
 * Decodes a transaction's function call using the local selector registry
 * (diamond.json, clearSigningProposal.json, whitelist.json, well-known
 * signatures), falling back to the disk-cached, batched 4byte lookup only for
 * selectors we don't ship ourselves.
 * @param data - Transaction data
 * @param options - Optional indent for log lines (e.g. when nested under scheduleBatch [00])
 * @returns Decoded function name and data if available
 */
export async function decodeTransactionData(
  data: Hex,
  options?: { indent?: string }
): Promise<{
  functionName?: string
  decodedData?: unknown
}> {
  if (!data || data === '0x') return {}
  const pre = options?.indent ?? ''

  try {
    const selector = data.substring(0, 10)

    const local = getLocalSelectorInfo(selector)
    if (local) {
      // Diamond hits keep the historical bare-name shape; other local sources
      // return the full signature so the generic decoder can also decode args.
      if (local.source === 'diamond.json') {
        consola.info(`${pre}Using diamond ABI for function: ${local.name}`)
        return {
          functionName: local.name,
          decodedData: {
            functionName: local.name,
            contractName: 'Diamond',
          },
        }
      }
      consola.info(
        `${pre}Using local ABI (${local.source}) for function: ${local.name}`
      )
      return {
        functionName: local.signature,
        decodedData: { functionName: local.signature },
      }
    }

    // Fallback: disk-cached, batched Sourcify 4byte lookup
    consola.info(
      `${pre}No local ABI found, resolving via 4byte.sourcify.dev (disk-cached)...`
    )
    const resolved = await resolveSelectorsViaFourByte([selector])
    const signature = resolved.get(selector)
    if (signature)
      return {
        functionName: signature,
        decodedData: { functionName: signature },
      }
    return {}
  } catch (error) {
    // `.message`, not the error: `asPrintable` reports an object as "stored as
    // an object, not a string", which is true of every `Error` and says nothing
    // about the row.
    consola.warn(
      `Error decoding transaction data: ${printableField(
        error instanceof Error ? error.message : error
      )}`
    )
    return {}
  }
}

function getAbiForKnownFunction(functionName: string): Abi | null {
  const name = functionName.split('(')[0]?.trim() ?? functionName
  switch (name) {
    case 'diamondCut':
      return ABI_DIAMOND_CUT
    case 'scheduleBatch':
      return ABI_SCHEDULE_BATCH
    case 'batchSetContractSelectorWhitelist':
      return ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST
    case 'registerPeripheryContract':
      return ABI_REGISTER_PERIPHERY_CONTRACT
    case 'grantRole':
    case 'revokeRole':
    case 'renounceRole':
      return ABI_ACCESS_CONTROL_ROLE
    default:
      return null
  }
}

export async function formatRoleChange(
  functionName: string,
  args: readonly unknown[],
  network: string,
  indent?: string
): Promise<void> {
  if (!args || args.length < 2) return
  const pre = indent ?? ''
  const role = args[0]
  const account = args[1]
  const roleStr = typeof role === 'string' ? role : String(role ?? '')
  const accountStr =
    typeof account === 'string' ? account : String(account ?? '')
  const roleName = getRoleName(roleStr)
  const roleLabel = roleName ? ` \u001b[33m(${roleName})\u001b[0m` : ''
  consola.info(
    `${pre}Function: \u001b[34m${printableField(functionName)}\u001b[0m`
  )
  consola.info(
    `${pre}  Role:   \u001b[32m${printableField(roleStr)}\u001b[0m${roleLabel}`
  )
  const accountDisplay = formatAddressForNetworkCliDisplay(network, accountStr)
  const accountSuffix = await getTargetSuffix(network, accountStr)
  consola.info(
    `${pre}  Account: \u001b[32m${accountDisplay}\u001b[0m${accountSuffix}`
  )
}

/** Code points of a nested raw payload shown when nothing decoded it. */
const RAW_PAYLOAD_PREVIEW_CHARS = 96
/** Code points of the raw `data` shown when nothing decoded it. */
const RAW_DATA_PREVIEW_CHARS = 66

/**
 * The stored calldata as a bounded, printable preview.
 *
 * `data` is typed `Hex` but reaches every caller through a cast off the stored
 * row, so it holds whatever the row holds — and this preview prints one screen
 * above the sanitised detail block, closer to the sign prompt than anything the
 * signer is told to check.
 * @param data - The calldata as stored
 * @returns The coloured preview, with any notice outside the colour
 */
const rawDataPreview = (data: unknown): string => {
  const { text, notice } = asPrintable(data, RAW_DATA_PREVIEW_CHARS)
  return `\u001b[90m${text}\u001b[0m${notice}`
}

/**
 * Decodes transaction data and prints a human-readable summary.
 * Used by execute-pending-timelock-tx and confirm-safe-tx.
 */
export async function formatDecodedTxDataForDisplay(
  data: Hex,
  context: IFormatDecodedTxContext
): Promise<void> {
  const pre = context.indent ?? ''
  const log = (msg: string) => consola.info(pre + msg)

  if (!data || data === '0x') {
    log('Data: (empty)')
    return
  }

  const { chainId, network } = context

  try {
    const { functionName } = await decodeTransactionData(data, {
      indent: context.indent,
    })
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
        // Dynamic signature from 4byte/Sourcify; parseAbi may throw for invalid format
        const sig = `function ${functionName}`
        const abiInterface = parseAbi([sig] as [string])
        decoded = decodeFunctionData({ abi: abiInterface, data })
      } catch {
        // fall through
      }
    }
    if (!decoded) {
      const abiItem = getDiamondAbiItemForSelector(data.slice(0, 10))
      if (abiItem?.type === 'function') {
        try {
          decoded = decodeFunctionData({ abi: [abiItem], data })
        } catch {
          // fall through
        }
      }
    }

    if (decoded?.functionName === 'diamondCut' && decoded.args) {
      await decodeDiamondCut(decoded, chainId, network, pre)
      // Decode init calldata when present (init address non-zero and calldata non-empty)
      const initAddress = decoded.args[1]
      const initCalldataRaw = decoded.args[2]
      const initCalldataHex: Hex =
        typeof initCalldataRaw === 'string'
          ? (initCalldataRaw as Hex)
          : initCalldataRaw instanceof Uint8Array
          ? bytesToHex(initCalldataRaw)
          : ('0x' as Hex)
      const hasInitCall =
        initAddress &&
        String(initAddress) !== '0x0000000000000000000000000000000000000000' &&
        initCalldataHex !== '0x' &&
        initCalldataHex.length >= 10
      if (hasInitCall) {
        log('Init call:')
        await formatDecodedTxDataForDisplay(initCalldataHex, {
          chainId,
          network,
          indent: pre + '  ',
        })
      }
      return
    }

    if (decoded?.functionName === 'scheduleBatch' && decoded.args) {
      await formatTimelockScheduleBatch(decoded.args, network, context)
      return
    }

    if (
      decoded?.functionName === 'batchSetContractSelectorWhitelist' &&
      decoded.args
    ) {
      await formatBatchSetContractSelectorWhitelist(decoded.args, network, pre)
      return
    }

    if (
      decoded?.functionName === 'registerPeripheryContract' &&
      decoded.args &&
      decoded.args.length >= 2
    ) {
      log(
        `Function: \u001b[34m${printableField(decoded.functionName)}\u001b[0m`
      )
      // The name is a `string` ABI argument, so a call that decodes cleanly
      // and is encoded exactly as this repository would encode it still
      // carries whatever text the proposer chose. Disclosed here rather than
      // cleaned by the caller, so the line that prints it is the line that
      // reports it.
      const storedPeripheryName = String(decoded.args[0] ?? '')
      // Bounded: a contract name is a label, and one long enough to scroll the
      // target address and the deployments verdict off the screen is a flood
      // rather than information. The lookup below still keys on the whole
      // stored value, so clipping the display cannot change the verdict.
      const { text: peripheryName, notice: peripheryNotice } = asPrintable(
        storedPeripheryName,
        MAX_FIELD_CHARS
      )
      const peripheryAddress = String(decoded.args[1] ?? '')
      log(
        `Periphery Name: \u001b[33m${peripheryName}\u001b[0m${peripheryNotice}`
      )
      // Keyed on the stored name, never the printable one. Sanitising can turn
      // a name the record does not hold into one it does — a zero-width space
      // inside it is simply removed — and the check would then print a ✅ about
      // a value the calldata does not contain. What is shown and what is
      // decided come off the same argument, but not off the same string.
      const deploymentSuffix = await getPeripheryDeploymentCheckSuffix(
        network,
        storedPeripheryName,
        peripheryName,
        peripheryAddress
      )
      const peripheryDisplay = formatAddressForNetworkCliDisplay(
        network,
        peripheryAddress
      )
      let peripheryLine = `Periphery Address: \u001b[34m${peripheryDisplay}\u001b[0m`
      peripheryLine += await getTargetSuffix(network, peripheryAddress)
      peripheryLine += deploymentSuffix
      log(peripheryLine)
      return
    }

    if (
      decoded?.functionName &&
      ACCESS_CONTROL_ROLE_FUNCTIONS.has(decoded.functionName) &&
      decoded.args &&
      decoded.args.length >= 2
    ) {
      await formatRoleChange(decoded.functionName, decoded.args, network, pre)
      return
    }

    if (decoded?.functionName) {
      log(
        `Function: \u001b[34m${printableField(decoded.functionName)}\u001b[0m`
      )
      const args = decoded.args
      if (args && args.length > 0) {
        const abiItem = getDiamondAbiItemForSelector(data.slice(0, 10))
        const inputs =
          abiItem?.type === 'function' &&
          'inputs' in abiItem &&
          Array.isArray(abiItem.inputs)
            ? abiItem.inputs
            : []
        log('Decoded Arguments:')
        args.forEach((arg: unknown, index: number) => {
          const input = inputs[index]
          const paramName =
            input && typeof input === 'object' && 'name' in input
              ? (input as { name: string }).name
              : undefined
          const label = paramName ? paramName : `[${index}]`
          log(
            `  ${label}: \u001b[33m${formatDecodedArg(arg, network)}\u001b[0m`
          )
        })
      } else {
        log('No arguments or failed to decode arguments')
      }
      return
    }

    if (functionName) {
      const pretty = tryFormatDiamondPayload(data, network)
      if (pretty) {
        log(`Call: \u001b[34m${pretty}\u001b[0m`)
        return
      }
      log(`Function: \u001b[34m${printableField(functionName)}\u001b[0m`)
      return
    }

    log(`Data (raw): ${rawDataPreview(data)}`)
  } catch (error) {
    // viem quotes its input back in the message, so the row's own bytes reach
    // this line even when nothing above printed them.
    log(
      `Failed to decode data: ${printableField(
        error instanceof Error ? error.message : error
      )}`
    )
    log(`Data (raw): ${rawDataPreview(data)}`)
  }
}

/** One `diamondCut` call recovered from a proposal's calldata. */
export interface IDiamondCutCall {
  cuts: IFacetCutEntry[]
  /** Checksummed `_init` target; the zero address when the cut sets none. */
  init: string
}

export interface ICollectedDiamondCuts {
  /** Every `diamondCut` found, in the order the calldata carries them. */
  calls: IDiamondCutCall[]
  /**
   * Reasons the calldata must not be signed whatever any codehash result says.
   * Populated when a cut is present in bytes this module cannot decode.
   */
  refusals: string[]
  /**
   * Selectors of frames this decoder could not open, whether or not they carried
   * the cut selector. Surfaced rather than discarded because "we did not read
   * these bytes" and "these bytes hold no cut" are different facts, and only the
   * second may be rendered as an affirmative pass.
   */
  unopened: string[]
}

const selectorOf = (abi: Abi): string =>
  toFunctionSelector(
    abi.find((item) => item.type === 'function') as Parameters<
      typeof toFunctionSelector
    >[0]
  )

const DIAMOND_CUT_SELECTOR = selectorOf(ABI_DIAMOND_CUT).toLowerCase()
const SCHEDULE_BATCH_SELECTOR = selectorOf(ABI_SCHEDULE_BATCH).toLowerCase()
const SCHEDULE_SINGLE_SELECTOR = selectorOf(ABI_SCHEDULE_SINGLE).toLowerCase()

/** Deep enough for the envelopes in use, shallow enough to bound the walk. */
const MAX_ENVELOPE_DEPTH = 4

/**
 * Selectors this module can decode on its own. Membership is what separates
 * "a call whose arguments happen to contain four bytes" from "an envelope we
 * cannot see inside".
 */
const DECODABLE_SELECTORS = new Set(
  (
    [
      ...ABI_DIAMOND_CUT,
      ...ABI_SCHEDULE_BATCH,
      ...ABI_SCHEDULE_SINGLE,
      ...ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST,
      ...ABI_REGISTER_PERIPHERY_CONTRACT,
      ...ABI_ACCESS_CONTROL_ROLE,
    ] as Abi
  )
    .filter((item) => item.type === 'function')
    .map((item) =>
      toFunctionSelector(
        item as Parameters<typeof toFunctionSelector>[0]
      ).toLowerCase()
    )
)

const asHex = (value: unknown): Hex =>
  typeof value === 'string'
    ? (value as Hex)
    : value instanceof Uint8Array
    ? bytesToHex(value)
    : ('0x' as Hex)

/**
 * @param entry - one decoded `FacetCut` tuple, as viem returns it
 */
const readCutEntry = (entry: unknown): IFacetCutEntry | undefined => {
  const tuple = Array.isArray(entry)
    ? entry
    : isRecord(entry)
    ? [entry.facetAddress, entry.action]
    : undefined
  if (!tuple) return undefined
  const [facetAddress, action] = tuple
  if (typeof facetAddress !== 'string') return undefined
  const numeric = typeof action === 'bigint' ? Number(action) : action
  if (typeof numeric !== 'number' || !Number.isInteger(numeric))
    return undefined
  let checksummed: string
  try {
    checksummed = getAddress(facetAddress)
  } catch {
    return undefined
  }
  // Cast rather than validated: `classifyCut` refuses an action outside the
  // enum, and swallowing it here would hand it a shorter list instead.
  return { facetAddress: checksummed, action: numeric as FacetCutActionEnum }
}

/**
 * Recovers every `diamondCut` a proposal's calldata would perform.
 *
 * The cut is decoded with {@link ABI_DIAMOND_CUT}, the same ABI the display path
 * renders from, so the structure vouched for and the structure shown are one
 * decode of one value. Pass one in-memory value and never a re-read of its
 * source: the calldata of the transaction that gets signed, which is the same
 * bytes the display decoded.
 *
 * Two properties keep it from reporting "no cut" about calldata that has one.
 *
 * The hex is lower-cased before anything looks at a selector. Upper-casing the
 * nibbles changes no byte, so the EIP-712 hash and the executed cut are
 * identical — but viem's selector match is case-sensitive, so a case-shifted
 * proposal would decode to nothing while installing exactly what the honest
 * form does.
 *
 * And every frame this decoder could not open is recorded, at any depth. The
 * wrapper list below is a snapshot; a cut one level inside something not on it
 * is refused rather than passed over, which is a statement about frames rather
 * than about the outer selector.
 *
 * @param data - the proposal's calldata, `0x`-prefixed
 * @returns The cuts found, and any reason the calldata must not be signed
 */
export const collectDiamondCutTargets = (
  data: Hex | undefined
): ICollectedDiamondCuts => {
  const calls: IDiamondCutCall[] = []
  if (!data || data === '0x') return { calls, refusals: [], unopened: [] }

  const hex = data.toLowerCase()
  if (!/^0x([0-9a-f]{2})*$/.test(hex))
    return {
      calls: [],
      unopened: [],
      refusals: [
        `This proposal's calldata is not well-formed hex (${
          data.length
        } characters starting ${data.slice(
          0,
          12
        )}), so it cannot be decoded or judged. A signature is refused rather than treating undecodable bytes as carrying no cut.`,
      ],
    }

  // Frames this decoder could not open, so the refusal below can say so.
  const unopened: string[] = []

  const walk = (payload: string, depth: number): void => {
    // An empty payload is a legitimate value-only entry in a batch, not a
    // frame that failed to open.
    if (payload === '0x' || payload === '') return
    if (payload.length < 10) {
      unopened.push(`a ${(payload.length - 2) / 2}-byte payload`)
      return
    }
    if (depth > MAX_ENVELOPE_DEPTH) {
      unopened.push(
        `${payload.slice(0, 10)} nested more than ${MAX_ENVELOPE_DEPTH} deep`
      )
      return
    }

    const selector = payload.slice(0, 10)
    const framed = payload as Hex

    if (selector === DIAMOND_CUT_SELECTOR) {
      let decoded
      try {
        decoded = decodeFunctionData({ abi: ABI_DIAMOND_CUT, data: framed })
      } catch (error) {
        unopened.push(`${selector} (${message(error)})`)
        return
      }
      const entries = Array.isArray(decoded.args?.[0]) ? decoded.args[0] : []
      const cuts = entries
        .map(readCutEntry)
        .filter((entry): entry is IFacetCutEntry => entry !== undefined)
      if (cuts.length !== entries.length) {
        unopened.push(`${selector} (a cut entry could not be read)`)
        return
      }
      const initRaw = decoded.args?.[1]
      let init: string
      try {
        init = getAddress(String(initRaw) as `0x${string}`)
      } catch {
        unopened.push(`${selector} (its _init target is not an address)`)
        return
      }
      calls.push({ cuts, init })
      return
    }

    if (selector === SCHEDULE_BATCH_SELECTOR) {
      let decoded
      try {
        decoded = decodeFunctionData({ abi: ABI_SCHEDULE_BATCH, data: framed })
      } catch (error) {
        unopened.push(`${selector} (${message(error)})`)
        return
      }
      const payloads = Array.isArray(decoded.args?.[2]) ? decoded.args[2] : []
      for (const nested of payloads)
        walk(asHex(nested).toLowerCase(), depth + 1)
      return
    }

    if (selector === SCHEDULE_SINGLE_SELECTOR) {
      let decoded
      try {
        decoded = decodeFunctionData({ abi: ABI_SCHEDULE_SINGLE, data: framed })
      } catch (error) {
        unopened.push(`${selector} (${message(error)})`)
        return
      }
      walk(asHex(decoded.args?.[2]).toLowerCase(), depth + 1)
      return
    }

    // Known and carrying no nested calldata: a role change, a whitelist entry,
    // a periphery registration. Its arguments may hold the four bytes of the
    // diamondCut selector without hiding a cut, which is why membership here
    // and not the byte scan decides.
    if (DECODABLE_SELECTORS.has(selector)) return

    unopened.push(selector)
  }

  walk(hex, 0)

  // Keyed on a frame that could not be opened, never on the outer selector: a
  // cut nested inside an unknown envelope beneath a `scheduleBatch` is the
  // shape an outer-selector test cannot see.
  const refusals =
    unopened.length > 0 && hex.includes(DIAMOND_CUT_SELECTOR.slice(2))
      ? [
          `This proposal's calldata carries the diamondCut selector ${DIAMOND_CUT_SELECTOR}, and this decoder could not open ${unopened.join(
            ', '
          )} — so a cut inside it can be neither shown nor checked. Signing is refused rather than treating an unreadable frame as carrying no cut.`,
        ]
      : []

  return { calls, refusals, unopened }
}

/**
 * @param error - whatever a decode threw
 */
const message = (error: unknown): string =>
  error instanceof Error
    ? error.message.split('\n')[0] ?? 'undecodable'
    : String(error)
