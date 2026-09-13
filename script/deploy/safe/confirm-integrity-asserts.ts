/**
 * Confirm-time integrity assertions for one pending Safe proposal.
 *
 * Import this from any script that offers to sign or execute a stored proposal.
 * Every assertion answers "is this proposal what its own record claims", and
 * each one records its verdict on a `check-ledger.ts` ledger, so the grading
 * rules that ledger enforces — an integrity mismatch has no acknowledgement
 * path, and an anchor that can only report can never decide a pass — apply here
 * without this module restating them.
 *
 * The lookups are injected rather than performed: the policy is then testable
 * without a chain, and every anchor a verdict rests on is visible at the call
 * site that supplies it.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import {
  decodeFunctionData,
  getAddress,
  hashMessage,
  hashTypedData,
  isHex,
  parseAbi,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'
import { createDefaultCache } from '../shared/deployment-cache'
import { indexDeploymentsByAddress } from '../shared/funnel-deploy-gate'
import type { IDeploymentRecord } from '../shared/mongo-log-utils'

import {
  createCheckLedger,
  gateLabel,
  recordCheck,
  rollUpChecks,
  summariseLedger,
  type AnchorId,
  type CheckStatus,
  type ICheckDefinition,
  type ICheckLedger,
  type ILedgerVerdict,
} from './check-ledger'
import { proposalKeyOf } from './codehash-sign-gate'
import type { ISafeTransaction, SafeClient } from './safe-utils'
import {
  TIMELOCK_SCHEDULE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_SCHEDULE_BATCH_SELECTOR,
  TIMELOCK_SCHEDULE_SELECTOR,
  carriesTimelockScheduleSelector,
} from './timelock-abi'

const TIMELOCK_MIN_DELAY_ABI = parseAbi([
  'function getMinDelay() view returns (uint256)',
])

export const CHECK_SAFE_ADDRESS = 'INT-SAFE-ADDRESS'
export const CHECK_SAFE_TX_HASH = 'INT-SAFE-TX-HASH'
export const CHECK_SIGNATURES = 'INT-SIGNATURES'
export const CHECK_FIXED_FIELDS = 'INT-FIXED-FIELDS'
export const CHECK_TARGET = 'INT-TARGET'
export const CHECK_TIMELOCK_DELAY = 'INT-TIMELOCK-DELAY'

const SECTION = 'Proposal'

/** Why an absent run refuses, stated identically wherever that case is reported. */
const UNEVALUATED_REASON =
  'the integrity assertions produced no verdict for this transaction at all, so there is nothing that permits signing it'

/**
 * How each status prints.
 *
 * No two statuses may differ by only one of word, glyph and colour: a grey that
 * reads as a red teaches a signer to click through both. `error` is deliberately
 * not a softer red than `fail` — both block, and the ledger grades them the
 * same way.
 *
 * A `Map` rather than an object, because the lookup falls back on a miss and a
 * plain object's bracket access walks the prototype: a rehydrated result
 * carrying `constructor` or `toString` as its status would resolve to an
 * inherited member instead of missing, and print as whatever that stringifies
 * to rather than as unverified.
 */
const STATUS_BUCKETS: ReadonlyMap<
  CheckStatus,
  { word: string; glyph: string; colour: string }
> = new Map([
  ['pass', { word: 'PASS', glyph: '✓', colour: '32' }],
  ['fail', { word: 'MISMATCH', glyph: '⛔', colour: '31' }],
  ['error', { word: 'UNVERIFIED', glyph: '✗', colour: '31' }],
  ['needs-ack', { word: 'NEEDS REVIEW', glyph: '⚠', colour: '33' }],
])

/** A status no bucket names is unverified, which is the reading that blocks. */
const UNKNOWN_STATUS_BUCKET = {
  word: 'UNVERIFIED',
  glyph: '✗',
  colour: '31',
} as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * The `operation` the Safe struct must carry.
 *
 * Pinned as the value rather than as `OperationTypeEnum.Call`: an assertion
 * written against the symbol moves with any renumbering of the enum, and would
 * then pass while admitting a delegatecall.
 */
const REQUIRED_OPERATION = 0

/**
 * Fields of the signed Safe struct that `getTransactionHash` is always called
 * with as zero, so a stored non-zero value is a field the hash does not cover.
 */
const ZERO_UINT_FIELDS = ['safeTxGas', 'baseGas', 'gasPrice'] as const
const ZERO_ADDRESS_FIELDS = ['gasToken', 'refundReceiver'] as const

/** Keys of the signed struct this repo writes, and therefore hashes over. */
const KNOWN_TX_DATA_KEYS: ReadonlySet<string> = new Set([
  'to',
  'value',
  'data',
  'operation',
  'nonce',
  ...ZERO_UINT_FIELDS,
  ...ZERO_ADDRESS_FIELDS,
])

/** `v` values `checkNSignatures` recovers over the EIP-191 digest, at `v - 4`. */
const ETH_SIGN_V: ReadonlySet<number> = new Set([31, 32])
/** `v` values it recovers over the EIP-712 digest. */
const TYPED_DATA_V: ReadonlySet<number> = new Set([27, 28])

/** One deployment record, reduced to the fields a target lookup rests on. */
export interface IDeploymentRecordRef {
  contractName: string
  version: string
}

