/**
 * Anchors for the pre-broadcast re-derive: everything the gate is allowed to
 * compare live chain state against.
 *
 * Import this from the gate. Every function here derives from `main` — the
 * deployments file, the build artifacts, `config/networks.json`,
 * `config/global.json` — or from the operation parameters read back off chain.
 * Nothing reads a stored verdict, and `deriveGateInput` is the seam that keeps
 * it that way: it takes the sign-time record and passes on only whether one
 * exists.
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { keccak256, parseAbi, type Hex } from 'viem'

import type {
  IAttestedBuild,
  ILineageScope,
  IObservedCode,
} from '../codehash/attested-set'
import { readMetadataTrailer } from '../codehash/bytecode-trailer'
import { strip0x } from '../codehash/hex'
import {
  maskImmutables,
  type ImmutableReferences,
} from '../codehash/immutable-offsets'

import type {
  IPreBroadcastAuthority,
  IPreBroadcastGateInput,
  IPreBroadcastTarget,
} from './prebroadcast-rederive'

const EVM_WORD_HEX_CHARS = 64
const ADDRESS_HEX_CHARS = 40
/** Also the scan stride: a nested frame is offset by its own selector. */
const SELECTOR_HEX_CHARS = 8
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Which live value a declared storage authority reads, and where `main` says
 * what it should be.
 *
 * The table is keyed by contract name and is consulted only for addresses the
 * deployments file already named, so an unknown address never silently acquires
 * "no authorities to check".
 */
export type AuthorityExpectationSource =
  | { from: 'deployments'; contractName: string }
  | { from: 'globalConfig'; key: string }

/**
 * The getters the gate can call. Kept beside the table below so a getter added
 * to one without the other fails to compile rather than becoming a read error
 * at run time, which the gate cannot tell apart from an unreachable node.
 */
export const AUTHORITY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pauserWallet() view returns (address)',
])

export type AuthorityGetter = Extract<
  (typeof AUTHORITY_ABI)[number],
  { type: 'function' }
>['name']

export interface IDeclaredAuthority {
  /** Zero-argument view function returning an address. */
  getter: AuthorityGetter
  source: AuthorityExpectationSource
}

/**
 * The storage-authority values this gate asserts, per contract (R2.6 / F9).
 *
 * A code MATCH says nothing about mutable storage, so the authority that can
 * redirect a contract has to be read live and compared too. The table is
 * deliberately short and explicit: a contract absent from it contributes no
 * authority row, which the gate reports as uncovered rather than as checked.
 */
export const DECLARED_STORAGE_AUTHORITIES: Readonly<
  Record<string, readonly IDeclaredAuthority[]>
> = {
  LiFiDiamond: [
    {
      getter: 'owner',
      source: { from: 'deployments', contractName: 'LiFiTimelockController' },
    },
    {
      getter: 'pauserWallet',
      source: { from: 'globalConfig', key: 'pauserWallet' },
    },
  ],
  ERC20Proxy: [
    {
      getter: 'owner',
      source: { from: 'globalConfig', key: 'refundWallet' },
    },
  ],
}

/**
 * Every address in an operation's calldata that `main` can name.
 *
 * Word-scans each payload rather than decoding it: the set of functions a
 * timelock operation may carry is open, so a decoder-driven list covers
 * whatever it was taught and silently omits the rest. A 32-byte word whose low
 * 20 bytes name a contract in the deployments file is an address this operation
 * touches, whichever call put it there.
 *
 * @param targets - Inner-call targets from the operation parameters.
 * @param payloads - Inner-call payloads from the operation parameters.
 * @param knownAddresses - Lowercased addresses the deployments file holds.
 * @returns Lowercased addresses, deduplicated, targets first.
 */
export const extractCalldataAddresses = (
  targets: readonly string[],
  payloads: readonly string[],
  knownAddresses: ReadonlySet<string>
): string[] => {
  const found = new Set<string>()

  for (const target of targets) {
    const lowered = target.trim().toLowerCase()
    if (lowered.length > 0) found.add(lowered)
  }

  for (const payload of payloads) {
    const body = strip0x(payload ?? '')
    // Every 4-byte alignment, not only the top-level frame's: a call carried in
    // a `bytes` argument — `diamondCut`'s init `_calldata` — shifts all of its
    // own words by its own selector, so an address reachable only through a
    // nested frame sits on no 32-byte stride and would get no row at all.
    for (
      let offset = 0;
      offset + EVM_WORD_HEX_CHARS <= body.length;
      offset += SELECTOR_HEX_CHARS
    ) {
      const word = body.slice(offset, offset + EVM_WORD_HEX_CHARS).toLowerCase()
      const candidate = `0x${word.slice(
        EVM_WORD_HEX_CHARS - ADDRESS_HEX_CHARS
      )}`
      if (candidate === ZERO_ADDRESS) continue
      if (knownAddresses.has(candidate)) found.add(candidate)
    }
  }

  return [...found]
}

