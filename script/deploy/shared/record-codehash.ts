/**
 * Decides which codehash a deployment record may carry. Import it wherever a
 * record is written after a deploy has been checked against its own artifact.
 *
 * The recorded value reports; it never decides. A record is written by whoever
 * ran the deploy, so a later check that trusts this field is trusting the
 * proposer — it has to recompute from the chain and use the record only to say
 * what was observed at deploy time, and by whom.
 */

import type { IObservedCode } from '../codehash/attested-set'
import type { SelfCheckOutcome } from '../codehash/deploy-self-check'

/** keccak digest, with or without the `0x` the caller happens to use. */
const DIGEST = /^(0x)?[0-9a-f]{64}$/i

/**
 * The self-check outcomes that establish a codehash worth recording, named by
 * what may proceed rather than by what may not.
 *
 * `PASS` and `CONFIRM` both mean the code at the address is the artifact this
 * run built — they differ only on whether it also matches an attested build of
 * main, which is a sign-time question and not a claim about the deployed bytes.
 * Anything outside this set, including any outcome added later, records nothing.
 *
 * A `Set`, not an object literal: a plain object also answers for `constructor`
 * and `__proto__`.
 */
const OUTCOMES_WITH_VERIFIED_CODEHASH: ReadonlySet<SelfCheckOutcome> = new Set([
  'PASS',
  'CONFIRM',
])

/** What a deployment record stores about the code found at its address. */
export interface IRecordedCodehash {
  /** keccak of the exact runtime bytes at the address, `0x` and lower-case. */
  hash: string
  /**
   * keccak after the metadata trailer came off and immutables were masked, the
   * form a later rebuild can be compared on.
   */
  maskedHash: string
  /**
   * Runtime code length as deployed, before anything was stripped or masked.
   * Stored with the hashes rather than derivable from them: the trailer's own
   * length word says how much `maskedHash` removes, so equal masked hashes do
   * not mean equal code unless the length is pinned too.
   */
  byteLength: number
  /**
   * Bytes excluded from `maskedHash` as immutables. Nonzero means `maskedHash`
   * says nothing about their values.
   */
  maskedByteCount: number
}

export type CodehashRecordDecision =
  | { recordable: true; codehash: IRecordedCodehash }
  | { recordable: false; reason: string }

/**
 * A decision plus the case where no codehash was offered at all, tagged so a
 * caller discriminates on a field every member declares.
 */
export type CodehashInputDecision =
  | { requested: false }
  | { requested: true; recordable: true; codehash: IRecordedCodehash }
  | { requested: true; recordable: false; reason: string }

const canonical = (digest: string): string =>
  `0x${digest.replace(/^0x/i, '').toLowerCase()}`

const isByteCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

/**
 * Validates and canonicalises the four values a record may store as one group.
 *
 * All four or none: a masked hash without the byte length it was taken at is
 * the shape that let appended bytes normalise to an honest prefix, and a group
 * that is only partly present would store exactly that.
 *
 * Validation runs on the values as given. Canonicalising for storage happens
 * after they have been accepted, so no input is repaired into passing.
 *
 * @param input - The observed values, from a caller that read the chain.
 * @returns The group to store, or why nothing may be stored.
 */
export const recordedCodehash = (input: {
  hash: string
  maskedHash: string
  byteLength: number
  maskedByteCount: number
}): CodehashRecordDecision => {
  if (!DIGEST.test(input.hash))
    return {
      recordable: false,
      reason: `'${input.hash}' is not a keccak digest, so it is not a codehash of anything`,
    }

  if (!DIGEST.test(input.maskedHash))
    return {
      recordable: false,
      reason: `'${input.maskedHash}' is not a keccak digest, so it is not a masked codehash of anything`,
    }

  // Zero is what an address holding no code reports, and what an unread
  // artifact reports; recording it as a length would make either look answered.
  if (!isByteCount(input.byteLength) || input.byteLength === 0)
    return {
      recordable: false,
      reason: `a deployed code length of ${input.byteLength} describes no code`,
    }

  if (!isByteCount(input.maskedByteCount))
    return {
      recordable: false,
      reason: `${input.maskedByteCount} is not a count of masked bytes`,
    }

  if (input.maskedByteCount > input.byteLength)
    return {
      recordable: false,
      reason: `${input.maskedByteCount} bytes cannot have been masked out of ${input.byteLength}`,
    }

  return {
    recordable: true,
    codehash: {
      hash: canonical(input.hash),
      maskedHash: canonical(input.maskedHash),
      byteLength: input.byteLength,
      maskedByteCount: input.maskedByteCount,
    },
  }
}

/** Digits only: `Number('12abc')` is NaN but `parseInt` would answer 12. */
const parseByteCount = (value: string): number | undefined =>
  /^[0-9]+$/.test(value) ? Number(value) : undefined

/**
 * The codehash a CLI caller's arguments describe.
 *
 * @param input - The four values as given, each absent when the flag was not
 * passed. An absent flag reaching this as an empty string is treated as absent.
 * @returns `{ requested: false }` when none were passed, otherwise the group to
 * store or why nothing may be stored. A partly-passed group is never stored:
 * the four are one claim.
 */
export const codehashFromArgs = (input: {
  hash: string | undefined
  maskedHash: string | undefined
  byteLength: string | undefined
  maskedByteCount: string | undefined
}): CodehashInputDecision => {
  const given = Object.entries(input).filter(
    ([, value]) => value !== undefined && value !== ''
  )
  if (given.length === 0) return { requested: false }

  const missing = Object.keys(input).filter(
    (name) => !given.some(([provided]) => provided === name)
  )
  if (missing.length > 0)
    return {
      requested: true,
      recordable: false,
      reason: `a codehash is stored as one group and ${missing.join(', ')} ${
        missing.length === 1 ? 'was' : 'were'
      } not provided`,
    }

  const byteLength = parseByteCount(input.byteLength ?? '')
  const maskedByteCount = parseByteCount(input.maskedByteCount ?? '')
  if (byteLength === undefined || maskedByteCount === undefined)
    return {
      requested: true,
      recordable: false,
      reason: `byte counts must be whole numbers, got '${String(
        input.byteLength
      )}' and '${String(input.maskedByteCount)}'`,
    }

  const decision = recordedCodehash({
    hash: input.hash ?? '',
    maskedHash: input.maskedHash ?? '',
    byteLength,
    maskedByteCount,
  })
  return decision.recordable
    ? { requested: true, recordable: true, codehash: decision.codehash }
    : { requested: true, recordable: false, reason: decision.reason }
}

/**
 * The codehash a record may carry after a post-deploy self-check.
 *
 * Never refuses a deploy and never refuses a record: it runs after the
 * irreversible step, where a refusal would turn a codehash this could not
 * accept into a deployment with no record at all. The deploy-blocking verdict
 * belongs to `evaluateDeploySelfCheck` and to the pre-deploy gates.
 *
 * @param observed - The code found at the deployed address, normalised.
 * @param outcome - The self-check's verdict on that address.
 * @returns The group to store, or why the record carries no codehash.
 */
export const codehashFromSelfCheck = (
  observed: IObservedCode,
  outcome: SelfCheckOutcome
): CodehashRecordDecision => {
  if (!OUTCOMES_WITH_VERIFIED_CODEHASH.has(outcome))
    return {
      recordable: false,
      reason: `the self-check returned ${outcome}, which does not establish that the deployed code is the artifact this run built`,
    }

  return recordedCodehash({
    hash: observed.rawHash,
    maskedHash: observed.maskedHash,
    byteLength: observed.rawByteLength,
    maskedByteCount: observed.maskedByteCount,
  })
}