/** How a target address was named, or why it could not be. */
export type TargetResolution =
  | { kind: 'configured-safe' }
  | { kind: 'committed-deployment'; name: string }
  | { kind: 'recorded-deployment'; name: string; version: string }
  | { kind: 'ambiguous'; candidates: IDeploymentRecordRef[] }
  | { kind: 'unknown' }

/**
 * Names an address from the deployment records that claim it.
 *
 * `(network, address)` is not unique in the deployment record — the production
 * mirror holds pairs whose records disagree on version — so the first match of a
 * scan is a coin flip between two different answers. A disagreement is returned
 * as such and refused by the caller; a record carrying no version is not a
 * disagreement, because a blank field states nothing to conflict with.
 * @param records - Every record claiming that (network, address) pair.
 * @returns The single name and version, an explicit ambiguity, or unknown.
 */
export const resolveRecordedTarget = (
  records: readonly IDeploymentRecordRef[]
): TargetResolution => {
  if (records.length === 0) return { kind: 'unknown' }

  const versioned = records.filter((record) => record.version.trim() !== '')
  const distinct = new Map<string, IDeploymentRecordRef>()
  for (const record of versioned)
    distinct.set(`${record.contractName}@${record.version}`, record)

  if (distinct.size > 1)
    return { kind: 'ambiguous', candidates: [...distinct.values()] }

  const only = [...distinct.values()][0] ?? records[0]
  if (!only) return { kind: 'unknown' }

  return {
    kind: 'recorded-deployment',
    name: only.contractName,
    version: only.version,
  }
}

/** The proposal as stored, plus the transaction that would actually be signed. */
export interface IIntegrityAssertInput {
  network: string
  chainId: number
  /**
   * The Safe the signing client is pointed at. The caller resolves it from
   * `config/networks.json`; when config names none this is the document's own
   * claim, and `configuredSafeAddress` is then absent so the verdict says so.
   */
  clientSafeAddress: Address
  /** The Safe `config/networks.json` names for this network, when it names one. */
  configuredSafeAddress?: string
  /** The Safe the proposal document claims to be against. */
  documentSafeAddress?: string
  /** The `safeTxHash` stored on the proposal document. */
  documentSafeTxHash?: string
  /** `safeTx.data` exactly as stored, including any field the hash omits. */
  storedTxData: Record<string, unknown>
  /** Signature entries as stored, keyed however the document keyed them. */
  storedSignatures: readonly { signer?: unknown; data?: unknown }[]
  /** The target of the transaction that would be signed. */
  to: string
  /** The payload of the transaction that would be signed. */
  data: Hex
  /**
   * `value` of the transaction that would be signed.
   *
   * Read from the signed struct, never from `storedTxData`: the row is written
   * by the proposer and is displayed rather than signed, so a digest rebuilt
   * out of it would verify signatures against whatever the row describes.
   * `storedTxData` is only ever compared here — it never supplies a value a
   * check keys on.
   */
  signedValue: string
  /** `operation` of the transaction that would be signed. */
  signedOperation: number
  /** `nonce` of the transaction that would be signed. */
  signedNonce: number
}

/** Lookups the assertions need. Each one names the anchor it speaks for. */
export interface IIntegrityAssertDeps {
  /** The Safe's own hash of the transaction that would be signed. */
  recomputeSafeTxHash: () => Promise<Hex>
  /** The Safe's current owner set. */
  currentOwners: () => Promise<readonly Address[]>
  /** Contract name by lowercase 20-byte hex address, from the committed log. */
  committedDeployments: () => Promise<ReadonlyMap<string, string>>
  /** Every deployment record claiming this (network, address) pair. */
  recordedDeployments: (
    address: string
  ) => Promise<readonly IDeploymentRecordRef[]>
  /** The timelock's live minimum delay, read at the committed timelock address. */
  timelockMinDelay: (timelock: Address) => Promise<bigint>
}

interface IAssertOutcome {
  status: CheckStatus
  expected: string
  actual: string
  anchor: AnchorId
  detail?: string
}

const errorOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const normalise = (network: string, value: string): Address | undefined => {
  try {
    return normalizeAddressForNetwork(network, value)
  } catch {
    return undefined
  }
}

/**
 * Reads a stored field as an exact zero.
 *
 * Deliberately not a coercion: `BigInt`, `Number` and `parseInt` all turn some
 * non-zero and some unparseable input into a usable value, and a field
 * normalised into zero for the sake of getting an answer is a field the
 * assertion stopped checking.
 */
const isExactZero = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === 'number') return value === 0
  if (typeof value === 'bigint') return value === 0n
  if (typeof value !== 'string') return false

  const trimmed = value.trim()
  if (trimmed === '') return false
  if (/^0+$/.test(trimmed)) return true
  return /^0x0+$/i.test(trimmed)
}

/**
 * Reads a stored field as an exact non-negative integer, or not at all.
 *
 * `Number` and `parseInt` both answer for input that says something else —
 * `Number('')` is 0, `parseInt('1x')` is 1 — and a value normalised into a
 * comparable one is a value the comparison stopped checking.
 */