/**
 * Inverts a deployments file into address → contract name.
 *
 * Keys on the address bytes alone. A name is a label chosen for display and can
 * be normalised, trimmed or coerced on the way to a screen; the address is what
 * executes, so it is the only thing this index may be looked up by.
 *
 * @param deployments - Parsed `deployments/<network>.json`, name → address.
 * @returns Lowercased address → contract name. An address bound to more than
 * one name maps to undefined, because there is then no single contract to
 * compare its code against.
 */
export const buildAddressNameIndex = (
  deployments: Record<string, unknown>
): Map<string, string | undefined> => {
  const index = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(deployments)) {
    if (typeof value !== 'string') continue
    const address = value.trim().toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue
    if (index.has(address) && index.get(address) !== name)
      index.set(address, undefined)
    else index.set(address, name)
  }
  return index
}

/** Normalises live code the same way an attested build is normalised. */
export interface INormalizedCode {
  observed: IObservedCode
  error?: undefined
}

export interface INormalizeFailure {
  observed?: undefined
  error: string
}

/**
 * Turns raw runtime bytecode into the normalised form the comparison takes.
 *
 * @param runtimeHex - Bytecode as read, `0x`-prefixed.
 * @param refs - `immutableReferences` from the matching artifact, if any.
 * @returns The normalised observation, or why it could not be produced.
 */
export const normalizeRuntimeCode = (
  runtimeHex: string,
  refs: ImmutableReferences | undefined
): INormalizedCode | INormalizeFailure => {
  const body = strip0x(runtimeHex ?? '')
  if (body.length === 0) return { error: 'the address holds no code' }
  if (body.length % 2 !== 0)
    return { error: 'the code read back is not a whole number of bytes' }

  const masked = maskImmutables(`0x${body}`, refs)
  if (!masked.ok) return { error: masked.reason }

  const trailer = readMetadataTrailer(`0x${body}`)
  const strippedBody = trailer.present
    ? strip0x(masked.code).slice(
        0,
        strip0x(masked.code).length - trailer.totalStrippedBytes * 2
      )
    : strip0x(masked.code)

  const maskedByteCount = Object.values(refs ?? {}).reduce(
    (total, occurrences) =>
      total +
      occurrences.reduce((sum, { length }) => sum + (length as number), 0),
    0
  )

  return {
    observed: {
      maskedHash: keccak256(`0x${strippedBody}` as Hex),
      rawByteLength: body.length / 2,
      rawHash: keccak256(`0x${body}` as Hex),
      maskedByteCount,
      ...(trailer.present && trailer.solcVersion !== undefined
        ? { solcVersion: trailer.solcVersion }
        : {}),
    },
  }
}

export interface IArtifactAnchor {
  attested: IAttestedBuild
  immutableReferences: ImmutableReferences | undefined
  /** The profile the artifact declares it was built with. */
  evmVersion: string | undefined
}

/**
 * Reads the build of `main` this run can vouch for out of the forge artifact.
 *
 * The artifact is the only attestation available on a machine that just checked
 * out `main` and built it, so its `lineage` names that build rather than
 * claiming a signed attestation exists. `solcVersion` comes from the
 * artifact's own trailer, never from its metadata block, so it is read the same
 * way the deployed code's version is.
 *
 * @param contractName - Contract to read, as named in the deployments file.
 * @param artifactRoot - Directory holding forge's `out/`.
 * @param lineage - Label for this build, e.g. the commit it was built from.
 * @returns The anchor, or undefined when no artifact exists for the name.
 */
