/**
 * Gate W: refuses to sign a registration of a diamond-called periphery contract
 * whose selectors will not be on the diamond's allowlist once the proposal runs.
 *
 * Import this from `confirm-safe-tx.ts`, which evaluates it per proposal and
 * skips a proposal it does not clear; `confirm-check-registry.ts` maps the
 * verdict onto the run's ledger.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import {
  decodeFunctionData,
  getAddress,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import {
  assertScopeContractsEligible,
  isNetworkInScope,
  type WhitelistNetworkScope,
} from '../../common/whitelistScope'
import {
  carriesAnySelectorAligned,
  collectLeafCalls,
  diamondCutCallsIn,
  DIAMOND_CUT_SELECTOR,
  MAX_UNWRAP_DEPTH,
} from '../shared/diamond-cut-calls'

import { asPrintable, printableField } from './printable-field'

/**
 * The heading this gate prints under. Declared here because the registry
 * imports this module.
 */
export const PERIPHERY_ALLOWLIST_GATE_HEADING =
  'Gate W · Registered periphery allowlist'

/** What a refused registration needs, before the network-specific command. */
export const PERIPHERY_ALLOWLIST_REMEDY =
  'propose the whitelist sync with, or before, this registration'

/**
 * The remedy for a refused registration on `network`.
 *
 * Tron gets the standalone sync, because the paired proposer refuses Tron
 * networks: there the allowlist has to be synced and executed first.
 *
 * @param network - The network the registration is proposed on.
 * @returns The remedy sentence, naming the command to run.
 */
export const peripheryAllowlistRemedy = (network: string): string =>
  isTronNetworkKey(network)
    ? `sync the whitelist first — ./script/tasks/syncWhitelistToNetworks.sh ${network} --production — and propose this registration once that sync has executed`
    : `${PERIPHERY_ALLOWLIST_REMEDY} — bunx tsx script/tasks/proposePeripheryWithWhitelist.ts --contract <name> --networks ${network} proposes both in one batch`

const GATE_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
  'function setContractSelectorWhitelist(address,bytes4,bool)',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const REGISTER_SELECTOR = toFunctionSelector(
  'registerPeripheryContract(string,address)'
).toLowerCase()
const SET_SELECTOR = toFunctionSelector(
  'setContractSelectorWhitelist(address,bytes4,bool)'
).toLowerCase()
const BATCH_SET_SELECTOR = toFunctionSelector(
  'batchSetContractSelectorWhitelist(address[],bytes4[],bool)'
).toLowerCase()
const WHITELIST_SELECTORS: readonly Hex[] = [
  SET_SELECTOR as Hex,
  BATCH_SET_SELECTOR as Hex,
]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * - `allowlisted`: the chain already holds every selector, and the batch removes none.
 * - `paired`: the batch's own whitelist calls supply at least one selector, and
 *   with the chain they cover all of them.
 * - `missing`: at least one selector is absent once the batch has run.
 * - `read-failed`: the allowlist could not be read, so nothing was compared.
 * - `not-diamond-called`: the name is not in `whitelistPeripheryFunctions`.
 * - `out-of-scope`: `whitelistPeripheryNetworks` does not whitelist the name
 *   on this network, so the diamond is not meant to call it here.
 * - `deregistration`: the name is bound to the zero address, which calls nothing.
 */
export type PeripheryAllowlistStatus =
  | 'allowlisted'
  | 'paired'
  | 'missing'
  | 'read-failed'
  | 'not-diamond-called'
  | 'out-of-scope'
  | 'deregistration'

/**
 * The statuses a proposal may be signed with. Named by what may proceed, so a
 * status added to the union above blocks until someone lists it here.
 */
export const STATUSES_CLEARED: ReadonlySet<PeripheryAllowlistStatus> = new Set([
  'allowlisted',
  'paired',
  'not-diamond-called',
  'out-of-scope',
  'deregistration',
])