const readExactUint = (value: unknown): number | undefined => {
  if (typeof value === 'number')
    return Number.isInteger(value) && value >= 0 ? value : undefined
  if (typeof value === 'bigint')
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^(?:0|[1-9][0-9]*)$/.test(trimmed) ? Number(trimmed) : undefined
}

const isZeroAddressValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '') return false
  return /^0x0{40}$/i.test(trimmed)
}

function assertSafeAddress(input: IIntegrityAssertInput): IAssertOutcome {
  const expectedRaw = input.configuredSafeAddress
  if (expectedRaw === undefined || expectedRaw.trim() === '')
    return {
      status: 'error',
      expected: 'a Safe address in config/networks.json',
      actual: input.documentSafeAddress ?? 'none stored',
      anchor: 'A-UNRESOLVED',
      detail:
        'config names no Safe for this network, so the Safe the proposal is against cannot be verified against any reviewed anchor',
    }

  const expected = normalise(input.network, expectedRaw)
  if (!expected)
    return {
      status: 'error',
      expected: expectedRaw,
      actual: input.documentSafeAddress ?? 'none stored',
      anchor: 'A-LOCAL',
      detail: 'the configured Safe address is not readable as an address',
    }

  const claimed = input.documentSafeAddress
  if (claimed === undefined || claimed.trim() === '')
    return {
      status: 'error',
      expected,
      actual: 'none stored',
      anchor: 'A-LOCAL',
      detail:
        'the proposal document names no Safe, so there is nothing to compare',
    }

  const actual = normalise(input.network, claimed)
  if (!actual)
    return {
      status: 'fail',
      expected,
      actual: claimed,
      anchor: 'A-LOCAL',
      detail: 'the stored Safe address is not readable as an address',
    }

  return {
    status: actual === expected ? 'pass' : 'fail',
    expected,
    actual,
    anchor: 'A-LOCAL',
    ...(actual === expected
      ? {}
      : {
          detail:
            'the proposal is against a different Safe than config names for this network',
        }),
  }
}

async function assertSafeTxHash(
  input: IIntegrityAssertInput,
  deps: IIntegrityAssertDeps
): Promise<IAssertOutcome> {
  let recomputed: Hex
  try {
    recomputed = await deps.recomputeSafeTxHash()
  } catch (error) {
    return {
      status: 'error',
      expected: "the Safe's own hash of this transaction",
      actual: input.documentSafeTxHash ?? 'none stored',
      anchor: 'A-CHAIN',
      detail: `the hash could not be recomputed: ${errorOf(error)}`,
    }
  }

  const stored = input.documentSafeTxHash
  if (
    stored === undefined ||
    !isHex(stored, { strict: true }) ||
    stored.length !== 66
  )
    return {
      status: 'error',
      expected: recomputed,
      actual: stored ?? 'none stored',
      anchor: 'A-CHAIN',
      detail:
        'the stored hash is not a 32-byte value, so there is nothing to compare against the recomputed one',
    }

  const matches = stored.toLowerCase() === recomputed.toLowerCase()
  return {
    status: matches ? 'pass' : 'fail',
    expected: recomputed,
    actual: stored,
    anchor: 'A-CHAIN',
    ...(matches
      ? {}
      : {
          detail:
            'the stored hash describes a different transaction than the one that would be signed',
        }),
  }
}

/**
 * Recovers a stored signature to the address that produced it.
 *
 * Both framings the Safe accepts are covered, because both are produced here:
 * `eth_sign` over the EIP-191 digest at `v - 4`, and EIP-712 typed data. A `v`
 * outside either set is a contract signature or an approved hash, which
 * `ecrecover` cannot answer for at all — reported as unrecoverable rather than
 * as a signature belonging to nobody.
 */
/**
 * `recoverAddress` throws on a signature whose `r` or `s` is out of range, and a
 * throw would escape this module's result contract and leave the run undefined —
 * which blocks, but under no named anchor, so the display could not say which
 * assertion refused. The signature comes off a stored row, so a corrupt blob
 * reaches this.
 */
const recoverOrUnrecoverable = async (
  hash: Hex,
  signature: Hex
): Promise<{ signer: Address } | { unrecoverable: string }> => {
  try {
    return { signer: await recoverAddress({ hash, signature }) }
  } catch (error) {
    return {
      unrecoverable: `the signature could not be recovered: ${errorOf(error)}`,
    }
  }
}

