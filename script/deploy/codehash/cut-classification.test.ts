/**
 * Which addresses in a `diamondCut` the codehash gate must vouch for.
 *
 * The adversarial finding this encodes (A1) is that classification is
 * **per FacetCut element**, never per operation: a batch pairing one `Add` with
 * one `Remove` still has to gate the `Add`. Grading the whole cut by "it
 * contains a removal" is how an addition rides in on a deletion.
 *
 * And the mirror of it: a purely subtractive cut carrying `_init` calldata is
 * arbitrary code framed as a deletion, because `_init` is delegatecalled in the
 * diamond's own storage context whatever the cut's entries say.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { getAddress } from 'viem'

import { classifyCut, FacetCutActionEnum } from './cut-classification'

// Written lowercase and checksummed through viem, so the expectations are
// derived rather than hand-computed — a wrong hand-written checksum would make
// these assertions test the fixture instead of the code.
const A = getAddress('0x1111111111111111111111111111111111111111')
const B = getAddress('0x2222222222222222222222222222222222222222')
const INIT = getAddress('0x3333333333333333333333333333333333333333')
const ZERO = '0x0000000000000000000000000000000000000000'

const add = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Add,
})
const replace = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Replace,
})
const remove = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Remove,
})

describe('classifyCut', () => {
  it('gates an Add target', () => {
    const verdict = classifyCut({ cuts: [add(A)], init: ZERO })
    expect(verdict.refusals).toEqual([])
    expect(verdict.gated).toEqual([A])
  })

  it('gates a Replace target', () => {
    const verdict = classifyCut({ cuts: [replace(A)], init: ZERO })
    expect(verdict.gated).toEqual([A])
  })

  it('does not gate a Remove target, whose code stops being reachable', () => {
    const verdict = classifyCut({ cuts: [remove(A)], init: ZERO })
    expect(verdict.refusals).toEqual([])
    expect(verdict.gated).toEqual([])
  })

  it('gates the Add in a batch that also removes — A1, per element not per operation', () => {
    // The whole point. If the presence of a Remove downgraded the cut, an
    // addition would ride in on a deletion.
    const verdict = classifyCut({
      cuts: [add(A), remove(B)],
      init: ZERO,
    })
    expect(verdict.refusals).toEqual([])
    expect(verdict.gated).toEqual([A])
  })

  it('gates every additive element of a mixed batch, in first-seen order', () => {
    const verdict = classifyCut({
      cuts: [remove(B), add(A), remove(B), replace(INIT)],
      init: ZERO,
    })
    expect(verdict.gated).toEqual([A, INIT])
  })

  it('gates a non-zero _init alongside the facets, because it is delegatecalled', () => {
    const verdict = classifyCut({ cuts: [add(A)], init: INIT })
    expect(verdict.refusals).toEqual([])
    expect(verdict.gated).toEqual([A, INIT])
  })

  it('does not double-list an _init that is already a cut target', () => {
    const verdict = classifyCut({ cuts: [add(A)], init: A })
    expect(verdict.gated).toEqual([A])
  })

  it('REFUSES a removal-only cut that carries _init calldata', () => {
    // Arbitrary code framed as a deletion: `_init` runs against the diamond's
    // storage regardless of the entries saying only "remove".
    const verdict = classifyCut({ cuts: [remove(A)], init: INIT })
    expect(verdict.refusals).toHaveLength(1)
    expect(verdict.refusals[0]).toMatch(/removal-only cut carries an _init/)
    expect(verdict.gated).toEqual([])
  })

  it('refuses a cut with no entries at all but an _init', () => {
    // Nothing is being removed either, so the only effect is the delegatecall.
    const verdict = classifyCut({ cuts: [], init: INIT })
    expect(verdict.refusals).toHaveLength(1)
  })

  it('allows an empty cut with no _init as a no-op', () => {
    const verdict = classifyCut({ cuts: [], init: ZERO })
    expect(verdict.refusals).toEqual([])
    expect(verdict.gated).toEqual([])
  })

  it('refuses an action outside the three LibDiamond values', () => {
    // An unknown action is not a fourth behaviour to guess at: the diamond would
    // revert, but the classification must not silently treat it as a removal.
    const verdict = classifyCut({
      cuts: [{ facetAddress: A, action: 7 as FacetCutActionEnum }],
      init: ZERO,
    })
    expect(verdict.refusals).toHaveLength(1)
    expect(verdict.refusals[0]).toMatch(/action 7/)
  })

  it('refuses an Add whose target is the zero address', () => {
    // Zero is what a Remove entry carries; an Add to it is malformed, and
    // gating the zero address would look like a clean pass.
    const verdict = classifyCut({ cuts: [add(ZERO)], init: ZERO })
    expect(verdict.refusals).toHaveLength(1)
    expect(verdict.refusals[0]).toMatch(/zero address/)
    expect(verdict.gated).toEqual([])
  })

  it('normalises addresses so one target cannot appear twice by case', () => {
    const verdict = classifyCut({
      cuts: [add(A), add(A.toLowerCase())],
      init: ZERO,
    })
    expect(verdict.gated).toEqual([A])
  })

  it('reports every refusal rather than only the first', () => {
    // A signer fixing one and re-running should not discover the next one at a
    // time; and a caller that only shows the first would hide the rest.
    const verdict = classifyCut({
      cuts: [add(ZERO), { facetAddress: A, action: 9 as FacetCutActionEnum }],
      init: ZERO,
    })
    expect(verdict.refusals).toHaveLength(2)
  })
})