/** One `registerPeripheryContract` the proposal reaches, graded. */
export interface IPeripheryAllowlistFinding {
  /** Where in the proposal it was found, e.g. `call[0][1].diamondCut._init.registerPeripheryContract`. */
  path: string
  name: string
  address: Address
  /** The diamond the registration is sent to, when it could be named. */
  diamond?: Address
  status: PeripheryAllowlistStatus
  /** Selectors `whitelistPeripheryFunctions` lists for `name`, lowercased. */
  expected: readonly Hex[]
  /** The signatures for `expected`, in the same order. */
  signatures: readonly string[]
  /** What the chain reported before the batch runs; absent when it was not read. */
  observed?: readonly Hex[]
  /** Selectors in `expected` absent once the batch has run. */
  missing: readonly Hex[]
  /** Why nothing was compared, for `read-failed`. */
  reason?: string
}

/** Gate W's answer for one proposal. */
export interface IPeripheryAllowlistVerdict {
  /** The network the proposal is on, as `config/networks.json` names it. */
  network: string
  findings: IPeripheryAllowlistFinding[]
  /**
   * Calls that could be carrying a registration or a whitelist change this
   * could not read. Any entry blocks: a registration nobody read is one nobody
   * graded.
   */
  unreadable: string[]
  cleared: boolean
}

/** One configured function of a diamond-called periphery contract. */
export interface IPeripheryFunction {
  selector: Hex
  signature: string
}

/** The configuration and chain reader gate W grades against. */
export interface IPeripheryAllowlistDeps {
  /** `whitelistPeripheryFunctions`, keyed by the exact registry name. */
  peripheryFunctions: ReadonlyMap<string, readonly IPeripheryFunction[]>
  /** `whitelistPeripheryNetworks`, from {@link peripheryNetworksFromConfig}. */
  peripheryNetworks: WhitelistNetworkScope
  /** `getWhitelistedSelectorsForContract(contract)` on `diamond`. */
  readWhitelistedSelectors: (
    diamond: Address,
    contract: Address
  ) => Promise<readonly Hex[]>
}

const ALLOWLIST_READ_ABI = parseAbi([
  'function getWhitelistedSelectorsForContract(address) view returns (bytes4[])',
])

/**
 * The allowlist reader `confirm-safe-tx.ts` hands the gate.
 *
 * Takes a client factory rather than a client so a proposal that registers
 * nothing never builds one: building needs the network's RPC variable, and the
 * gate must not refuse a proposal it has nothing to read for.
 *
 * @param client - Builds the read-only client on first use.
 * @returns A reader for `IPeripheryAllowlistDeps`.
 */
export const readAllowlistThrough = (
  client: () => Pick<PublicClient, 'readContract'>
): IPeripheryAllowlistDeps['readWhitelistedSelectors'] => {
  let built: Pick<PublicClient, 'readContract'> | undefined
  return async (diamond, contract) => {
    built ??= client()
    return built.readContract({
      address: diamond,
      abi: ALLOWLIST_READ_ABI,
      functionName: 'getWhitelistedSelectorsForContract',
      args: [contract],
    })
  }
}

/** The proposal gate W grades. */
export interface IPeripheryAllowlistInput {
  /** The network the proposal is on, as `config/networks.json` names it. */
  network: string
  /** The proposal's top-level calls. */
  calldatas: readonly Hex[]
  /** Where each top-level call is sent, by index. */
  targets: readonly Address[]
  /** The Safe that sends the top-level calls. */
  caller: Address
}

/**
 * Reads `config/global.json` `whitelistPeripheryFunctions` into a lookup.
 *
 * A `Map`, because the key is a registry name taken from calldata: a plain
 * object would answer for `constructor` and `toString`. A name listing no
 * selector would clear every registration of it vacuously, so it throws.
 *
 * @param config - The `whitelistPeripheryFunctions` value.
 * @returns Name → configured functions, selectors lowercased.
 * @throws When the value is not the shape `global.json` carries.
 */