async function recoverStoredSignature(
  signature: Hex,
  input: IIntegrityAssertInput,
  safeTxHash: Hex
): Promise<{ signer: Address } | { unrecoverable: string }> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    return { unrecoverable: 'not a 65-byte signature' }

  const v = parseInt(signature.slice(130, 132), 16)

  if (ETH_SIGN_V.has(v)) {
    const reframed = `${signature.slice(0, 130)}${(v - 4)
      .toString(16)
      .padStart(2, '0')}` as Hex
    return recoverOrUnrecoverable(hashMessage({ raw: safeTxHash }), reframed)
  }

  if (TYPED_DATA_V.has(v)) {
    // `to`, `value` and `nonce` come off the signed struct unvalidated, and
    // `getAddress`/`BigInt` throw on a malformed one. Only the reframing is
    // guarded here: recovery is a statement about the signature, so folding it
    // in would report a bad signature as a bad struct.
    let digest: Hex
    try {
      digest = hashTypedData({
        domain: {
          chainId: input.chainId,
          verifyingContract: input.clientSafeAddress,
        },
        types: {
          SafeTx: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'operation', type: 'uint8' },
            { name: 'safeTxGas', type: 'uint256' },
            { name: 'baseGas', type: 'uint256' },
            { name: 'gasPrice', type: 'uint256' },
            { name: 'gasToken', type: 'address' },
            { name: 'refundReceiver', type: 'address' },
            { name: 'nonce', type: 'uint256' },
          ],
        },
        primaryType: 'SafeTx',
        message: {
          to: getAddress(input.to),
          value: BigInt(input.signedValue),
          data: input.data,
          operation: input.signedOperation,
          safeTxGas: 0n,
          baseGas: 0n,
          gasPrice: 0n,
          gasToken: ZERO_ADDRESS,
          refundReceiver: ZERO_ADDRESS,
          nonce: BigInt(input.signedNonce),
        },
      })
    } catch (error) {
      return {
        unrecoverable: `the signed struct could not be reframed as typed data: ${errorOf(
          error
        )}`,
      }
    }
    return recoverOrUnrecoverable(digest, signature)
  }

  return {
    unrecoverable: `v=${v} is neither an eth_sign nor a typed-data recovery id`,
  }
}

async function assertSignatures(
  input: IIntegrityAssertInput,
  deps: IIntegrityAssertDeps
): Promise<IAssertOutcome> {
  const expected = 'every stored signature recovers to a current Safe owner'

  let owners: readonly Address[]
  try {
    owners = await deps.currentOwners()
  } catch (error) {
    return {
      status: 'error',
      expected,
      actual: `${input.storedSignatures.length} stored`,
      anchor: 'A-CHAIN',
      detail: `the owner set could not be read: ${errorOf(error)}`,
    }
  }

  if (input.storedSignatures.length === 0)
    return {
      status: 'fail',
      expected,
      actual: '0 stored signatures',
      anchor: 'A-PROPOSAL',
      detail:
        'propose-to-safe.ts signs and stores one signature with every row it writes, and refuses a signer who is not a Safe owner — so an empty set is a row something else wrote, not a row awaiting its first signature, and there is nothing to recover against the recomputed hash',
    }

  // Recovered against the recomputed hash, never the stored one: the stored hash
  // is written by the proposer, so signatures checked against it would verify
  // against whatever transaction the proposer chose to describe.
  let safeTxHash: Hex
  try {
    safeTxHash = await deps.recomputeSafeTxHash()
  } catch (error) {
    return {
      status: 'error',
      expected,
      actual: `${input.storedSignatures.length} stored`,
      anchor: 'A-CHAIN',
      detail: `the hash the signatures must cover could not be recomputed: ${errorOf(
        error
      )}`,
    }
  }

  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()))
  const problems: string[] = []
  const recovered = new Set<string>()

  for (const [index, entry] of input.storedSignatures.entries()) {
    if (typeof entry.data !== 'string') {
      problems.push(`#${index} carries no signature bytes`)
      continue
    }

    const outcome = await recoverStoredSignature(
      entry.data as Hex,
      input,
      safeTxHash
    )
    if ('unrecoverable' in outcome) {
      problems.push(`#${index} ${outcome.unrecoverable}`)
      continue
    }

    const signer = outcome.signer.toLowerCase()
    if (!ownerSet.has(signer)) {
      problems.push(
        `#${index} recovers to ${outcome.signer}, not a current owner`
      )
      continue
    }

    // The label is what every downstream signature count reads, so a label that
    // disagrees with the recovery makes the threshold arithmetic describe
    // signers who did not sign.
    const labelled =
      typeof entry.signer === 'string' ? entry.signer.toLowerCase() : undefined
    if (labelled !== signer)
      problems.push(
        `#${index} is stored against ${
          labelled ?? 'no signer'
        } but recovers to ${outcome.signer}`
      )

    recovered.add(signer)
  }

  if (problems.length > 0)
    return {
      status: 'fail',
      expected,
      actual: problems.join('; '),
      anchor: 'A-CHAIN',
      detail: `${owners.length} current owners`,
    }

  return {
    status: 'pass',
    expected,
    actual: `${recovered.size} of ${input.storedSignatures.length} stored signatures recovered to distinct current owners`,
    anchor: 'A-CHAIN',
  }
}

