/**
 * Reads a zkEVM contract's immutables out of `ImmutableSimulator`.
 *
 * On EVM and Tron, immutables are inlined into runtime code and
 * `immutable-offsets.ts` masks and reads them there. zkEVM does not inline
 * them: the values live in a system contract and are addressed by ordinal.
 *
 * The ordinal is an input, never inferred. The spike measured
 * index = declaration-ordinal x 32 on three real contracts, but its own caveat
 * is that a constructor assigning immutables out of declaration order breaks
 * that correspondence — and reading the wrong slot means checking one
 * immutable's value against another's expectation, which passes. So the mapping
 * comes from compiler metadata via the caller, and its absence is a refusal
 * (adversarial F11).
 */

import type { IImmutableDeclaration } from '../immutables/immutable-ast'

/** zkEVM system contract holding immutables, measured in the spike. */
export const IMMUTABLE_SIMULATOR_ADDRESS =
  '0x0000000000000000000000000000000000008005'

/** Bytes per immutable slot: the index is the ordinal scaled by this. */
const SLOT_BYTES = 32

export interface IZkImmutablesRead {
  ok: true
  /** Declared name → the 32-byte word the simulator holds, `0x`-prefixed. */
  values: Record<string, string>
}

export interface IZkImmutablesRefused {
  ok: false
  reason: string
}

export interface IZkImmutablesInput {
  /** The contract whose immutables are being read. */
  address: string
  /**
   * Declared name → declaration ordinal, from compiler metadata or the
   * attestation sidecar. Never derived from a bare re-read of the source.
   */
  ordinals: Record<string, number>
  /**
   * `ImmutableSimulator.getImmutable(address, index)`, injected so the policy is
   * testable without a chain. Must reject rather than return a zero when the
   * read fails — a genuine zero is a legitimate immutable value here.
   */
  getImmutable: (address: string, index: number) => Promise<string>
}

/**
 * Reads every declared immutable by ordinal.
 * @param input - the contract, its ordinal map, and the simulator reader
 * @returns One value per declared name, or why nothing can be reported
 */
export const readZkImmutables = async (
  input: IZkImmutablesInput
): Promise<IZkImmutablesRead | IZkImmutablesRefused> => {
  const names = Object.keys(input.ordinals)
  if (names.length === 0)
    return {
      ok: false,
      reason:
        'zk immutables: no immutable ordinals were supplied, so there is nothing to read them by. Falling back to source declaration order is deliberately not done — a constructor that assigns out of declaration order would make every read address the wrong slot, and a value checked against the wrong expectation passes.',
    }

  const byOrdinal = new Map<number, string>()
  for (const name of names) {
    const ordinal = input.ordinals[name] as number
    if (!Number.isInteger(ordinal) || ordinal < 0)
      return {
        ok: false,
        reason: `zk immutables: "${name}" has ${ordinal}, which is not a whole ordinal, so no slot index follows from it.`,
      }
    const clash = byOrdinal.get(ordinal)
    if (clash !== undefined)
      return {
        ok: false,
        reason: `zk immutables: "${name}" and "${clash}" both claim the same ordinal ${ordinal}, so at least one would be checked against a value that is not its own.`,
      }
    byOrdinal.set(ordinal, name)
  }

  const values: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >
  for (const [ordinal, name] of [...byOrdinal.entries()].sort(
    (a, b) => a[0] - b[0]
  ))
    try {
      values[name] = await input.getImmutable(
        input.address,
        ordinal * SLOT_BYTES
      )
    } catch (error) {
      return {
        ok: false,
        reason: `zk immutables: "${name}" at ordinal ${ordinal} could not be read from ${IMMUTABLE_SIMULATOR_ADDRESS}: ${
          error instanceof Error ? error.message : String(error)
        }. Reported rather than defaulted, because zero is a value a contract can legitimately hold here.`,
      }
    }

  return { ok: true, values }
}

export interface IZkImmutableOrdinals {
  ok: true
  /** Declared name → its position in declaration order, from 0. */
  ordinals: Record<string, number>
}

/**
 * Numbers a contract's immutables the way the simulator is assumed to index
 * them: declaration order, from zero.
 *
 * The assumption this rests on is not one the compiler confirms. zksolc assigns
 * an index when the constructor ASSIGNS an immutable, and a constructor that
 * assigns out of declaration order shifts every index from that point on — the
 * AST reports where each one is declared and never where it is written to, so
 * nothing here can detect it. A shifted index reads one immutable's value and
 * compares it against another's expectation, which passes. That is why a
 * verdict built on this is put to a human rather than believed.
 *
 * {@link readImmutableDeclarations} reports only a contract's own declarations,
 * while the simulator indexes inherited ones too, in C3-linearized order — so an
 * immutable declared in a base contract would occupy an index this numbering
 * never accounts for. No contract under `src/` declares one today, so this is
 * latent rather than live; the single-contract refusal below is not a substitute
 * for it, because the inherited declaration never reaches this function at all.
 *
 * @param declarations - One contract's immutable declarations, from the AST.
 * @returns The ordinal per name, or why no numbering follows from the input.
 */
export const zkImmutableOrdinals = (
  declarations: readonly IImmutableDeclaration[]
): IZkImmutableOrdinals | IZkImmutablesRefused => {
  if (declarations.length === 0)
    return {
      ok: false,
      reason:
        'zk immutable ordinals: no immutable declarations were supplied, so there is nothing to number.',
    }

  const contracts = [...new Set(declarations.map((one) => one.contract))]
  if (contracts.length > 1)
    return {
      ok: false,
      reason: `zk immutable ordinals: the declarations span ${contracts.join(
        ', '
      )}, and each contract is indexed from its own zero — numbering them together would give one contract's slot to another's name.`,
    }

  const byLine = new Map<number, string>()
  const byName = new Set<string>()
  for (const one of declarations) {
    const clash = byLine.get(one.line)
    if (clash !== undefined)
      return {
        ok: false,
        reason: `zk immutable ordinals: "${one.name}" and "${clash}" are both recorded at line ${one.line}, so declaration order does not order them and either could take the other's index.`,
      }
    if (byName.has(one.name))
      return {
        ok: false,
        reason: `zk immutable ordinals: "${one.name}" is declared more than once, so a value read for it cannot be attributed to one declaration.`,
      }
    byLine.set(one.line, one.name)
    byName.add(one.name)
  }

  const ordinals: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >
  ;[...declarations]
    .sort((a, b) => a.line - b.line)
    .forEach((one, index) => {
      ordinals[one.name] = index
    })

  return { ok: true, ordinals }
}
