/**
 * Prices the bytes `compareToAttestedSet` had to mask, by reading each immutable
 * out of the deployed code and comparing it against the value this repo declares
 * for it.
 *
 * Import this behind layer 1. It reaches no codehash verdict and deliberately
 * returns no `ICodehashComparison`: layer 1 decides whether the code is ours,
 * this decides whether the bytes layer 1 could not look at hold the values the
 * registry declares. A layer returning both invites a caller to read one without
 * the other.
 *
 * The expectations come from `immutableRegistry.json`, `deployRequirements.json`
 * and `config/` — the side a proposer does not control — and from nowhere else.
 * Nothing here reads a chain, an explorer or a block. `forge verify-bytecode`
 * sources the same values from the explorer record or from the tail of the
 * onchain creation code, so every immutable it checks verifies against itself.
 *
 * A slot holds one left-padded value whatever the parameter that filled it was
 * declared as, so no constructor ABI, argument order or argument encoding enters
 * into it — which is also why a `bytes32` immutable holding an address needs no
 * handling of its own.
 */

import type { IImmutableDeclaration } from '../immutables/immutable-ast'
import type { DeployRequirements } from '../immutables/registry-schema'
import type { IDeployRequirementConfigData } from '../shared/immutableBindings'
import {
  loadConfigFileFromDisk,
  resolveExpectedAddress,
  substituteConfigKeyPlaceholders,
} from '../shared/immutableBindings'

import { frameFault, strip0x } from './hex'
import type { ImmutableReferences } from './immutable-offsets'
import { readImmutableCopies } from './immutable-offsets'

/**
 * One immutable as a deployment holds it, whatever platform it was read from.
 *
 * EVM and Tron inline immutables into runtime code, so `observeEvmImmutables`
 * builds these from `immutableReferences`; zkEVM keeps them in
 * `ImmutableSimulator`, so a zk caller builds them from `readZkImmutables`.
 * Pricing is the same question on both, and this is where the two meet.
 */
export interface IObservedImmutable {
  name: string
  /** The value the deployment holds, `0x`-prefixed. */
  value: string
  /**
   * Width of a single copy, as the **artifact** declares it. An expectation is
   * padded to this and never to the value's own length: a value of some other
   * width is a malformed observation, and padding to it would compare a
   * left-padded address against a shorter one and call the difference a
   * disagreement — or, on a wider one, against two slots concatenated.
   */
  slotByteCount: number
  /**
   * Bytes the deployment spends on it, counting every copy. Layer 1 masked
   * exactly these, so pricing them is what retires its `excludedByteCount`.
   */
  byteCount: number
}

/** What this layer could establish about one immutable. */
export type ImmutableStatus =
  | 'verified'
  | 'disagrees'
  | 'undeclared'
  | 'unpriceable'

export interface IGradedImmutable {
  name: string
  status: ImmutableStatus
  byteCount: number
  /** The value the deployment holds, `0x`-prefixed. */
  observed: string
  /** Present for `verified` and `disagrees`, padded to the slot width. */
  expected?: string
  /** `config/<file>` plus the key that answered, for a line a human reads. */
  origin?: string
  /** Why a slot could not be priced, in the registry's own words. */
  detail?: string
}

/**
 * Nothing about this contract's immutables could be established, so layer 1's
 * masked verdict stands exactly as it did before this layer ran.
 */
export interface IPricingRefused {
  decided: false
  reason: string
}

export interface IPricedImmutables {
  decided: true
  slots: readonly IGradedImmutable[]
  /** Slots holding something other than what the registry declares. Any is a block. */
  disagreements: readonly IGradedImmutable[]
  /** Bytes checked against a declared expectation and found to hold it. */
  pricedByteCount: number
  /**
   * Bytes with no expectation behind them: undeclared or unpriceable slots.
   */
  unpricedByteCount: number
  /**
   * Bytes of slots holding something other than what the registry declares.
   *
   * Its own counter because the three sum to what layer 1 masked, and folding it
   * into either of the others loses that: a tampered slot is neither priced nor
   * missing an expectation. Retiring layer 1's `excludedByteCount` needs this
   * and `unpricedByteCount` both at zero.
   */
  disagreeingByteCount: number
}

export type ImmutablePricing = IPricingRefused | IPricedImmutables

const refused = (reason: string): IPricingRefused => ({
  decided: false,
  reason,
})

/**
 * The declared address as one slot of `slotBytes` holds it.
 *
 * Left-padded, because that is how the EVM stores a narrow value in a wide slot
 * and how the deploy scripts widen one deliberately —
 * `DeployAcrossFacetV4.s.sol` passes `bytes32(uint256(uint160(addr)))`. Which is
 * why a `bytes32` immutable needs no separate handling here.
 *
 * The width is one copy's, not `IObservedImmutable.byteCount`: that counts every
 * copy, and padding to it would compare a 20-byte address against two slots
 * concatenated.
 *
 * Requires hex. `config/` also holds Tron addresses in base58 —
 * `networks.json` gives `.tron.wrappedNativeAddress` as
 * `TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR` — and padding one produces a value no
 * slot can hold, which would then read as the deployment disagreeing with
 * config on every Tron chain. An expectation that cannot be expressed in the
 * slot's encoding is not a mismatch, so this returns a fault and the caller
 * leaves the slot unpriced.
 *
 * @param address - Address as config writes it, checksummed or not.
 * @param slotBytes - Width of a single copy of the immutable.
 * @returns The padded value, or why the declared value cannot fill the slot.
 */