function assertFixedFields(input: IIntegrityAssertInput): IAssertOutcome {
  const expected =
    'operation=Call, safeTxGas=baseGas=gasPrice=0, gasToken=refundReceiver=zero, and no field the hash omits'
  const problems: string[] = []

  // The signed struct decides, because it is what the signature commits to.
  if (input.signedOperation !== REQUIRED_OPERATION)
    problems.push(
      `the struct being signed carries operation=${input.signedOperation} — only a Call is hashed and signed here`
    )

  // The stored row is then compared against it rather than read as the answer.
  // An absent value is not a disagreement: `initializeSafeTransaction`
  // normalises an omitted operation to Call, so a row that omits it says the
  // same thing. A value present but not readable as an integer is, because
  // nothing can show it agrees.
  const storedOperation = input.storedTxData['operation']
  if (storedOperation !== undefined && storedOperation !== null) {
    const parsed = readExactUint(storedOperation)
    if (parsed !== input.signedOperation)
      problems.push(
        `the stored row says operation=${String(
          storedOperation
        )} but the struct being signed carries operation=${
          input.signedOperation
        }`
      )
  }

  for (const field of ZERO_UINT_FIELDS)
    if (!isExactZero(input.storedTxData[field]))
      problems.push(`${field}=${String(input.storedTxData[field])}`)

  for (const field of ZERO_ADDRESS_FIELDS)
    if (!isZeroAddressValue(input.storedTxData[field]))
      problems.push(`${field}=${String(input.storedTxData[field])}`)

  // A field nothing reads is a field a proposer may set freely: it is displayed
  // from the record and omitted from the hash, so it is the one place the two
  // can be made to disagree without either check noticing.
  const unknown = Object.keys(input.storedTxData).filter(
    (key) => !KNOWN_TX_DATA_KEYS.has(key)
  )
  if (unknown.length > 0)
    problems.push(`fields outside the signed struct: ${unknown.join(', ')}`)

  if (problems.length > 0)
    return {
      status: 'fail',
      expected,
      actual: problems.join('; '),
      anchor: 'A-LOCAL',
      detail:
        'the hash is computed over a Call with zeroed gas parameters, so any other stored value is signed as something it does not say',
    }

  return {
    status: 'pass',
    expected,
    actual: 'operation=Call, every omitted field zero, no extra field',
    anchor: 'A-LOCAL',
  }
}

/**
 * Names the target, preferring anchors that may decide over anchors that may
 * only report.
 *
 * `config/networks.json` and the committed deployment log are reviewed files, so
 * a match in either is a verdict. The deployment record is written by the
 * deploying process, so a match there names the address for the signer and
 * leaves the result unverified — recorded under the anchor that says so, which
 * the ledger then refuses to grade as a pass.
 */
async function assertTarget(
  input: IIntegrityAssertInput,
  deps: IIntegrityAssertDeps
): Promise<IAssertOutcome> {
  const expected =
    'a target this checkout can name: the configured Safe, or an address in the committed deployment log'

  const to = normalise(input.network, input.to)
  if (!to)
    return {
      status: 'fail',
      expected,
      actual: input.to,
      anchor: 'A-LOCAL',
      detail: 'the target is not readable as an address',
    }

  const configured = input.configuredSafeAddress
    ? normalise(input.network, input.configuredSafeAddress)
    : undefined
  if (configured && configured === to)
    return {
      status: 'pass',
      expected,
      actual: `${to} — the configured Safe itself`,
      anchor: 'A-LOCAL',
    }

  let committed: ReadonlyMap<string, string>
  try {
    committed = await deps.committedDeployments()
  } catch (error) {
    return {
      status: 'error',
      expected,
      actual: to,
      anchor: 'A-LOCAL',
      detail: `the committed deployment log could not be read: ${errorOf(
        error
      )}`,
    }
  }

  const committedName = committed.get(to.toLowerCase())
  if (committedName !== undefined)
    return {
      status: 'pass',
      expected,
      actual: `${to} — ${committedName}`,
      anchor: 'A-LOCAL',
    }

  let records: readonly IDeploymentRecordRef[]
  try {
    records = await deps.recordedDeployments(to)
  } catch (error) {
    return {
      status: 'error',
      expected,
      actual: to,
      anchor: 'A-UNRESOLVED',
      detail: `not in the committed log, and the deployment record could not be consulted: ${errorOf(
        error
      )}`,
    }
  }

  const resolution = resolveRecordedTarget(records)
  if (resolution.kind === 'ambiguous')
    return {
      status: 'fail',
      expected,
      actual: `${to} — the deployment record contradicts itself: ${resolution.candidates
        .map((candidate) => `${candidate.contractName}@${candidate.version}`)
        .join(' vs ')}`,
      anchor: 'A-MONGO',
      detail:
        'a target the record cannot name once is not an identified target',
    }

  if (resolution.kind === 'recorded-deployment')
    return {
      status: 'pass',
      expected,
      actual: `${to} — the deployment record reports ${resolution.name}@${
        resolution.version || 'no version'
      }`,
      anchor: 'A-MONGO',
      detail:
        'the deployment record is written by the deploying process, so it names this target without vouching for it',
    }

  return {
    status: 'fail',
    expected,
    actual: `${to} — named by neither the committed log nor the deployment record`,
    anchor: 'A-LOCAL',
    detail: 'nothing this checkout trusts says what is at this address',
  }
}

/** Whether the payload is a timelock schedule, and the delay it asks for. */
export type ScheduleShape =
  | { kind: 'not-a-schedule' }
  | { kind: 'schedule'; delay: bigint }
  | { kind: 'undecodable'; reason: string }

/**
 * Reads the delay out of a timelock schedule payload.
 *
 * Both the batch form this repo emits and the singular `schedule` the
 * controller also exposes are decoded; a payload that carries either selector
 * without being one is reported undecodable rather than treated as unrelated,
 * because an envelope this cannot open is a schedule whose delay nothing here
 * has seen.
 * @param data - The payload of the transaction that would be signed.
 * @returns The delay, that the payload is not a schedule, or why it could not be read.
 */
