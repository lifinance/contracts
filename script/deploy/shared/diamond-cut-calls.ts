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

/** One `(facetAddress, action, selectors)` triple of a `diamondCut`. */
export interface IDiamondCutEntry {
  facetAddress: Address
  /** `LibDiamond.FacetCutAction`: Add=0, Replace=1, Remove=2. */
  action: number
  /** The four-byte selectors this cut moves, lowercase. */
  selectors: readonly Hex[]
}

/** One decoded `diamondCut` call, and where in the proposal it was reached. */
export interface IDiamondCutCall {
  /** Index of the top-level call this cut was reached from. */
  callIndex: number
  cuts: readonly IDiamondCutEntry[]
  /** The cut's `_init` delegatecall target; zero when the update carries no init calldata. */
  init: Address
  /** `_calldata` as hex. `0x` means the update carries no init calldata. */
  initCalldata: Hex
  /**
   * The exact `diamondCut` calldata, as it will reach the diamond.
   *
   * Kept because a cut inside a timelock envelope is never sent by the Safe:
   * simulating it means replaying these bytes from the timelock, and the
   * proposal's own top-level calldata only schedules it.
   */
  raw: Hex
  /**
   * The diamond this cut executes against, when the caller supplied the
   * top-level targets. Absent otherwise: a caller that only hands in calldata
   * cannot be told which address it was sent to, and inventing one would put an
   * address into a verdict that nothing observed.
   */
  target?: Address
  /**
   * The account the diamond sees as `msg.sender` — the Safe for a direct call,
   * the timelock for anything reached by unwrapping one of its envelopes.
   * Absent under the same condition as {@link IDiamondCutCall.target}.
   */
  caller?: Address
}

/** Where a proposal's top-level calls were sent, so a cut can name its diamond. */
export interface IDiamondCutCallContext {
  /** The address each top-level call in `calldatas` was sent to, by index. */
  targets: readonly Address[]
  /** The account that sends the top-level calls: the Safe. */
  caller: Address
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
): {
  cuts: readonly IDiamondCutEntry[]
  init: Address
  initCalldata: Hex
} => {
  const { args } = decodeFunctionData({ abi: DIAMOND_CUT_ABI, data })
  return {
    cuts: (
      args[0] as readonly {
        facetAddress: Address
        action: unknown
        functionSelectors?: readonly Hex[]
      }[]
    ).map((entry) => ({
      facetAddress: getAddress(entry.facetAddress),
      action: Number(entry.action),
      selectors: (entry.functionSelectors ?? []).map(
        (selector) => selector.toLowerCase() as Hex
      ),
    })),
    init: args[1] as Address,
    initCalldata: (args[2] as Hex) ?? '0x',
  }
}

/** One unwrapped inner call: its payload and the address it will be sent to. */
interface IUnwrappedCall {
  payload: Hex
  target?: Address
}

const decodeScheduleBatch = (data: Hex): readonly IUnwrappedCall[] => {
  const { args } = decodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    data,
  })
  const targets = args[0] as readonly Address[]
  return (args[2] as readonly Hex[]).map((payload, at) => ({
    payload,
    ...(targets[at] === undefined ? {} : { target: getAddress(targets[at]) }),
  }))
}

const decodeSchedule = (data: Hex): readonly IUnwrappedCall[] => {
  const { args } = decodeFunctionData({ abi: TIMELOCK_SCHEDULE_ABI, data })
  return [{ payload: args[2] as Hex, target: getAddress(args[0] as Address) }]
}

/** The decoder for a timelock envelope, or nothing when this is not one. */
const unwrapperFor = (
  selector: string
): ((data: Hex) => readonly IUnwrappedCall[]) | undefined =>
  selector === TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()
    ? decodeScheduleBatch
    : selector === TIMELOCK_SCHEDULE_SELECTOR.toLowerCase()
    ? decodeSchedule
    : undefined

/** One call a proposal really makes, after every timelock envelope is opened. */
export interface IScheduledCall {
  /** Index of the top-level call this was reached from. */
  callIndex: number
  /** The calldata as it will reach {@link IScheduledCall.target}. */
  payload: Hex
  target?: Address
  /**
   * The account the target sees as `msg.sender`: the Safe for a direct call,
   * the timelock for anything reached by opening one of its envelopes.
   */
  caller?: Address
  /** How many envelopes were opened to reach it. Zero is the top-level call. */
  depth: number
}