export const peripheryFunctionsFromConfig = (
  config: unknown
): ReadonlyMap<string, readonly IPeripheryFunction[]> => {
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error('whitelistPeripheryFunctions is not an object')

  const functions = new Map<string, readonly IPeripheryFunction[]>()
  for (const [name, entries] of Object.entries(config)) {
    if (!Array.isArray(entries) || entries.length === 0)
      throw new Error(
        `whitelistPeripheryFunctions.${name} lists no function, so nothing could be required of it`
      )
    functions.set(
      name,
      entries.map((entry: unknown) => {
        const { selector, signature } = (entry ?? {}) as Record<string, unknown>
        if (
          typeof selector !== 'string' ||
          !/^0x[0-9a-fA-F]{8}$/u.test(selector) ||
          typeof signature !== 'string'
        )
          throw new Error(
            `whitelistPeripheryFunctions.${name} has an entry without a four-byte selector and a signature`
          )
        return { selector: selector.toLowerCase() as Hex, signature }
      })
    )
  }
  return functions
}

/**
 * Reads `config/global.json` `whitelistPeripheryNetworks`.
 *
 * Fails closed on a name `whitelistPeripheryFunctions` lacks, because
 * `isNetworkInScope` reads an unmatched name as unscoped.
 *
 * @param config - The `whitelistPeripheryNetworks` value; absent is no scoping.
 * @param functions - From {@link peripheryFunctionsFromConfig}.
 * @returns The scope map, on a null prototype.
 * @throws When the value is not name → network list, or names an ineligible contract.
 */
export const peripheryNetworksFromConfig = (
  config: unknown,
  functions: ReadonlyMap<string, readonly IPeripheryFunction[]>
): WhitelistNetworkScope => {
  if (config === undefined) return Object.create(null) as WhitelistNetworkScope
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error('whitelistPeripheryNetworks is not an object')

  const scope = Object.create(null) as WhitelistNetworkScope
  for (const [name, networks] of Object.entries(config)) {
    if (
      !Array.isArray(networks) ||
      !networks.every((network) => typeof network === 'string')
    )
      throw new Error(
        `whitelistPeripheryNetworks.${name} is not a list of network names`
      )
    scope[name] = networks
  }
  assertScopeContractsEligible(scope, functions.keys())
  return scope
}

interface IRegistration {
  path: string
  name: string
  address: Address
  diamond?: Address
}

const pairKey = (diamond: Address, contract: Address, selector: string) =>
  `${diamond.toLowerCase()}|${contract.toLowerCase()}|${selector.toLowerCase()}`

/**
 * Grades every periphery registration a proposal reaches.
 *
 * Reads through the timelock envelopes `collectLeafCalls` knows. A leaf it does
 * not open, and an envelope it could not open, are scanned for the
 * registration selector on a byte boundary, because the envelope list is a
 * snapshot and a registration inside an unknown wrapper would otherwise pass
 * ungraded. A `diamondCut`'s `_init` calldata is read as a call on the
 * diamond; only its `FacetCut[]` is exempt from the scan.
 *
 * The batch's own whitelist calls are applied over the chain's answer in
 * calldata order, the order the timelock executes them in, so a batch that
 * removes a selector the chain holds is refused as well as one that adds too
 * few.
 *
 * @param input - The proposal's calls and where each is sent.
 * @param deps - The configured functions and the allowlist reader.
 * @returns The verdict; `cleared` is false for any missing selector, failed
 * read or unreadable call.
 */