export const readScheduleDelay = (data: Hex): ScheduleShape => {
  if (!isHex(data, { strict: true }) || data.length % 2 !== 0)
    return {
      kind: 'undecodable',
      reason: 'the payload is not well-formed calldata',
    }

  const selector = data.slice(0, 10).toLowerCase()
  const isBatch = selector === TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()
  const isSingle = selector === TIMELOCK_SCHEDULE_SELECTOR.toLowerCase()

  if (isBatch || isSingle) {
    try {
      const { args } = decodeFunctionData({
        abi: isBatch ? TIMELOCK_SCHEDULE_BATCH_ABI : TIMELOCK_SCHEDULE_ABI,
        data,
      })
      // Both signatures take the delay as the sixth argument.
      return { kind: 'schedule', delay: args[5] as bigint }
    } catch (error) {
      return {
        kind: 'undecodable',
        reason: `a schedule payload that does not decode: ${errorOf(error)}`,
      }
    }
  }

  if (carriesTimelockScheduleSelector(data))
    return {
      kind: 'undecodable',
      reason:
        'a schedule selector appears inside an envelope this cannot open, so its delay was never read',
    }

  return { kind: 'not-a-schedule' }
}

/**
 * The committed timelock address, so a schedule's delay is compared against the
 * minimum of the timelock this checkout knows about rather than of whichever
 * contract the proposal points at — a rogue target would report any minimum
 * asked of it.
 */
const COMMITTED_TIMELOCK_NAME = 'LiFiTimelockController'

async function assertTimelockDelay(
  input: IIntegrityAssertInput,
  deps: IIntegrityAssertDeps,
  shape: Extract<ScheduleShape, { kind: 'schedule' } | { kind: 'undecodable' }>
): Promise<IAssertOutcome> {
  const expected = `a delay of at least the committed ${COMMITTED_TIMELOCK_NAME}'s live minimum`

  if (shape.kind === 'undecodable')
    return {
      status: 'error',
      expected,
      actual: 'no delay could be read',
      anchor: 'A-UNRESOLVED',
      detail: shape.reason,
    }

  let committed: ReadonlyMap<string, string>
  try {
    committed = await deps.committedDeployments()
  } catch (error) {
    return {
      status: 'error',
      expected,
      actual: `${shape.delay} seconds`,
      anchor: 'A-LOCAL',
      detail: `the committed deployment log could not be read: ${errorOf(
        error
      )}`,
    }
  }

  const timelockEntry = [...committed.entries()].find(
    ([, name]) => name === COMMITTED_TIMELOCK_NAME
  )
  if (!timelockEntry)
    return {
      status: 'error',
      expected,
      actual: `${shape.delay} seconds`,
      anchor: 'A-LOCAL',
      detail: `the committed deployment log names no ${COMMITTED_TIMELOCK_NAME} for this network`,
    }

  const timelock = getAddress(timelockEntry[0])
  const to = normalise(input.network, input.to)
  if (!to || to.toLowerCase() !== timelock.toLowerCase())
    return {
      status: 'fail',
      expected: `a schedule addressed to the committed ${COMMITTED_TIMELOCK_NAME} at ${timelock}`,
      actual: `addressed to ${input.to}`,
      anchor: 'A-LOCAL',
      detail:
        'a schedule sent elsewhere would be checked against a minimum that contract chooses',
    }

  let minDelay: bigint
  try {
    minDelay = await deps.timelockMinDelay(timelock)
  } catch (error) {
    return {
      status: 'error',
      expected,
      actual: `${shape.delay} seconds`,
      anchor: 'A-CHAIN',
      detail: `the live minimum delay could not be read: ${errorOf(error)}`,
    }
  }

  const sufficient = shape.delay >= minDelay
  return {
    status: sufficient ? 'pass' : 'fail',
    expected: `at least ${minDelay} seconds`,
    actual: `${shape.delay} seconds`,
    anchor: 'A-CHAIN',
    ...(sufficient
      ? {}
      : {
          detail:
            'the timelock would reject this schedule, and a shorter delay is less review time than the fleet agreed to',
        }),
  }
}

export const INTEGRITY_CHECK_DEFINITIONS: Record<string, ICheckDefinition> = {
  [CHECK_SAFE_ADDRESS]: {
    checkId: CHECK_SAFE_ADDRESS,
    section: SECTION,
    checkClass: 'integrity',
    gate: 'A',
    title: 'Safe address',
  },
  [CHECK_SAFE_TX_HASH]: {
    checkId: CHECK_SAFE_TX_HASH,
    section: SECTION,
    checkClass: 'integrity',
    gate: 'B',
    title: 'Safe tx hash',
  },
  [CHECK_SIGNATURES]: {
    checkId: CHECK_SIGNATURES,
    section: SECTION,
    checkClass: 'integrity',
    gate: 'C',
    title: 'Owner signatures',
  },
  [CHECK_FIXED_FIELDS]: {
    checkId: CHECK_FIXED_FIELDS,
    section: SECTION,
    checkClass: 'integrity',
    gate: 'D',
    title: 'Call shape',
  },
  [CHECK_TARGET]: {
    checkId: CHECK_TARGET,
    section: SECTION,
    checkClass: 'integrity',
    gate: 'E',
    title: 'Target address',
  },
  [CHECK_TIMELOCK_DELAY]: {
    checkId: CHECK_TIMELOCK_DELAY,
    section: SECTION,
    checkClass: 'integrity',
    gate: 'F',
    title: 'Timelock delay',
  },
}

