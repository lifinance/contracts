/**
 * What a deployment's immutable VALUES were found to be, as a verdict of its
 * own. Gate L reads this; gate K does not.
 *
 * "Is this our code" and "does it run on the values we declare" are separate
 * questions. Every chain answers the first; only a chain that inlines its
 * immutables answers the second from the bytes alone. They are graded apart so
 * that a chain unable to answer the second still gets the first.
 *
 * So the second question is answered here, per address, and the mapping from
 * value to name is part of the answer rather than a precondition of it: on
 * EraVM the compiler does not record which immutable a simulator slot belongs
 * to, so the correspondence is derived from declaration order and is the one
 * thing a human is asked to confirm. A DISAGREEING value is never that: it was
 * read and compared, and it blocks wherever it is found.
 */

import type {
  IGradedImmutable,
  ImmutablePricing,
} from './immutable-expectations'
import { IMMUTABLE_SIMULATOR_ADDRESS } from './zk-immutables'

/**
 * - `none` — the contract declares no immutables, so there is nothing to grade.
 * - `verified` — every slot holds what this repo declares for it.
 * - `disagrees` — a slot holds something else. Blocks everywhere.
 * - `unpriced` — a slot was read and this repo declares no expectation for it.
 * - `documented` — the only slots without an expectation are ones the registry
 *   declares unverifiable or derived-but-not-computed, each with a written
 *   reason. A reviewed gap, not an unnoticed one.
 * - `assumed` — every value was read from a trusted source and agrees, but the
 *   slot-to-name mapping is not one the compiler confirmed.
 * - `unreadable` — nothing about the values could be established.
 */
export type ImmutableVerdictStatus =
  | 'none'
  | 'verified'
  | 'disagrees'
  | 'unpriced'
  | 'documented'
  | 'assumed'
  | 'unreadable'

export interface IImmutableVerdict {
  status: ImmutableVerdictStatus
  /** What a signer reads: one line, or the per-slot table an `assumed` needs. */
  detail: string
}

/**
 * What a chain keeping its immutables off the runtime code could report.
 *
 * `none` is separated from a pricing over an empty slot set because they are
 * opposite facts — a contract with no immutables has nothing to check, and a
 * read that returned nothing has not checked anything.
 */
export type IOffCodeImmutables =
  | { declared: 'none' }
  | {
      declared: 'some'
      pricing: ImmutablePricing
      /** Declared name → its position in declaration order, from 0. */
      slotByName: Readonly<Record<string, number>>
    }

/** @param address - The target the verdict is about. */
export const noImmutables = (address: string): IImmutableVerdict => ({
  status: 'none',
  detail: `${address}: the build of what this record names declares no immutables, so there are no values to compare against config.`,
})

/**
 * @param address - The target the verdict is about.
 * @param why - What could not be established, in the reporter's own words.
 */
export const immutablesUnreadable = (
  address: string,
  why: string
): IImmutableVerdict => ({
  status: 'unreadable',
  detail: `${address}: the values its immutables hold were not established — ${why}`,
})

/** @param slot - The graded slot to render as one line of the table. */
const slotLine = (
  slot: IGradedImmutable,
  index: number | undefined
): string => {
  const where = index === undefined ? slot.name : `slot ${index} ${slot.name}`
  if (slot.status === 'verified')
    return `${where}: holds ${slot.observed}, which is what ${
      slot.origin ?? 'config'
    } declares — match`
  if (slot.status === 'disagrees')
    return `${where}: holds ${slot.observed}, while ${
      slot.origin ?? 'config'
    } declares ${slot.expected ?? 'another value'} — MISMATCH`
  return `${where}: holds ${slot.observed}, and ${
    slot.detail ?? 'this repo declares no expectation for it'
  } — unchecked`
}

/**
 * @param pricing - A decided pricing.
 * @param slotByName - Slot index per name, when the reader addressed slots.
 */
const table = (
  slots: readonly IGradedImmutable[],
  slotByName: Readonly<Record<string, number>> | undefined
): string =>
  slots.map((slot) => slotLine(slot, slotByName?.[slot.name])).join('; ')

/**
 * Grades the values of a contract whose immutables are inlined in its code.
 *
 * The value is read out of the bytes gate K hashed and the expectation comes
 * from this checkout, so an outcome here is undecidable only where this repo
 * says so itself. A slot with no expectation is graded as unchecked rather than
 * as passing, because those are the two facts this gate exists to keep apart —
 * and `documented` is kept apart from `unpriced` for the same reason: a gap
 * someone reviewed and wrote down is not a gap nobody noticed.
 *
 * @param address - The target the verdict is about.
 * @param network - The network the expectations were resolved for.
 * @param pricing - What `priceImmutables` established.
 * @returns The verdict gate L records for this address.
 */