export const readArtifactAnchor = (
  contractName: string,
  artifactRoot: string,
  lineage: string
): IArtifactAnchor | undefined => {
  if (!/^[A-Za-z0-9_]+$/.test(contractName)) return undefined
  const artifactPath = path.join(
    artifactRoot,
    'out',
    `${contractName}.sol`,
    `${contractName}.json`
  )
  if (!existsSync(artifactPath)) return undefined

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return undefined
  }

  const deployed = parsed['deployedBytecode'] as
    | { object?: unknown; immutableReferences?: unknown }
    | undefined
  const object = deployed?.object
  if (typeof object !== 'string') return undefined

  const refs = deployed?.immutableReferences as ImmutableReferences | undefined
  const normalized = normalizeRuntimeCode(object, refs)
  if (normalized.error !== undefined) return undefined

  const metadata = parsed['metadata'] as
    | { settings?: { evmVersion?: unknown } }
    | undefined
  const evmVersion = metadata?.settings?.evmVersion
  const solcVersion = normalized.observed.solcVersion

  // A build whose own trailer carries no readable version cannot be placed in a
  // lineage, and guessing one from the metadata block would put a value the
  // comparison trusts next to one it read from bytes.
  if (solcVersion === undefined) return undefined

  return {
    attested: {
      lineage,
      // The artifact comes out of this host's own `out/`, so a match here is
      // the executor agreeing with itself, never a CI mint.
      provenance: 'A-LOCAL',
      solcVersion,
      maskedHash: normalized.observed.maskedHash,
      rawByteLength: normalized.observed.rawByteLength,
      rawHash: undefined,
    },
    immutableReferences: refs,
    evmVersion: typeof evmVersion === 'string' ? evmVersion : undefined,
  }
}

/**
 * Whether one local build is the complete set of legitimate builds.
 *
 * Closed only when the artifact was built with the exact profile the network
 * declares and the network is not a zkEVM, where a different compiler produces
 * different bytecode from the same source. Derived from repo configuration on
 * both sides; the deployed bytecode has no say, because the proposer writes it.
 *
 * @param network - The network's `config/networks.json` entry.
 * @param artifactEvmVersion - The profile the artifact declares.
 * @returns The scope to hand the comparison.
 */
export const deriveLineageScope = (
  network: { isZkEVM?: unknown; targetEvmVersion?: unknown },
  artifactEvmVersion: string | undefined
): ILineageScope => {
  if (network.isZkEVM === true) return { isClosedSet: false }
  const declared = network.targetEvmVersion
  if (typeof declared !== 'string' || declared.length === 0)
    return { isClosedSet: false }
  if (artifactEvmVersion === undefined) return { isClosedSet: false }
  return { isClosedSet: declared === artifactEvmVersion }
}

/**
 * Resolves what `main` declares a storage authority should hold.
 *
 * @param source - Where the expectation is declared.
 * @param deployments - Parsed deployments file for the network.
 * @param globalConfig - Parsed `config/global.json`.
 * @returns The lowercased expected address, or undefined when `main` declares
 * none. Undefined is never coerced to a default: the gate holds on it.
 */
export const resolveExpectedAuthority = (
  source: AuthorityExpectationSource,
  deployments: Record<string, unknown>,
  globalConfig: Record<string, unknown>
): string | undefined => {
  const raw =
    source.from === 'deployments'
      ? deployments[source.contractName]
      : globalConfig[source.key]
  if (typeof raw !== 'string') return undefined
  const address = raw.trim().toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(address) ? address : undefined
}

export interface IDeriveGateInput {
  operationId: string
  onChainOperationId: string | undefined
  targets: IPreBroadcastTarget[]
  authorities: IPreBroadcastAuthority[]
  /** The stored sign-time record, or null. Only its existence is carried on. */
  signTimeRecord: unknown
}

/**
 * Assembles the gate's input from live observations and the stored record.
 *
 * The record is a G6 reconstruction trail written by the proposer's own run, so
 * every value in it is proposer-controlled. Reducing it to a boolean here is
 * what makes tampering with its contents structurally unable to move the
 * verdict: no other field survives into the gate's input.
 *
 * @param input - Observations, anchors, and the stored record.
 * @returns The gate input, carrying the record's presence and none of its
 * values.
 */
export const deriveGateInput = (
  input: IDeriveGateInput
): IPreBroadcastGateInput => ({
  operationId: input.operationId,
  onChainOperationId: input.onChainOperationId,
  targets: input.targets,
  authorities: input.authorities,
  signTimeRecordPresent:
    input.signTimeRecord !== null && input.signTimeRecord !== undefined,
})