/**
 * Checks that always run, in the order a signer should read them: the Safe the
 * whole run is pointed at first, because every later assertion reads through it.
 */
export const INTEGRITY_CHECKS_ALWAYS: readonly string[] = [
  CHECK_SAFE_ADDRESS,
  CHECK_SAFE_TX_HASH,
  CHECK_SIGNATURES,
  CHECK_FIXED_FIELDS,
  CHECK_TARGET,
]

/**
 * Wires the assertions to the real chain, checkout and deployment record.
 *
 * The recomputed hash is read once and reused: two assertions rest on it, and a
 * second read could answer differently while reporting as the same value.
 * @param options.network - Network key, which also selects the address form the committed log uses.
 * @param options.safe - The signing client, already pointed at the Safe config names.
 * @param options.safeTx - The transaction that would be signed.
 * @returns Dependencies for {@link runIntegrityAsserts}.
 */
export const createIntegrityAssertDeps = (options: {
  network: string
  safe: SafeClient
  safeTx: ISafeTransaction
}): IIntegrityAssertDeps => {
  const { network, safe, safeTx } = options
  let hash: Promise<Hex> | undefined
  let committed: Promise<ReadonlyMap<string, string>> | undefined
  let records: Promise<readonly IDeploymentRecord[]> | undefined

  const readCommitted = async (): Promise<ReadonlyMap<string, string>> => {
    const deployments = await getDeployments(
      network.toLowerCase() as SupportedChain,
      EnvironmentEnum.production
    )
    if (!isTronNetworkKey(network.toLowerCase()))
      return indexDeploymentsByAddress(deployments.default ?? deployments)

    const { getTronWebCodecOnlyForNetwork, tronBase58ToEvm20Hex } =
      await import('@lifi/tron-devkit')
    const tronWeb = getTronWebCodecOnlyForNetwork(network.toLowerCase())
    return indexDeploymentsByAddress(
      deployments.default ?? deployments,
      (value) => {
        try {
          return tronBase58ToEvm20Hex(tronWeb, value).toLowerCase()
        } catch {
          return undefined
        }
      }
    )
  }

  const readRecords = async (): Promise<readonly IDeploymentRecord[]> => {
    const mongoUri = process.env['MONGODB_URI']
    if (!mongoUri)
      throw new Error(
        'MONGODB_URI is not set, so the deployment record cannot be consulted'
      )

    return createDefaultCache({
      mongoUri,
      databaseName: 'contract-deployments',
      batchSize: 100,
    }).get('production')
  }

  return {
    recomputeSafeTxHash: () => {
      hash ??= safe.getTransactionHash(safeTx)
      return hash
    },
    currentOwners: () => safe.getOwners(),
    committedDeployments: () => {
      committed ??= readCommitted()
      return committed
    },
    recordedDeployments: async (address) => {
      records ??= readRecords()
      const all = await records
      const networkKey = network.toLowerCase()
      const wanted = address.toLowerCase()

      // Every match, not the first: the record holds `(network, address)` pairs
      // more than once, and picking one of them is picking an answer.
      return all
        .filter(
          (record) =>
            record.network?.toLowerCase() === networkKey &&
            record.address?.toLowerCase() === wanted
        )
        .map((record) => ({
          contractName: record.contractName,
          version: record.version ?? '',
        }))
    },
    timelockMinDelay: (timelock) =>
      safe.getPublicClient().readContract({
        address: timelock,
        abi: TIMELOCK_MIN_DELAY_ABI,
        functionName: 'getMinDelay',
      }),
  }
}

export interface IIntegrityAssertRun {
  ledger: ICheckLedger
  verdict: ILedgerVerdict
  /** The checks this proposal registered, so a signer can see what did not run. */
  registered: string[]
  /**
   * The one transaction this run graded, as `proposalKeyOf` spells it.
   *
   * A verdict is a statement about a single transaction, so the refusal
   * compares this against the transaction actually reaching the signer. Without
   * it a run held in a loop variable authorises the next proposal too.
   */
  gradedKey: string
}

/**
 * Runs every integrity assertion that applies to one proposal.
 *
 * The delay assertion is registered only for a payload that is a timelock
 * schedule: the ledger counts a registered check that produced no result as
 * unverified and blocks on it, which is right for a check that should have run
 * and wrong for one that has nothing to say. The registered list is returned so
 * the absence is visible rather than implied.
 * @param input - The proposal as stored, and the transaction that would be signed.
 * @param deps - The lookups each assertion reads its anchor from.
 * @returns The ledger, its verdict, and the checks that were registered.
 */
