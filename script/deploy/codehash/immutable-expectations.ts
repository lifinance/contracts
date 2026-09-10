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
 * Unlike a rebuild of the contract, this needs no constructor ABI, no argument
 * order and no argument encoding: a slot holds one left-padded value whatever
 * the parameter that filled it was declared as. What it cannot answer it says so
 * about, per slot, rather than refusing the contract.
 */

import type { IImmutableDeclaration } from '../immutables/immutable-ast'
import type { DeployRequirements } from '../immutables/registry-schema'
import type { IDeployRequirementConfigData } from '../shared/immutableBindings'
import {
  loadConfigFileFromDisk,
  resolveExpectedAddress,
  substituteConfigKeyPlaceholders,
} from '../shared/immutableBindings'

import { strip0x } from './hex'
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
   * Bytes still unaccounted for: undeclared or unpriceable slots. Zero means
   * every byte layer 1 masked now has an expectation behind it.
   */
  unpricedByteCount: number
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
 * @param address - Address as config writes it, checksummed or not.
 * @param slotBytes - Width of a single copy of the immutable.
 * @returns The padded value, or undefined when it does not fit.
 */
const paddedToSlot = (
  address: string,
  slotBytes: number
): string | undefined => {
  const hex = strip0x(address).toLowerCase()
  if (hex.length % 2 !== 0 || hex.length / 2 > slotBytes) return undefined
  return `0x${hex.padStart(slotBytes * 2, '0')}`
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
 * @param runtimeHex - Runtime bytecode found at the address, `0x`-prefixed.
 * @param refs - Foundry's `immutableReferences` for the artifact.
 * @param declarations - The contract's immutables as its AST declares them.
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
  for (const declaration of declarations)
    if (declaration.astId !== undefined)
      nameByAstId.set(String(declaration.astId), declaration.name)

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
 * Each slot is answered on its own. A slot the registry declares as `config` is
 * compared; one it declares `derived`, `unchecked` or `unverifiable`, and one it
 * does not declare at all, is reported unpriced with its reason. That is the
 * whole difference from rebuilding the contract, which had to answer every arg
 * or none: a contract whose one undeclared immutable sits beside four declared
 * ones gets credit for the four.
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
    const entry = contract?.immutables?.[one.name]

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
    if (expected === undefined) {
      slots.push({
        ...base,
        status: 'unpriceable',
        origin: declared.origin,
        detail: `${declared.origin} answers with a value that does not fit the ${one.slotByteCount} bytes ${one.name} occupies`,
      })
      continue
    }

    slots.push({
      ...base,
      status: expected === base.observed ? 'verified' : 'disagrees',
      expected,
      origin: declared.origin,
    })
  }

  const byteTotal = (status: ImmutableStatus | ImmutableStatus[]): number => {
    const wanted = Array.isArray(status) ? status : [status]
    return slots
      .filter((slot) => wanted.includes(slot.status))
      .reduce((total, slot) => total + slot.byteCount, 0)
  }

  return {
    decided: true,
    slots,
    disagreements: slots.filter((slot) => slot.status === 'disagrees'),
    pricedByteCount: byteTotal('verified'),
    unpricedByteCount: byteTotal(['undeclared', 'unpriceable']),
  }
}