export const evaluatePeripheryAllowlist = async (
  input: IPeripheryAllowlistInput,
  deps: IPeripheryAllowlistDeps
): Promise<IPeripheryAllowlistVerdict> => {
  const walked = collectLeafCalls(input.calldatas, {
    targets: input.targets,
    caller: input.caller,
  })

  const registrations: IRegistration[] = []
  const unreadable: string[] = []
  // Final state of each (diamond, contract, selector) pair the batch writes.
  const batchWrites = new Map<string, boolean>()
  const whitelistUnreadable: string[] = []
  const ordinals = new Map<number, number>()

  const scanUnopened = (data: Hex, where: string) => {
    if (carriesAnySelectorAligned(data, [REGISTER_SELECTOR as Hex]))
      unreadable.push(
        `${where} (carries a registerPeripheryContract selector inside a call this does not open, or by coincidence in its arguments)`
      )
    else if (carriesAnySelectorAligned(data, WHITELIST_SELECTORS))
      whitelistUnreadable.push(
        `${where} (carries a whitelist selector inside a call this does not open)`
      )
  }

  const examine = (
    data: Hex,
    target: Address | undefined,
    callIndex: number,
    where: string,
    path: string,
    initDepth: number
  ): void => {
    const selector = data.slice(0, 10).toLowerCase()

    if (selector === REGISTER_SELECTOR) {
      try {
        const { args } = decodeFunctionData({ abi: GATE_ABI, data })
        const [name, address] = args as readonly [string, Address]
        registrations.push({
          path: `${path}.registerPeripheryContract`,
          name,
          address: getAddress(address),
          ...(target ? { diamond: getAddress(target) } : {}),
        })
      } catch {
        unreadable.push(
          `${where} (a registerPeripheryContract whose arguments do not decode)`
        )
      }
      return
    }

    if (selector === SET_SELECTOR || selector === BATCH_SET_SELECTOR) {
      try {
        if (!target) throw new Error('no target')
        const diamond = getAddress(target)
        const decoded = decodeFunctionData({ abi: GATE_ABI, data })
        if (decoded.functionName === 'setContractSelectorWhitelist') {
          const [contract, selector, on] = decoded.args
          batchWrites.set(pairKey(diamond, contract, selector), on)
        } else if (
          decoded.functionName === 'batchSetContractSelectorWhitelist'
        ) {
          const [contracts, selectors, on] = decoded.args
          if (contracts.length !== selectors.length)
            throw new Error('length mismatch')
          contracts.forEach((contract, at) =>
            batchWrites.set(
              pairKey(diamond, contract, selectors[at] as string),
              on
            )
          )
        }
      } catch {
        whitelistUnreadable.push(
          `${where} (a whitelist change that could not be read)`
        )
      }
      return
    }

    if (selector === DIAMOND_CUT_SELECTOR) {
      // Only the FacetCut[] is exempt from the scan: installing
      // `PeripheryRegistryFacet` lists the registration selector there. The
      // diamond delegatecalls `_init` with `_calldata` in its own storage, so
      // that runs as a call on the diamond and is read like one.
      const [cut] = diamondCutCallsIn({
        leaves: [{ callIndex, data, selector, depth: 0 }],
        undecodable: [],
      }).calls
      if (!cut) {
        scanUnopened(data, `${where}, a diamondCut that does not decode,`)
        return
      }
      if (cut.init.toLowerCase() === ZERO_ADDRESS) return
      if (initDepth >= MAX_UNWRAP_DEPTH) {
        scanUnopened(
          cut.initCalldata,
          `${where} diamondCut _init, nested too deep,`
        )
        return
      }
      examine(
        cut.initCalldata,
        target,
        callIndex,
        `${where} diamondCut _init`,
        `${path}.diamondCut._init`,
        initDepth + 1
      )
      return
    }

    scanUnopened(data, where)
  }

  for (const leaf of walked.leaves) {
    const ordinal = ordinals.get(leaf.callIndex) ?? 0
    ordinals.set(leaf.callIndex, ordinal + 1)
    examine(
      leaf.data,
      leaf.target,
      leaf.callIndex,
      `call[${leaf.callIndex}] leaf ${ordinal}`,
      `call[${leaf.callIndex}][${ordinal}]`,
      0
    )
  }

  for (const index of walked.undecodable) {
    const data = input.calldatas[index]
    if (data === undefined) continue
    scanUnopened(data, `call[${index}], an envelope that could not be opened,`)
  }

  const findings: IPeripheryAllowlistFinding[] = []
  for (const registration of registrations)
    findings.push(await grade(registration, input.network, batchWrites, deps))

  // A whitelist change nobody read could be the removal that empties the
  // allowlist, so it matters exactly when there is a registration to grade.
  if (findings.some((finding) => finding.expected.length > 0))
    unreadable.push(...whitelistUnreadable)

  return {
    network: input.network,
    findings,
    unreadable,
    cleared:
      unreadable.length === 0 &&
      findings.every((finding) => STATUSES_CLEARED.has(finding.status)),
  }
}