const paddedToSlot = (
  address: string,
  slotBytes: number
): { value: string } | { fault: string } => {
  const fault = frameFault(address, 'the declared value')
  if (fault)
    return {
      fault: `${fault} — a base58 Tron address cannot be compared against an inlined slot`,
    }

  const hex = strip0x(address).toLowerCase()
  if (hex.length / 2 > slotBytes)
    return {
      fault: `the declared value is ${
        hex.length / 2
      } bytes and does not fit a ${slotBytes}-byte slot`,
    }

  return { value: `0x${hex.padStart(slotBytes * 2, '0')}` }
}

/**
 * Reads every inlined immutable and names it, from the same artifact.
 *
 * Both inputs must come from **one** compilation. Foundry keys
 * `immutableReferences` by AST id, and an AST id identifies a declaration only
 * within the compilation that assigned it, so an id with no declaration means
 * the two inputs describe different builds — under which every other id may
 * name the wrong slot too. That refuses, rather than pricing the ids that
 * happened to line up.
 *
 * The declarations must be the ones the graded artifact's own AST carries. An
 * id is unique within one solc invocation, and `src/` compiles under a single
 * pragma today, so a repo-wide set drawn from one build happens to be unique
 * too — but that is a property of the current tree, not of the interface, and
 * the duplicate check below is what refuses if a second invocation ever reuses
 * an id.
 *
 * @param runtimeHex - Runtime bytecode found at the address, `0x`-prefixed.
 * @param refs - Foundry's `immutableReferences` for the artifact.
 * @param declarations - Immutables as the AST declares them, from the same build.
 * @returns One observation per inlined immutable, or why none can be reported.
 */
export const observeEvmImmutables = (
  runtimeHex: string,
  refs: ImmutableReferences | undefined,
  declarations: readonly IImmutableDeclaration[]
): { ok: true; observed: IObservedImmutable[] } | IPricingRefused => {
  const read = readImmutableCopies(runtimeHex, refs)
  if (!read.ok) return refused(read.reason)

  const nameByAstId = new Map<string, string>()
  for (const declaration of declarations) {
    if (declaration.astId === undefined) continue
    const astId = String(declaration.astId)
    const claimed = nameByAstId.get(astId)
    if (claimed !== undefined && claimed !== declaration.name)
      return refused(
        `astId ${astId} is claimed by both ${claimed} and ${declaration.contract}.${declaration.name}, so no slot it keys can be named unambiguously`
      )
    nameByAstId.set(astId, declaration.name)
  }

  const observed: IObservedImmutable[] = []
  for (const [astId, value] of Object.entries(read.values)) {
    const name = nameByAstId.get(astId)
    if (name === undefined)
      return refused(
        `astId ${astId} holds an immutable that the AST of this artifact does not declare, so the bytecode and the AST are from different compilations and no slot can be named`
      )

    // Every copy holds the same value, so the widths sum to what layer 1 masked
    // for this immutable, and any one of them is the slot width.
    const occurrences = refs?.[astId] ?? []
    const width = occurrences[0]?.length
    if (width === undefined)
      return refused(`astId ${astId} lists no occurrence to take a width from`)

    observed.push({
      name,
      value,
      slotByteCount: width,
      byteCount: occurrences.reduce((total, one) => total + one.length, 0),
    })
  }

  return { ok: true, observed }
}

/**
 * The expected value of one config-sourced immutable.
 *
 * @param label - The `configData` key the registry entry names.
 * @param configData - The contract's `configData` section.
 * @param network - Network the deployment lives on.
 * @param environment - `production` or `staging`.
 * @param loadConfigFile - Config loader, injectable for tests.
 * @returns The declared address and where it came from, or why it has none.
 */
const declaredAddress = (
  label: string,
  configData: Record<string, IDeployRequirementConfigData> | undefined,
  network: string,
  environment: string,
  loadConfigFile: (fileName: string) => unknown
): { address: string; origin: string } | { reason: string } => {
  const entry = Object.prototype.hasOwnProperty.call(configData ?? {}, label)
    ? configData?.[label]
    : undefined
  if (!entry)
    return {
      reason: `the registry points at configData key '${label}', which this contract does not have`,
    }

  // `resolveExpectedAddress` reads `keyInConfigFile.startsWith` before testing
  // it, so a `configData` entry missing the field throws out of here instead of
  // grading one slot — and `validateImmutableRegistry` checks only that the
  // label exists, never the shape of the entry it names.
  if (typeof entry.configFileName !== 'string' || entry.configFileName === '')
    return {
      reason: `configData key '${label}' names no config file`,
    }
  if (typeof entry.keyInConfigFile !== 'string' || entry.keyInConfigFile === '')
    return {
      reason: `configData key '${label}' names no key within config/${entry.configFileName}`,
    }

  const { keyUsed, expectedAddress } = resolveExpectedAddress(
    loadConfigFile(entry.configFileName),
    entry.keyInConfigFile,
    network,
    environment
  )
  const readableKey = substituteConfigKeyPlaceholders(
    keyUsed,
    network,
    environment
  )
  const origin = `config/${entry.configFileName}${readableKey}`

  if (expectedAddress === null)
    return { reason: `${origin} has no value for ${network}` }

  return { address: expectedAddress, origin }
}