export const runIntegrityAsserts = async (
  input: IIntegrityAssertInput,
  deps: IIntegrityAssertDeps
): Promise<IIntegrityAssertRun> => {
  const shape = readScheduleDelay(input.data)
  const registered = [
    ...INTEGRITY_CHECKS_ALWAYS,
    ...(shape.kind === 'not-a-schedule' ? [] : [CHECK_TIMELOCK_DELAY]),
  ]

  const ledger = createCheckLedger({
    expectedNetworks: [input.network],
    checks: registered.map((checkId) => {
      const definition = INTEGRITY_CHECK_DEFINITIONS[checkId]
      if (!definition)
        throw new Error(`runIntegrityAsserts: no definition for ${checkId}`)
      return definition
    }),
  })

  const outcomes: [string, IAssertOutcome][] = [
    [CHECK_SAFE_ADDRESS, assertSafeAddress(input)],
    [CHECK_SAFE_TX_HASH, await assertSafeTxHash(input, deps)],
    [CHECK_SIGNATURES, await assertSignatures(input, deps)],
    [CHECK_FIXED_FIELDS, assertFixedFields(input)],
    [CHECK_TARGET, await assertTarget(input, deps)],
  ]

  if (shape.kind !== 'not-a-schedule')
    outcomes.push([
      CHECK_TIMELOCK_DELAY,
      await assertTimelockDelay(input, deps, shape),
    ])

  for (const [checkId, outcome] of outcomes)
    recordCheck(ledger, {
      checkId,
      network: input.network,
      status: outcome.status,
      expected: outcome.expected,
      actual: outcome.actual,
      anchor: outcome.anchor,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    })

  return {
    ledger,
    verdict: summariseLedger(ledger),
    registered,
    gradedKey: proposalKeyOf({
      to: input.to,
      value: input.signedValue,
      data: input.data,
      operation: input.signedOperation,
      nonce: input.signedNonce,
    }),
  }
}

/**
 * The integrity verdict as lines to print, before any prompt offers to sign.
 *
 * A run that could not be produced at all still prints, because the refusal a
 * signer then hits needs its reason on screen; silence is not one of the
 * outcomes.
 * @param run - The completed run, or nothing when the assertions never ran.
 * @returns Lines to print.
 */
export const renderIntegrityAsserts = (
  run: IIntegrityAssertRun | undefined
): string[] => {
  if (!run)
    return [
      '    Proposal integrity:',
      `        \u001b[31m⛔ REFUSED\u001b[0m ${UNEVALUATED_REASON}`,
    ]

  const lines = ['    Proposal integrity:']
  const rollup = rollUpChecks(run.ledger)

  for (const check of rollup) {
    const results = check.results
    // Every registered check names itself even when it produced no result: a
    // check that did not run is the case the ledger blocks on, and it has no
    // row of its own to print.
    if (results.length === 0) {
      lines.push(
        `        \u001b[31m⛔ NOT RUN\u001b[0m ${gateLabel(check)} [${
          check.checkId
        }]`
      )
      continue
    }

    for (const result of results) {
      const bucket = STATUS_BUCKETS.get(result.status) ?? UNKNOWN_STATUS_BUCKET
      lines.push(
        `        \u001b[${bucket.colour}m${bucket.glyph} ${
          bucket.word
        }\u001b[0m ${gateLabel(check)} [${check.checkId}] (${result.anchor})`
      )
      if (result.status !== 'pass') {
        lines.push(`            expected ${result.expected}`)
        lines.push(`            actual   ${result.actual}`)
        if (result.detail) lines.push(`            ${result.detail}`)
      }
    }
  }

  // The checks a proposal did not register at all, named rather than implied:
  // a delay assertion that had nothing to say and one that was skipped by a
  // bug look identical in a report that only lists what ran.
  const notApplicable = Object.keys(INTEGRITY_CHECK_DEFINITIONS).filter(
    (checkId) => !run.registered.includes(checkId)
  )
  if (notApplicable.length > 0)
    lines.push(
      `        \u001b[36m· NO CLAIM\u001b[0m not registered for this proposal: ${notApplicable.join(
        ', '
      )}`
    )

  return lines
}

/**
 * Refuses a signature or a broadcast the integrity assertions do not permit.
 *
 * Placed as the statement after the codehash refusal inside each funnel, so a
 * codehash refusal still reports first and this one adds a second reason rather
 * than replacing it. It throws rather than returning a flag so a caller cannot
 * forget to read the answer.
 *
 * @param run - The run for the proposal about to be signed, or nothing.
 * @param key - The transaction actually reaching the signer, from `proposalKeyOf`.
 * @throws When the assertions block, or graded a different transaction.
 */
export const assertIntegrityAssertsAllowSigning = (
  run: IIntegrityAssertRun | undefined,
  key: string
): void => {
  // A verdict about another transaction is not a pass, so this decides
  // independently of `hardBlocked` — and an absent run decides on its own,
  // which is what makes "the assertions never ran" fail closed.
  const mismatched = run?.gradedKey !== key
  if (run && !mismatched && !run.verdict.hardBlocked) return

  const substitution = mismatched
    ? [
        run === undefined
          ? UNEVALUATED_REASON
          : `The integrity verdict is about a different transaction than the one now being signed — it graded ${run.gradedKey} and this is ${key}. A verdict only ever speaks for one transaction.`,
      ]
    : []

  const detail = (run?.verdict.blocking ?? []).map(
    (blocked) =>
      `${blocked.checkId} on ${blocked.network} is ${blocked.status}: ${
        blocked.reason
      }${blocked.anchor ? ` (${blocked.anchor})` : ''}`
  )

  throw new Error(
    [
      'Proposal integrity: this transaction will not be signed.',
      ...substitution,
      ...detail,
    ].join(' ')
  )
}