const grade = async (
  registration: IRegistration,
  network: string,
  batchWrites: ReadonlyMap<string, boolean>,
  deps: IPeripheryAllowlistDeps
): Promise<IPeripheryAllowlistFinding> => {
  const base = {
    path: registration.path,
    name: registration.name,
    address: registration.address,
    ...(registration.diamond ? { diamond: registration.diamond } : {}),
  }

  const configured = deps.peripheryFunctions.get(registration.name)
  if (!configured)
    return {
      ...base,
      status: 'not-diamond-called',
      expected: [],
      signatures: [],
      missing: [],
    }

  if (!isNetworkInScope(registration.name, network, deps.peripheryNetworks))
    return {
      ...base,
      status: 'out-of-scope',
      expected: [],
      signatures: [],
      missing: [],
    }

  const expected = configured.map((one) => one.selector)
  const signatures = configured.map((one) => one.signature)

  if (registration.address.toLowerCase() === ZERO_ADDRESS)
    return {
      ...base,
      status: 'deregistration',
      expected,
      signatures,
      missing: [],
    }

  const { diamond } = registration
  if (!diamond)
    return {
      ...base,
      status: 'read-failed',
      expected,
      signatures,
      missing: expected,
      reason: 'the diamond this registration is sent to could not be named',
    }

  const written = expected.map((selector) =>
    batchWrites.get(pairKey(diamond, registration.address, selector))
  )
  if (written.every((value) => value === true))
    return { ...base, status: 'paired', expected, signatures, missing: [] }

  let observed: readonly Hex[]
  try {
    observed = (
      await deps.readWhitelistedSelectors(diamond, registration.address)
    ).map((selector) => selector.toLowerCase() as Hex)
  } catch (error) {
    return {
      ...base,
      status: 'read-failed',
      expected,
      signatures,
      missing: expected,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  const held = new Set(observed)
  const missing = expected.filter(
    (selector, at) => !(written[at] ?? held.has(selector))
  )
  return {
    ...base,
    status:
      missing.length > 0
        ? 'missing'
        : written.some((value) => value === true)
        ? 'paired'
        : 'allowlisted',
    expected,
    signatures,
    observed,
    missing,
  }
}

/**
 * A blocking verdict for an evaluation that threw. No verdict is not a pass.
 *
 * @param network - The network the proposal is on.
 * @param reason - What went wrong, shown to the signer.
 * @returns A verdict that is not cleared.
 */
export const blockedPeripheryAllowlist = (
  network: string,
  reason: string
): IPeripheryAllowlistVerdict => ({
  network,
  findings: [],
  unreadable: [`the gate could not be evaluated: ${ledgerPrintable(reason)}`],
  cleared: false,
})

/**
 * `<selector> <signature>` for each expected selector.
 *
 * @param finding - A graded registration.
 * @returns The expected selectors, labelled.
 */
export const describeExpected = (finding: IPeripheryAllowlistFinding): string =>
  finding.expected
    .map((selector, at) => `${selector} ${finding.signatures[at] ?? ''}`.trim())
    .join(', ')

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')

/**
 * A proposer- or machine-supplied value for a ledger row.
 *
 * The ledger renderer strips control characters, which would leave a notice's
 * colour codes behind as literal text, so the notice is carried as plain words.
 *
 * @param value - The value to print.
 * @returns The printable text, with any notice in parentheses after it.
 */
export const ledgerPrintable = (value: unknown): string => {
  const { text, notice } = asPrintable(value)
  return notice === '' ? text : `${text} (${notice.replace(SGR, '').trim()})`
}

/**
 * What the chain held, as the signer reads it after "observed".
 *
 * @param finding - A graded registration.
 * @param printable - How a stored or reported value is made printable; the
 * ledger passes {@link ledgerPrintable}.
 * @returns `none`, the selectors, or why nothing was read.
 */
export const describeObserved = (
  finding: IPeripheryAllowlistFinding,
  printable: (value: unknown) => string = printableField
): string => {
  if (finding.status === 'paired' && finding.observed === undefined)
    return 'not read; this batch allowlists every selector itself'
  if (finding.observed === undefined)
    return `not read: ${
      finding.reason === undefined
        ? 'no read was made'
        : printable(finding.reason)
    }`
  return finding.observed.length === 0 ? 'none' : finding.observed.join(', ')
}

/**
 * The per-registration lines printed under gate W's row in zone 2.
 *
 * @param verdict - The gate's verdict.
 * @returns Nothing for a proposal that registers nothing and hides nothing.
 */
export const renderPeripheryAllowlistLines = (
  verdict: IPeripheryAllowlistVerdict
): string[] => {
  if (verdict.findings.length === 0 && verdict.unreadable.length === 0)
    return []

  const lines = [`${PERIPHERY_ALLOWLIST_GATE_HEADING}:`]
  for (const finding of verdict.findings) {
    const head = `  ${printableField(finding.name)} → ${finding.address}`
    if (finding.status === 'out-of-scope') {
      lines.push(
        `${head}: not whitelisted on ${verdict.network} by config, so the diamond does not call it here`
      )
      continue
    }
    if (finding.status === 'not-diamond-called') {
      lines.push(
        `${head}: not in whitelistPeripheryFunctions, so the diamond does not call it`
      )
      continue
    }
    if (finding.status === 'deregistration') {
      lines.push(
        `${head}: bound to the zero address, which the diamond cannot call`
      )
      continue
    }
    lines.push(
      `${head}: ${STATUSES_CLEARED.has(finding.status) ? '✓' : '✗'} ${
        finding.status
      }`,
      `    expected ${describeExpected(finding)} allowlisted for ${
        finding.address
      }`,
      `    observed ${describeObserved(finding)}`
    )
    if (finding.status === 'missing')
      lines.push(`    remedy: ${peripheryAllowlistRemedy(verdict.network)}`)
  }
  for (const entry of verdict.unreadable) lines.push(`  ✗ unreadable: ${entry}`)
  return lines
}

/**
 * The refusal printed when the signer picks an action on a proposal gate W did
 * not clear. The findings are already under the row, so this points at them.
 *
 * @param verdict - The gate's verdict.
 * @returns The refusal block.
 */
export const renderPeripheryAllowlistRefusal = (
  verdict: IPeripheryAllowlistVerdict
): string[] => {
  const refusing =
    verdict.findings.filter((finding) => !STATUSES_CLEARED.has(finding.status))
      .length + verdict.unreadable.length
  const rule = '='.repeat(80)
  return [
    '',
    rule,
    `✗  ${PERIPHERY_ALLOWLIST_GATE_HEADING} — refused, NOT SIGNING OR EXECUTING`,
    `   ${refusing} finding${
      refusing === 1 ? '' : 's'
    } listed under "2 · WHAT WAS CHECKED FOR YOU" above; this proposal is skipped.`,
    rule,
    '',
  ]
}