export const gradeInlinedImmutables = (
  address: string,
  network: string,
  pricing: ImmutablePricing
): IImmutableVerdict => {
  if (!pricing.decided) return immutablesUnreadable(address, pricing.reason)

  if (pricing.disagreements.length > 0)
    return {
      status: 'disagrees',
      detail: `${address}: ${
        pricing.disagreements.length
      } of its immutables hold a value this repo does not declare for ${network} — ${table(
        pricing.disagreements,
        undefined
      )}.`,
    }

  if (pricing.unpricedByteCount > 0)
    return {
      status: 'unpriced',
      detail: `${address}: ${
        pricing.unpricedByteCount
      } bytes of its immutables have no declared expectation to compare against — ${table(
        pricing.slots.filter((slot) => slot.status !== 'verified'),
        undefined
      )}.`,
    }

  if (pricing.acknowledgeableByteCount > 0)
    return {
      status: 'documented',
      detail: `${address}: ${
        pricing.acknowledgeableByteCount
      } bytes of its immutables are ones this repo states in writing it derives no expectation for, and every other value holds what it declares for ${network} — ${table(
        pricing.slots,
        undefined
      )}.`,
    }

  return {
    status: 'verified',
    detail: `${address}: every immutable holds the value this repo declares for ${network} — ${table(
      pricing.slots,
      undefined
    )}.`,
  }
}

/** A 32-byte word of zeroes, whatever casing or padding it arrived in. */
const isZeroWord = (value: string): boolean =>
  /^0x0*$/u.test(value.trim().toLowerCase())

/**
 * Grades the values of a contract whose immutables the simulator holds.
 *
 * The values are read; the name each slot belongs to is derived from
 * declaration order, which the compiler does not record and this cannot
 * confirm. So the best outcome available is `assumed`: the table below is what
 * the signer confirms, and confirming it is confirming the ordering as much as
 * the values.
 *
 * A disagreement is exempt from that and blocks outright. The ordering being
 * assumed makes a disagreement harder to attribute, not less real — and a
 * mis-ordered read is as likely to surface as a disagreement as a tampered
 * value is, so treating one as acknowledgeable would hand the same path to both.
 * A slot with no declared expectation blocks for the reason it does on the
 * inlined path: there is no statement for the signer to take on, and a table
 * showing its value would read as one.
 *
 * @param address - The target the verdict is about.
 * @param network - The network the expectations were resolved for.
 * @param read - What the simulator read established, with its slot numbering.
 * @returns The verdict gate L records for this address.
 */
export const gradeAssumedImmutables = (
  address: string,
  network: string,
  read: IOffCodeImmutables
): IImmutableVerdict => {
  if (read.declared === 'none') return noImmutables(address)
  const { pricing, slotByName } = read
  if (!pricing.decided) return immutablesUnreadable(address, pricing.reason)

  if (pricing.disagreements.length > 0)
    return {
      status: 'disagrees',
      detail: `${address}: ${
        pricing.disagreements.length
      } of its immutables hold a value this repo does not declare for ${network} — ${table(
        pricing.disagreements,
        slotByName
      )}. Slots are numbered from declaration order, so a disagreement can also mean the numbering is wrong; either way this is not the deployment this repo describes.`,
    }

  // `ImmutableSimulator.getImmutable` reverts for nothing — an address that
  // registered no immutables, and an index past the end of one that did, both
  // answer zero. So a zero carries no evidence that the slot was ever written,
  // and a set of them is indistinguishable from reading the wrong address.
  const zeros = pricing.slots.filter((one) => isZeroWord(one.observed))
  if (zeros.length === pricing.slots.length)
    return immutablesUnreadable(
      address,
      `every slot read zero, which is also what ${IMMUTABLE_SIMULATOR_ADDRESS} answers for an address that registered no immutables at all, so this read establishes nothing about ${address}`
    )

  if (pricing.unpricedByteCount > 0)
    return {
      status: 'unpriced',
      detail: `${address}: ${
        pricing.unpricedByteCount
      } bytes of its immutables have no declared expectation to compare against — ${table(
        pricing.slots.filter(
          (slot) =>
            slot.status === 'undeclared' || slot.status === 'unpriceable'
        ),
        slotByName
      )}.`,
    }

  return {
    status: 'assumed',
    detail: `${address}: this chain keeps its immutables in ImmutableSimulator, and each value below was read from it and compared against what config declares for ${network}. Which slot belongs to which name is taken from the order the contract declares them in — the compiler records no such mapping, and a constructor assigning them in another order would shift every slot. Confirming this row confirms that ordering as well as the values: ${table(
      pricing.slots,
      slotByName
    )}.${
      zeros.length > 0
        ? ` Not confirmed by this read: ${zeros
            .map((one) => one.name)
            .join(
              ', '
            )} — each holds zero, which the simulator also returns for a slot nothing ever wrote, so agreement there is not evidence. Check ${
            zeros.length === 1 ? 'it' : 'them'
          } against the contract's own getter.`
        : ''
    }`,
  }
}