export interface ICollectedScheduledCalls {
  calls: IScheduledCall[]
  undecodable: number[]
}

/**
 * Every call a proposal would make, whatever its selector.
 *
 * `collectDiamondCutCalls` answers the narrower question — it stops at a cut
 * and reports nothing about the rest — which is right for the checks that grade
 * cuts and wrong for a simulator. A `registerPeripheryContract` scheduled
 * through the timelock is owner-gated exactly as a cut is, and simulating the
 * proposal's own top-level calldata only proves the timelock would accept the
 * schedule: the call that has to work is the inner one, sent by the timelock in
 * two days' time.
 *
 * Kept beside the cut walker rather than folded into it: four checks read that
 * one, and widening what it returns would change what each of them grades.
 *
 * @param calldatas - The proposal's top-level calls, in order.
 * @param context - Where each top-level call is sent, and who sends it.
 * @returns Every leaf call reached, plus the indices of calls that could not be
 * read through.
 */
export const collectScheduledCalls = (
  calldatas: readonly Hex[],
  context?: IDiamondCutCallContext
): ICollectedScheduledCalls => {
  const calls: IScheduledCall[] = []
  const undecodable = new Set<number>()

  const walk = (
    data: Hex,
    index: number,
    depth: number,
    target: Address | undefined,
    caller: Address | undefined
  ): void => {
    const unwrap = unwrapperFor(data.slice(0, 10).toLowerCase())

    if (!unwrap) {
      calls.push({
        callIndex: index,
        payload: data,
        depth,
        ...(target === undefined ? {} : { target }),
        ...(caller === undefined ? {} : { caller }),
      })
      return
    }

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

    // An envelope carrying nothing is reported rather than dropped: a schedule
    // with an empty batch is a proposal that spends a threshold of signatures
    // to do nothing, and a walker that returned no leaves for it would leave
    // the simulation with nothing to say about the whole proposal.
    if (payloads.length === 0) {
      undecodable.add(index)
      return
    }

    // The envelope's own address becomes `msg.sender` for everything it
    // carries.
    for (const inner of payloads)
      walk(inner.payload, index, depth + 1, inner.target, target)
  }

  calldatas.forEach((data, index) => {
    if (!isHex(data, { strict: true }) || data.length % 2 !== 0)
      undecodable.add(index)
    else walk(data, index, 0, context?.targets[index], context?.caller)
  })

  return { calls, undecodable: [...undecodable] }
}

/**
 * Reads every `diamondCut` a proposal's calls would reach, unwrapping timelock
 * envelopes on the way down.
 * @param calldatas - the proposal's calls, in the order they were passed
 * @param context - The target and sender to stamp on every call, when the
 * caller knows them. Absent, each result leaves both fields unset rather than
 * naming an address nothing observed.
 * @returns The decoded cuts, plus the indices of calls this could not read
 * through.
 */
export const collectDiamondCutCalls = (
  calldatas: readonly Hex[],
  context?: IDiamondCutCallContext
): ICollectedDiamondCuts => {
  const calls: IDiamondCutCall[] = []
  const undecodable = new Set<number>()

  const walk = (
    data: Hex,
    index: number,
    depth: number,
    target: Address | undefined,
    caller: Address | undefined
  ): void => {
    const selector = data.slice(0, 10).toLowerCase()

    if (selector === DIAMOND_CUT_SELECTOR) {
      let decoded
      try {
        decoded = decodeCut(data)
      } catch {
        undecodable.add(index)
        return
      }
      calls.push({
        callIndex: index,
        cuts: decoded.cuts,
        init: decoded.init,
        initCalldata: decoded.initCalldata,
        raw: data,
        ...(target === undefined ? {} : { target }),
        ...(caller === undefined ? {} : { caller }),
      })
      return
    }

    const unwrap = unwrapperFor(selector)

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
      // The envelope's own address becomes `msg.sender` for everything it
      // carries: a timelock batch executes its calls itself, so a cut reached
      // this way is owner-gated against the timelock, never against the Safe.
      for (const inner of payloads)
        walk(inner.payload, index, depth + 1, inner.target, target)
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
    else walk(data, index, 0, context?.targets[index], context?.caller)
  })

  return { calls, undecodable: [...undecodable] }
}
