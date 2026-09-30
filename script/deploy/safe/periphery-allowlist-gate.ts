/**
 * Gate W: refuses to sign a registration of a diamond-called periphery contract
 * whose selectors will not be on the diamond's allowlist once the proposal runs.
 *
 * Import this from `confirm-safe-tx.ts`, which evaluates it per proposal and
 * skips a proposal it does not clear; `confirm-check-registry.ts` maps the
 * verdict onto the run's ledger.
 */

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
  carriesAnySelectorAligned,
  collectLeafCalls,
  DIAMOND_CUT_SELECTOR,
} from '../shared/diamond-cut-calls'

/**
 * The heading this gate prints under.
 *
 * Declared here rather than imported from the registry, which imports this
 * module; the tests hold it to `gateLabel(PERIPHERY_ALLOWLIST_CHECK)`.
 */
export const PERIPHERY_ALLOWLIST_GATE_HEADING =
  'Gate W · Registered periphery allowlist'

export const PERIPHERY_ALLOWLIST_REMEDY =
  'propose the whitelist sync with, or before, this registration'

const PAIRING_COMMAND =
  'bunx tsx script/tasks/proposePeripheryWithWhitelist.ts --contract <name> --networks <network>'

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
 * - `deregistration`: the name is bound to the zero address, which calls nothing.
 */
export type PeripheryAllowlistStatus =
  | 'allowlisted'
  | 'paired'
  | 'missing'
  | 'read-failed'
  | 'not-diamond-called'
  | 'deregistration'

/**
 * The statuses a proposal may be signed with. Named by what may proceed, so a
 * status added to the union above blocks until someone lists it here.
 */
export const STATUSES_CLEARED: ReadonlySet<PeripheryAllowlistStatus> = new Set([
  'allowlisted',
  'paired',
  'not-diamond-called',
  'deregistration',
])

/** One `registerPeripheryContract` the proposal reaches, graded. */
export interface IPeripheryAllowlistFinding {
  /** Where in the proposal it was found, e.g. `call[0].registerPeripheryContract[1]`. */
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

export interface IPeripheryAllowlistVerdict {
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

export interface IPeripheryAllowlistDeps {
  /** `whitelistPeripheryFunctions`, keyed by the exact registry name. */
  peripheryFunctions: ReadonlyMap<string, readonly IPeripheryFunction[]>
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

export interface IPeripheryAllowlistInput {
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
 * ungraded. A `diamondCut` is exempt from the scan: installing
 * `PeripheryRegistryFacet` lists this selector in its `bytes4[]`.
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

  for (const leaf of walked.leaves) {
    const ordinal = ordinals.get(leaf.callIndex) ?? 0
    ordinals.set(leaf.callIndex, ordinal + 1)
    const where = `call[${leaf.callIndex}] leaf ${ordinal}`

    if (leaf.selector === REGISTER_SELECTOR) {
      try {
        const { args } = decodeFunctionData({ abi: GATE_ABI, data: leaf.data })
        const [name, address] = args as readonly [string, Address]
        registrations.push({
          path: `call[${leaf.callIndex}].registerPeripheryContract[${ordinal}]`,
          name,
          address: getAddress(address),
          ...(leaf.target ? { diamond: getAddress(leaf.target) } : {}),
        })
      } catch {
        unreadable.push(
          `${where} (a registerPeripheryContract whose arguments do not decode)`
        )
      }
      continue
    }

    if (
      leaf.selector === SET_SELECTOR ||
      leaf.selector === BATCH_SET_SELECTOR
    ) {
      try {
        if (!leaf.target) throw new Error('no target')
        const diamond = getAddress(leaf.target)
        const decoded = decodeFunctionData({ abi: GATE_ABI, data: leaf.data })
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
      continue
    }

    if (leaf.selector === DIAMOND_CUT_SELECTOR.toLowerCase()) continue

    if (carriesAnySelectorAligned(leaf.data, [REGISTER_SELECTOR as Hex]))
      unreadable.push(
        `${where} (carries a registerPeripheryContract selector inside a call this does not open, or by coincidence in its arguments)`
      )
    else if (carriesAnySelectorAligned(leaf.data, WHITELIST_SELECTORS))
      whitelistUnreadable.push(
        `${where} (carries a whitelist selector inside a call this does not open)`
      )
  }

  for (const index of walked.undecodable) {
    const data = input.calldatas[index]
    if (data === undefined) continue
    if (carriesAnySelectorAligned(data, [REGISTER_SELECTOR as Hex]))
      unreadable.push(
        `call[${index}] (an envelope that could not be opened, carrying a registerPeripheryContract selector)`
      )
    else if (carriesAnySelectorAligned(data, WHITELIST_SELECTORS))
      whitelistUnreadable.push(
        `call[${index}] (an envelope that could not be opened, carrying a whitelist selector)`
      )
  }

  const findings: IPeripheryAllowlistFinding[] = []
  for (const registration of registrations)
    findings.push(await grade(registration, batchWrites, deps))

  // A whitelist change nobody read could be the removal that empties the
  // allowlist, so it matters exactly when there is a registration to grade.
  if (findings.some((finding) => finding.expected.length > 0))
    unreadable.push(...whitelistUnreadable)

  return {
    findings,
    unreadable,
    cleared:
      unreadable.length === 0 &&
      findings.every((finding) => STATUSES_CLEARED.has(finding.status)),
  }
}

const grade = async (
  registration: IRegistration,
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
 * @param reason - What went wrong, shown to the signer.
 * @returns A verdict that is not cleared.
 */
export const blockedPeripheryAllowlist = (
  reason: string
): IPeripheryAllowlistVerdict => ({
  findings: [],
  unreadable: [`the gate could not be evaluated: ${reason}`],
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

/**
 * What the chain held, as the signer reads it after "observed".
 *
 * @param finding - A graded registration.
 * @returns `none`, the selectors, or why nothing was read.
 */
export const describeObserved = (
  finding: IPeripheryAllowlistFinding
): string => {
  if (finding.status === 'paired' && finding.observed === undefined)
    return 'not read; this batch allowlists every selector itself'
  if (finding.observed === undefined)
    return `not read: ${finding.reason ?? 'no read was made'}`
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
    const head = `  ${finding.name} → ${finding.address}`
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
      lines.push(
        `    remedy: ${PERIPHERY_ALLOWLIST_REMEDY} — ${PAIRING_COMMAND} proposes both in one batch`
      )
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
