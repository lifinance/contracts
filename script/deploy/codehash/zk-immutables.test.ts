/**
 * Layer 2 on zkEVM. Immutables are not inlined into runtime code there, so the
 * offset masking `immutable-offsets.ts` does has nothing to bite on: the values
 * live in `ImmutableSimulator` and are read by ordinal.
 *
 * The property under test is F11 — that the ordinal is never *assumed*. The
 * spike measured index = declaration-ordinal × 32 on three contracts, but its
 * own caveat is that a constructor assigning immutables out of declaration order
 * would break that, and reading the wrong slot means checking a value against
 * another immutable's expectation. That is a false GREEN, so the ordinal is an
 * input here and its absence is a refusal.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { IMMUTABLE_SIMULATOR_ADDRESS, readZkImmutables } from './zk-immutables'

const DIAMOND = '0x1111111111111111111111111111111111111111'
const WORD = (hex: string) => `0x${hex.padStart(64, '0')}`

/** Measured on `LayerSwapFacet` (zksync) — 10c §3.5. */
const LAYERSWAP = {
  ordinals: { LAYERSWAP_DEPOSITORY: 0, BACKEND_SIGNER: 1 },
  slots: {
    0: WORD('e226594f'),
    32: WORD('af4b800fc5'),
  } as Record<number, string>,
}

const readerFrom = (
  slots: Record<number, string>,
  seen?: { index: number; address: string }[]
) => {
  return async (address: string, index: number): Promise<string> => {
    seen?.push({ index, address })
    const value = slots[index]
    if (value === undefined) throw new Error(`no slot at ${index}`)
    return value
  }
}

describe('readZkImmutables', () => {
  it('reads each immutable at ordinal x 32, the measured index', async () => {
    const seen: { index: number; address: string }[] = []
    const result = await readZkImmutables({
      address: DIAMOND,
      ordinals: LAYERSWAP.ordinals,
      getImmutable: readerFrom(LAYERSWAP.slots, seen),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values).toEqual({
      LAYERSWAP_DEPOSITORY: WORD('e226594f'),
      BACKEND_SIGNER: WORD('af4b800fc5'),
    })
    // ordinal 1 must be asked for at byte index 32, not at 1
    expect(seen.map((s) => s.index).sort((a, b) => a - b)).toEqual([0, 32])
    expect(seen.every((s) => s.address === DIAMOND)).toBe(true)
  })

  it('refuses when no ordinal map is supplied, instead of assuming source order', async () => {
    // The F11 refusal. A fallback to declaration order is the one thing this
    // module must never do, because it is silent and wrong in exactly the case
    // the spike flagged.
    const result = await readZkImmutables({
      address: DIAMOND,
      ordinals: {},
      getImmutable: readerFrom(LAYERSWAP.slots),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/no immutable ordinals/)
  })

  it('refuses a negative or non-integer ordinal rather than computing an index from it', async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await readZkImmutables({
        address: DIAMOND,
        ordinals: { SOMETHING: bad },
        getImmutable: readerFrom(LAYERSWAP.slots),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/not a whole ordinal/)
    }
  })

  it('refuses when two immutables claim the same ordinal', async () => {
    // Two names at one slot means one of them is being checked against a value
    // that is not its own.
    const result = await readZkImmutables({
      address: DIAMOND,
      ordinals: { A: 0, B: 0 },
      getImmutable: readerFrom(LAYERSWAP.slots),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/same ordinal/)
  })

  it('refuses when the simulator cannot be read, rather than reporting a zero', async () => {
    // A missing slot read as 0x0 would be indistinguishable from a real zero
    // immutable — and 10c measured two genuine zeros on SymbiosisFacet, so zero
    // is a legitimate value here and cannot double as an error.
    const result = await readZkImmutables({
      address: DIAMOND,
      ordinals: { PRESENT: 0, MISSING: 9 },
      getImmutable: readerFrom(LAYERSWAP.slots),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/MISSING/)
      expect(result.reason).toMatch(/could not be read/)
    }
  })

  it('keeps a genuine zero as a value', async () => {
    // SymbiosisFacet holds 0x0 at ordinals 2 and 3 legitimately (the syBTC path
    // is unsupported on zksync), so a zero must survive as data.
    const result = await readZkImmutables({
      address: DIAMOND,
      ordinals: { onchainSwapV3: 2 },
      getImmutable: readerFrom({ 64: WORD('0') }),
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.values.onchainSwapV3).toBe(WORD('0'))
  })

  it('names the simulator address the spike measured', () => {
    // Pinned because it is a system contract: a wrong address would read zeros
    // from an empty account and look like a contract with no immutables set.
    expect(IMMUTABLE_SIMULATOR_ADDRESS).toBe(
      '0x0000000000000000000000000000000000008005'
    )
  })
})