/**
 * Grades every immutable a deployment holds against the registry's expectation.
 *
 * Each slot is answered on its own, so a contract whose one undeclared immutable
 * sits beside four declared ones still gets credit for the four. A slot the
 * registry declares as `config` is compared; one it declares `derived`,
 * `unchecked` or `unverifiable`, and one it does not declare at all, is reported
 * unpriced with its reason.
 *
 * @param input - The contract, its observed immutables, and the network to resolve for.
 * @param requirements - `deployRequirements.json` including its registry sections.
 * @param loadConfigFile - Config loader, injectable for tests.
 * @returns Every slot's grade and the byte counts, or why nothing could be graded.
 */
export const priceImmutables = (
  input: {
    contractName: string
    observed: readonly IObservedImmutable[]
    network: string
    environment: string
  },
  requirements: DeployRequirements,
  loadConfigFile: (fileName: string) => unknown = loadConfigFileFromDisk
): ImmutablePricing => {
  const { contractName, observed, network, environment } = input
  const contract = requirements[contractName]

  const slots: IGradedImmutable[] = []
  for (const one of observed) {
    // The observation is the caller's; a value that is not one slot wide means
    // the reader and the artifact disagree, and no slot of this contract can
    // then be trusted to be the one being compared.
    if (strip0x(one.value).length / 2 !== one.slotByteCount)
      return refused(
        `${contractName}.${one.name} was read as ${
          strip0x(one.value).length / 2
        } bytes but its artifact declares a ${one.slotByteCount}-byte slot`
      )

    const base = {
      name: one.name,
      byteCount: one.byteCount,
      observed: one.value.toLowerCase(),
    }
    // `in`/bracket access walks the prototype, so an immutable named `toString`
    // would find a function and route into the declared paths.
    const entry = Object.prototype.hasOwnProperty.call(
      contract?.immutables ?? {},
      one.name
    )
      ? contract?.immutables?.[one.name]
      : undefined

    if (!entry) {
      slots.push({
        ...base,
        status: 'undeclared',
        detail: `${contractName}.${one.name} has no registry entry, so this repo declares no expected value for it`,
      })
      continue
    }

    if (entry.source !== 'config') {
      const stated =
        typeof entry.rule === 'string' && entry.rule.trim() !== ''
          ? entry.rule
          : typeof entry.reason === 'string' && entry.reason.trim() !== ''
          ? entry.reason
          : 'the registry gives no rule or reason'
      slots.push({
        ...base,
        status: 'unpriceable',
        detail: `${contractName}.${one.name} is ${String(
          entry.source
        )}: ${stated}`,
      })
      continue
    }

    if (
      typeof entry.configData !== 'string' ||
      entry.configData.trim() === ''
    ) {
      slots.push({
        ...base,
        status: 'unpriceable',
        detail: `${contractName}.${one.name} is config-sourced but names no configData key`,
      })
      continue
    }

    const declared = declaredAddress(
      entry.configData,
      contract?.configData,
      network,
      environment,
      loadConfigFile
    )
    if ('reason' in declared) {
      slots.push({
        ...base,
        status: 'unpriceable',
        detail: `${contractName}.${one.name} is config-sourced but ${declared.reason}`,
      })
      continue
    }

    const expected = paddedToSlot(declared.address, one.slotByteCount)
    if ('fault' in expected) {
      slots.push({
        ...base,
        status: 'unpriceable',
        origin: declared.origin,
        detail: `${declared.origin} cannot be compared against ${one.name}: ${expected.fault}`,
      })
      continue
    }

    slots.push({
      ...base,
      status: expected.value === base.observed ? 'verified' : 'disagrees',
      expected: expected.value,
      origin: declared.origin,
    })
  }

  const byteTotal = (...wanted: ImmutableStatus[]): number =>
    slots
      .filter((slot) => wanted.includes(slot.status))
      .reduce((total, slot) => total + slot.byteCount, 0)

  return {
    decided: true,
    slots,
    disagreements: slots.filter((slot) => slot.status === 'disagrees'),
    pricedByteCount: byteTotal('verified'),
    unpricedByteCount: byteTotal('undeclared', 'unpriceable'),
    disagreeingByteCount: byteTotal('disagrees'),
  }
}
