/**
 * Recovers the `diamondCut` calls a Safe proposal's calldata carries, unwrapping
 * the timelock envelopes on the way down.
 *
 * Import this from any check that has to know what a proposal would do to a
 * diamond — the production deploy gate and the sign-time target-state check both
 * read it here, so the set of envelopes that can be seen through is enumerated
 * once instead of once per caller.
 */

import { decodeFunctionData, getAddress, isHex } from 'viem'
import { toFunctionSelector, type Address, type Hex } from 'viem'

import {
  TIMELOCK_SCHEDULE_ABI,
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_SCHEDULE_BATCH_SELECTOR,
  TIMELOCK_SCHEDULE_SELECTOR,
} from '../safe/timelock-abi'

import { DIAMOND_CUT_ABI } from './constants'

export const DIAMOND_CUT_SELECTOR = toFunctionSelector(
  'diamondCut((address,uint8,bytes4[])[],address,bytes)'
).toLowerCase() as Hex

/**
 * Whether the cut selector appears in `data` on a byte boundary.
 *
 * Alignment is necessary but not sufficient: only an even offset can be a
 * selector, yet an address or other argument can carry the same four bytes at
 * one. So this narrows the false-refusal class rather than closing it, which is
 * why a caller's refusal message should name a coincidence as a possible cause.
 * @param data - calldata to search
 * @returns Whether the four bytes occur at an even offset.
 */
const carriesCutSelectorAligned = (data: Hex): boolean => {
  const body = data.slice(2).toLowerCase()
  const needle = DIAMOND_CUT_SELECTOR.slice(2)
  for (
    let at = body.indexOf(needle);
    at !== -1;
    at = body.indexOf(needle, at + 1)
  )
    if (at % 2 === 0) return true
  return false
}

/**
 * How many `scheduleBatch` layers to unwrap. The funnel wraps a cut itself, so a
 * caller handing in a pre-wrapped payload is the shape this has to see through;
 * the bound stops a self-referential payload from spinning.
 */
export const MAX_UNWRAP_DEPTH = 4

/** One `(facetAddress, action)` pair of a `diamondCut`. */
export interface IDiamondCutEntry {
  facetAddress: Address
  /** `LibDiamond.FacetCutAction`: Add=0, Replace=1, Remove=2. */
  action: number
}

/** One decoded `diamondCut` call, and where in the proposal it was reached. */
export interface IDiamondCutCall {
  /** Index of the top-level call this cut was reached from. */
  callIndex: number
  cuts: readonly IDiamondCutEntry[]
  /** The cut's `_init` delegatecall target; zero when the update carries no init calldata. */
  init: Address
}

/** What a proposal's calls turned out to contain. */
export interface ICollectedDiamondCuts {
  /** Decoded cuts in the order they were reached, depth-first through envelopes. */
  calls: IDiamondCutCall[]
  /**
   * Indices of calls carrying a cut selector this cannot see all the way
   * through — arguments that do not decode, or `scheduleBatch` nested past
   * {@link MAX_UNWRAP_DEPTH}. Reported rather than skipped: a cut we cannot read
   * is a cut we cannot vouch for, and calldata is written by the proposer.
   */
  undecodable: number[]
}

const decodeCut = (
  data: Hex
): { cuts: readonly IDiamondCutEntry[]; init: Address } => {
  const { args } = decodeFunctionData({ abi: DIAMOND_CUT_ABI, data })
  return {
    cuts: (
      args[0] as readonly { facetAddress: Address; action: unknown }[]
    ).map((entry) => ({
      facetAddress: getAddress(entry.facetAddress),
      action: Number(entry.action),
    })),
    init: args[1] as Address,
  }
}

const decodeScheduleBatch = (data: Hex): readonly Hex[] => {
  const { args } = decodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    data,
  })
  return args[2] as readonly Hex[]
}

const decodeSchedule = (data: Hex): readonly Hex[] => {
  const { args } = decodeFunctionData({ abi: TIMELOCK_SCHEDULE_ABI, data })
  return [args[2] as Hex]
}

/**
 * Reads every `diamondCut` a proposal's calls would reach, unwrapping timelock
 * envelopes on the way down.
 * @param calldatas - the proposal's calls, in the order they were passed
 * @returns The decoded cuts, plus the indices of calls this could not read
 * through.
 */
export const collectDiamondCutCalls = (
  calldatas: readonly Hex[]
): ICollectedDiamondCuts => {
  const calls: IDiamondCutCall[] = []
  const undecodable = new Set<number>()

  const walk = (data: Hex, index: number, depth: number): void => {
    const selector = data.slice(0, 10).toLowerCase()

    if (selector === DIAMOND_CUT_SELECTOR) {
      let decoded
      try {
        decoded = decodeCut(data)
      } catch {
        undecodable.add(index)
        return
      }
      calls.push({ callIndex: index, cuts: decoded.cuts, init: decoded.init })
      return
    }

    const unwrap =
      selector === TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()
        ? decodeScheduleBatch
        : selector === TIMELOCK_SCHEDULE_SELECTOR.toLowerCase()
        ? decodeSchedule
        : undefined

    if (unwrap) {
      if (depth >= MAX_UNWRAP_DEPTH) {
        undecodable.add(index)
        return
      }
      let payloads
      try {
        payloads = unwrap(data)
      } catch {
        undecodable.add(index)
        return
      }
      for (const payload of payloads) walk(payload, index, depth + 1)
      return
    }

    // An envelope this cannot open. Only the wrappers above are unwrapped, so
    // any other — `multiSend`, a bespoke batcher — hides whatever it carries. A
    // call is refused on its own bytes, never on its siblings': a batch pairing
    // one readable cut with one unreadable envelope must not pass because the
    // readable half decoded.
    //
    // The reach of this is exactly "the selector, verbatim and byte-aligned".
    // An envelope that splits or transforms it — two `bytes2` halves reassembled
    // on chain, a payload rebuilt from a perturbed copy — is not caught, and
    // needs a bespoke batcher the Safe would have to be pointed at.
    if (carriesCutSelectorAligned(data)) undecodable.add(index)
  }

  calldatas.forEach((data, index) => {
    // Every selector and offset below is read positionally off a `0x` prefix, so
    // input that is not well-formed calldata would be silently skipped rather
    // than examined. The funnels validate before calling, but `sendOrPropose`
    // does not, and a skip here is a pass.
    if (!isHex(data, { strict: true }) || data.length % 2 !== 0)
      undecodable.add(index)
    else walk(data, index, 0)
  })

  return { calls, undecodable: [...undecodable] }
}
