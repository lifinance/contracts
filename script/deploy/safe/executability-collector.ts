/**
 * Gathers the chain reads `evaluateExecutability` decides from.
 *
 * Import this from a script that has a pending proposal and an RPC endpoint;
 * it turns one Safe transaction into the {@link IExecutabilityInput} the
 * simulation grades. The reads are behind {@link IExecutabilityChainReader} so
 * the assembly can be exercised without a node.
 *
 * Nothing here decides anything. A read that answers with nothing is left
 * absent rather than defaulted, because the simulation grades an absent
 * observation as unchecked and an unchecked observation as an error: a collector
 * that filled in a plausible value would convert "nobody asked" into "the chain
 * said yes".
 *
 * That holds per read, including an unparseable address: every parse goes
 * through one guard, so a malformed diamond leaves its own read absent instead
 * of rejecting the batch that carries the others. Absent still grades as
 * unchecked and blocks, so nothing is softened — the other reads simply survive
 * to be reported alongside it.
 */

import {
  decodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type CallParameters,
  type Hex,
  type PublicClient,
} from 'viem'

import { redactUrls } from '../../utils/redactUrls'
import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_SCHEDULE_BATCH_SELECTOR,
} from './timelock-abi'
import { ZERO_ADDRESS } from '../shared/constants'
import {
  collectDiamondCutCalls,
  collectScheduledCalls,
  DIAMOND_CUT_SELECTOR,
  type IDiamondCutCall,
  type IScheduledCall,
} from '../shared/diamond-cut-calls'

import {
  FacetCutActionEnum,
  type IChainObservations,
  type IDiamondCutPayload,
  type IExecutabilityInput,
  type IStaticCallObservation,
  type TSimulatedPayload,
} from './executability-simulation'

const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4 _functionSelector) view returns (address)',
])

const OWNER_ABI = parseAbi(['function owner() view returns (address)'])

/** Calldata that opens with a 4-byte function selector. */
const FUNCTION_SELECTOR = /^0x[0-9a-f]{8}/iu

/**
 * The reads one verdict needs.
 *
 * The three value reads return `undefined` when they could not be made;
 * `staticCall` carries that in the observation's own outcome instead, because a
 * call that reverted and a call that could not be attempted are different
 * findings and the simulation grades them differently.
 */
export interface IExecutabilityChainReader {
  /** Whether the address holds code. */
  hasCode: (address: Address) => Promise<boolean | undefined>
  /** The facet currently serving a selector on the diamond, zero for none. */
  facetAddress: (
    diamond: Address,
    selector: Hex
  ) => Promise<Address | undefined>
  /** The diamond's current owner. */
  owner: (diamond: Address) => Promise<Address | undefined>
  /** `eth_call` of one payload from the account that will really send it. */
  staticCall: (call: {
    from: Address
    to: Address
    data: Hex
  }) => Promise<Omit<IStaticCallObservation, 'path' | 'from'>>
  /**
   * `eth_simulateV1` of a batch's calls in the order the timelock executes
   * them, so each call sees what the calls before it changed.
   */
  simulateInOrder?: (
    calls: readonly { from: Address; to: Address; data: Hex }[]
  ) => Promise<TInOrderSimulation>
}

/** One outcome per call, in order, or why no endpoint could simulate them. */
export type TInOrderSimulation =
  | {
      kind: 'simulated'
      outcomes: Pick<IStaticCallObservation, 'outcome' | 'revertReason'>[]
    }
  | { kind: 'unavailable'; reason: string }

/** The proposal this collector is about. */
export interface ICollectExecutabilityInput {
  /** Network the proposal executes on, as `config/networks.json` names it. */
  network: string
  /** The Safe, which is `msg.sender` for the proposal's top-level call. */
  safeAddress: Address
  /** The top-level call's target and calldata, as the signed struct carries them. */
  to: Address
  data: Hex
  nonce?: {
    proposalNonce: number
    safeNonce?: number
    pendingNonces?: readonly number[]
  }
}

const normalise = (value: string): string => value.trim().toLowerCase()

/**
 * Names where a decoded cut sits, for every line the verdict prints.
 *
 * The decoder reports which top-level call a cut was reached from but not how
 * deep inside it, so the ordinal distinguishes several cuts reached from one
 * call rather than claiming a nesting position that was not recorded.
 */
const pathOf = (call: IDiamondCutCall, ordinal: number): string =>
  `call[${call.callIndex}].diamondCut[${ordinal}]`

/**
 * Turns a proposal's calldata into the payloads the simulation walks.
 *
 * A call carrying no readable `diamondCut` becomes an opaque payload rather
 * than nothing at all: the simulation reports it as having no revert model,
 * which is the honest answer, whereas dropping it would leave the verdict
 * silent about a call the proposal really makes.
 */
const buildCutPayloads = (
  input: ICollectExecutabilityInput,
  calls: readonly IDiamondCutCall[]
): TSimulatedPayload[] => {
  const seen = new Map<number, number>()

  return calls.map((call) => {
    const ordinal = seen.get(call.callIndex) ?? 0
    seen.set(call.callIndex, ordinal + 1)
    const path = pathOf(call, ordinal)

    return {
      kind: 'diamond-cut',
      path,
      diamond: call.target ?? input.to,
      caller: call.caller ?? input.safeAddress,
      cuts: call.cuts.map((cut, at) => ({
        action: cut.action,
        facetAddress: cut.facetAddress,
        selectors: cut.selectors,
        path: `${path}.cuts[${at}]`,
      })),
      init: call.init,
      initCalldata: call.initCalldata,
    }
  })
}

/** One `eth_call` the simulation makes, keyed by the payload's path. */
interface ISimulatedCall {
  from: string
  to: string
  data: Hex
}

/**
 * Names a leaf so the operator can tell a scheduled call from a direct one.
 *
 * A call reached through an envelope is not the call the Safe sends, and a path
 * that did not say so would report a revert against a payload the proposal
 * appears — from its own calldata — never to make.
 */
const leafPath = (call: IScheduledCall, ordinal: number): string =>
  call.depth === 0
    ? `call[${call.callIndex}]`
    : `call[${call.callIndex}].scheduled[${ordinal}]`

/** A `scheduleBatch`'s calls in execution order, and each one's payload path. */
interface IBatchSequence {
  calls: ISimulatedCall[]
  paths: string[]
  /**
   * Calls whose selector a cut placed before them in the batch adds or
   * replaces. Only these can revert alone for want of that cut.
   */
  afterTheirCut: ReadonlySet<string>
}

const ROUTING_ACTIONS: ReadonlySet<number> = new Set([
  FacetCutActionEnum.Add,
  FacetCutActionEnum.Replace,
])

/** The native value of each call a `scheduleBatch` schedules; unreadable reads as nonzero. */
const scheduledValues = (data: Hex): readonly bigint[] => {
  try {
    const { args } = decodeFunctionData({
      abi: TIMELOCK_SCHEDULE_BATCH_ABI,
      data,
    })
    return args[1]
  } catch {
    return [1n]
  }
}

/**
 * The calls of a proposal that is a single timelock `scheduleBatch`.
 *
 * Only that shape fixes the order the calls run in: separate `schedule`
 * operations, nested or side by side, can each execute once their own delay
 * passes, so simulating them in proposal order would vouch for an order nothing
 * enforces. Each cut in the batch is matched to its own payload by position, so
 * a cut that reverts in order is graded on that revert.
 */
const batchSequence = (
  input: ICollectExecutabilityInput,
  walked: { calls: readonly IScheduledCall[]; undecodable: readonly number[] },
  payloads: readonly TSimulatedPayload[]
): IBatchSequence | undefined => {
  const leaves = walked.calls
  const isBatch =
    input.data.slice(0, 10).toLowerCase() ===
    TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()
  if (!isBatch || leaves.length < 2 || leaves.some((leaf) => leaf.depth !== 1))
    return undefined
  // A call the walker could not open is missing from the sequence, so the
  // calls after it would be simulated without it.
  if (walked.undecodable.length > 0) return undefined
  // The simulation sends no value, so a batch carrying any would be judged on
  // calls it does not make (a nonpayable cut sent one wei reverts on chain).
  if (scheduledValues(input.data).some((value) => value !== 0n))
    return undefined

  const cuts = payloads.filter(
    (payload): payload is IDiamondCutPayload => payload.kind === 'diamond-cut'
  )
  const routed = new Set<string>()
  const afterTheirCut = new Set<string>()
  const paths: string[] = []
  let cutsSeen = 0

  for (const [ordinal, leaf] of leaves.entries()) {
    const selector = leaf.payload.slice(0, 10).toLowerCase()
    if (selector === DIAMOND_CUT_SELECTOR) {
      const cut = cuts[cutsSeen++]
      if (cut === undefined) return undefined
      paths.push(cut.path)
      for (const facetCut of cut.cuts)
        if (ROUTING_ACTIONS.has(facetCut.action))
          for (const added of facetCut.selectors) routed.add(normalise(added))
      continue
    }
    const path = leafPath(leaf, ordinal)
    paths.push(path)
    if (routed.has(selector)) afterTheirCut.add(path)
  }

  // A cut the walker read but the batch did not carry, or the reverse: the
  // positions no longer line up, and an outcome would land on the wrong call.
  if (cutsSeen !== cuts.length) return undefined

  return {
    calls: leaves.map((leaf) => ({
      from: leaf.caller ?? input.safeAddress,
      to: leaf.target ?? input.to,
      data: leaf.payload,
    })),
    paths,
    afterTheirCut,
  }
}

/**
 * Re-simulates a batch in order when one of its calls reverted on its own.
 *
 * An isolated `eth_call` runs against the state before the proposal, so a call
 * that needs an earlier one in the same batch (a setter of a facet the batch
 * cuts in) reverts there whatever it would do at execution. Only a call placed
 * after the cut that routes it can revert alone for that reason, so only its
 * isolated revert can be cleared in order; any other isolated revert stands,
 * whatever another endpoint's in-order run says. Every other call takes the
 * in-order outcome, cuts included. When no endpoint can run it, the isolated
 * reverts stay, and a call after its cut carries the reason.
 */
const simulateBatchInOrder = async (
  batch: IBatchSequence | undefined,
  staticCalls: IExecutabilityInput['staticCalls'],
  reader: IExecutabilityChainReader
): Promise<IExecutabilityInput['staticCalls']> => {
  if (batch === undefined) return staticCalls
  const at = new Map<string, number>()
  batch.paths.forEach((path, index) => at.set(path, index))
  const revertsForWantOfItsCut = (result: IStaticCallObservation): boolean =>
    result.outcome === 'reverted' && batch.afterTheirCut.has(result.path)
  if (!staticCalls.results.some(revertsForWantOfItsCut)) return staticCalls

  const sequence: TInOrderSimulation = reader.simulateInOrder
    ? await reader.simulateInOrder(
        batch.calls.map((call) => ({
          from: getAddress(call.from),
          to: getAddress(call.to),
          data: call.data,
        }))
      )
    : { kind: 'unavailable', reason: 'no in-order simulator was configured' }

  const results = staticCalls.results.map((result): IStaticCallObservation => {
    const index = at.get(result.path)
    if (index === undefined) return result
    if (sequence.kind === 'unavailable')
      return revertsForWantOfItsCut(result)
        ? { ...result, inOrderUnavailable: sequence.reason }
        : result
    if (result.outcome === 'reverted' && !revertsForWantOfItsCut(result))
      return result
    const outcome = sequence.outcomes[index]
    return outcome === undefined
      ? result
      : { path: result.path, from: result.from, ...outcome, inOrder: true }
  })

  return { ...staticCalls, results }
}

/**
 * Turns a proposal's calldata into the payloads the simulation walks, and the
 * `eth_call` each of them is answered by.
 *
 * Every call the proposal really makes gets a payload: each cut, each other
 * leaf reached by opening the timelock's envelopes, and — when an envelope was
 * opened at all — the envelope itself, because `schedule` can be refused on its
 * own (an operation already queued, a Safe without the proposer role) while
 * everything inside it would have executed.
 *
 * The `from` is the leaf's own caller, so an owner-gated function scheduled
 * through the timelock is simulated as the timelock rather than as the Safe.
 * Simulated as the Safe it reverts on the ownership check, which is a fact
 * about the wrong sender and not about the proposal.
 */
const buildPayloads = (
  input: ICollectExecutabilityInput,
  calls: readonly IDiamondCutCall[],
  leaves: readonly IScheduledCall[]
): {
  payloads: TSimulatedPayload[]
  simulation: Map<string, ISimulatedCall>
} => {
  const payloads = buildCutPayloads(input, calls)
  const simulation = new Map<string, ISimulatedCall>()

  for (const [at, payload] of payloads.entries()) {
    const call = calls[at]
    if (payload.kind === 'diamond-cut' && call)
      simulation.set(payload.path, {
        from: payload.caller,
        to: payload.diamond,
        // The cut's own bytes, replayed against the diamond. The proposal's
        // top-level calldata would only schedule it, and simulating that says
        // nothing about whether the cut itself executes.
        data: call.raw,
      })
  }

  const seen = new Map<number, number>()
  let opened = false

  for (const leaf of leaves) {
    const ordinal = seen.get(leaf.callIndex) ?? 0
    seen.set(leaf.callIndex, ordinal + 1)
    if (leaf.depth > 0) opened = true

    // A cut already has a payload of its own, graded against far more than its
    // eth_call outcome. A second, opaque one would simulate the same bytes
    // twice and report the same revert as two findings.
    if (leaf.payload.slice(0, 10).toLowerCase() === DIAMOND_CUT_SELECTOR)
      continue

    const path = leafPath(leaf, ordinal)
    const target = leaf.target ?? input.to
    payloads.push({
      kind: 'opaque',
      path,
      description:
        leaf.depth === 0
          ? 'an unrecognised function'
          : 'an unrecognised function the timelock would send',
      target,
      calldataLength: Math.max(0, (leaf.payload.length - 2) / 2),
      ...(FUNCTION_SELECTOR.test(leaf.payload)
        ? { selector: leaf.payload.slice(0, 10).toLowerCase() }
        : {}),
      ...(leaf.caller ? { caller: leaf.caller } : {}),
    })
    simulation.set(path, {
      from: leaf.caller ?? input.safeAddress,
      to: target,
      data: leaf.payload,
    })
  }

  if (opened) {
    const path = 'call[0].schedule'
    payloads.push({
      kind: 'opaque',
      path,
      description: 'the timelock envelope this proposal schedules',
      target: input.to,
      calldataLength: Math.max(0, (input.data.length - 2) / 2),
    })
    simulation.set(path, {
      from: input.safeAddress,
      to: input.to,
      data: input.data,
    })
  }

  // Nothing was readable at all — no cut, and no leaf the walker could reach.
  // The top-level call still has to be reported, or the verdict is silent about
  // a call the proposal really makes.
  if (payloads.length === 0) {
    const path = 'call[0]'
    payloads.push({
      kind: 'opaque',
      path,
      description: 'an unrecognised function',
      target: input.to,
      calldataLength: Math.max(0, (input.data.length - 2) / 2),
    })
    simulation.set(path, {
      from: input.safeAddress,
      to: input.to,
      data: input.data,
    })
  }

  return { payloads, simulation }
}

/**
 * Reads the chain state every `diamond-cut` payload is graded against.
 *
 * `selectorFacets` is keyed by bare selector, so it can only describe one
 * diamond. A proposal touching more than one is left without it: a map filled
 * from one diamond would answer for the other, and a selector reported as
 * served by a facet of a different diamond is a wrong answer rather than a
 * missing one.
 */
const readObservations = async (
  payloads: readonly TSimulatedPayload[],
  reader: IExecutabilityChainReader
): Promise<IChainObservations> => {
  const cutPayloads = payloads.filter(
    (payload): payload is Extract<TSimulatedPayload, { kind: 'diamond-cut' }> =>
      payload.kind === 'diamond-cut'
  )

  // One parse, one rule: a value this reader cannot query yields nothing rather
  // than throwing. `Promise.all` rejects on the first throw, so an unguarded
  // parse anywhere below discards every read that did land.
  const parsed = (value: string): Address | undefined => {
    try {
      return getAddress(value)
    } catch {
      return undefined
    }
  }

  const addresses = new Map<string, Address>()
  const remember = (value: string): void => {
    if (normalise(value) === normalise(ZERO_ADDRESS)) return
    try {
      addresses.set(normalise(value), getAddress(value))
    } catch {
      // Not an address this reader can query. The simulation grades the
      // malformed value itself; leaving it out of the reads keeps a bad input
      // from failing every other read in the batch.
    }
  }

  for (const payload of cutPayloads) {
    remember(payload.diamond)
    remember(payload.init)
    for (const cut of payload.cuts) remember(cut.facetAddress)
  }
  for (const payload of payloads)
    if (payload.kind === 'opaque') remember(payload.target)

  const diamonds = new Set(
    cutPayloads.map((payload) => normalise(payload.diamond))
  )
  const selectors = new Set<string>()
  for (const payload of cutPayloads)
    for (const cut of payload.cuts)
      for (const selector of cut.selectors) selectors.add(normalise(selector))

  const hasCode = new Map<string, boolean>()
  const owners = new Map<string, string>()
  const selectorFacets = new Map<string, string>()

  const codeReads = [...addresses.entries()].map(async ([key, address]) => {
    const held = await reader.hasCode(address)
    if (held !== undefined) hasCode.set(key, held)
  })

  // Resolved before the map rather than skipped inside it, so a payload whose
  // diamond does not parse is not counted as an owner read that went
  // unanswered.
  const ownerReadTargets = cutPayloads.flatMap((payload) => {
    const diamond = parsed(payload.diamond)
    return diamond === undefined
      ? []
      : [{ key: normalise(payload.diamond), diamond }]
  })
  const ownerReads = ownerReadTargets.map(async ({ key, diamond }) => {
    const owner = await reader.owner(diamond)
    if (owner !== undefined) owners.set(key, owner)
  })

  const onlyDiamond =
    diamonds.size === 1 && cutPayloads[0]
      ? parsed(cutPayloads[0].diamond)
      : undefined

  const selectorReads =
    onlyDiamond === undefined
      ? []
      : [...selectors].map(async (selector) => {
          const facet = await reader.facetAddress(onlyDiamond, selector as Hex)
          if (facet !== undefined) selectorFacets.set(selector, facet)
        })

  await Promise.all([...codeReads, ...ownerReads, ...selectorReads])

  const attempted =
    addresses.size +
    ownerReadTargets.length +
    (onlyDiamond ? selectors.size : 0)
  const answered = hasCode.size + owners.size + selectorFacets.size

  // "Available" is about whether the endpoint answered at all, not about
  // coverage: a partially answered set is graded read by read, and every read
  // that did not land is already absent from the maps above.
  if (attempted > 0 && answered === 0)
    return {
      available: false,
      unavailableReason: 'no chain read returned a value',
      selectorFacets,
      hasCode,
      owners,
    }

  return { available: true, selectorFacets, hasCode, owners }
}

/**
 * Simulates each payload from the account that will really send it.
 *
 * The `from` is the payload's own caller — the timelock for anything reached by
 * unwrapping one of its envelopes, the Safe for a direct call. Every
 * `diamondCut` is owner-gated, so a call made from any other account reverts
 * for a reason the proposal is not responsible for, and reporting that as the
 * proposal's revert would refuse a correct rollout.
 */
const runStaticCalls = async (
  simulation: ReadonlyMap<string, ISimulatedCall>,
  reader: IExecutabilityChainReader
): Promise<IExecutabilityInput['staticCalls']> => {
  const simulated = [...simulation.entries()].map(([path, call]) => ({
    path,
    ...call,
  }))

  const results = await Promise.all(
    simulated.map(async (call): Promise<IStaticCallObservation> => {
      try {
        const outcome = await reader.staticCall({
          from: getAddress(call.from),
          to: getAddress(call.to),
          data: call.data,
        })
        return { path: call.path, from: call.from, ...outcome }
      } catch (error) {
        return {
          path: call.path,
          from: call.from,
          outcome: 'errored',
          errorReason: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )

  return { attempted: simulated.length > 0, results }
}

/**
 * Assembles everything one proposal's executability verdict is decided from.
 *
 * @param input - The proposal's top-level call, the Safe that sends it, and the nonces.
 * @param reader - The chain reads, each free to report that it could not answer.
 * @returns The input `evaluateExecutability` grades.
 */
export const collectExecutabilityInput = async (
  input: ICollectExecutabilityInput,
  reader: IExecutabilityChainReader
): Promise<IExecutabilityInput> => {
  const context = { targets: [input.to], caller: input.safeAddress }
  const { calls, undecodable } = collectDiamondCutCalls([input.data], context)
  const leaves = collectScheduledCalls([input.data], context)

  const unreadable = [...new Set([...undecodable, ...leaves.undecodable])]

  const { payloads, simulation } = buildPayloads(input, calls, leaves.calls)
  const observations = await readObservations(payloads, reader)
  const staticCalls = await simulateBatchInOrder(
    batchSequence(input, leaves, payloads),
    await runStaticCalls(simulation, reader),
    reader
  )

  return {
    network: input.network,
    payloads,
    observations,
    staticCalls,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    // Both walkers, because they stop at different things: one cannot read a
    // cut, the other cannot open an envelope, and either leaves the simulation
    // grading fewer calls than the proposal makes.
    ...(unreadable.length > 0
      ? { undecodable: unreadable.map((index) => `call[${index}]`) }
      : {}),
  }
}

/** A selector at least: the shape of a custom error, `Error(string)` or `Panic`. */
const REVERT_DATA = /^0x(?:[0-9a-f]{2}){4,}$/iu

/**
 * The codes a node answers a reverting `eth_call` with when it does not use 3:
 * geth-family `-32000` and Nethermind `-32015`. Revert-shaped data on any
 * other code is an endpoint attaching bytes to its own failure.
 */
const REVERT_DATA_CODES: ReadonlySet<unknown> = new Set([-32000, -32015])

/**
 * The whole node string, not a word inside it: geth's `execution reverted`
 * with an optional reason, Nethermind's `revert` / `Reverted 0x…`, Ganache and
 * Hardhat's `VM Exception …: revert`, and an invalid opcode.
 */
const REVERT_WORDING =
  /^(?:execution reverted(?::.*)?|revert(?:ed)?(?: 0x[0-9a-f]*)?|vm exception while processing transaction: revert.*|invalid opcode\b.*)$/isu

/**
 * Throttling and caching; a node without the state at the pinned block, which
 * ran nothing; and the gas allowance viem files under `ExecutionRevertedError`.
 * The allowance is the node's own gas cap, so like out of gas it says as much
 * about the endpoint as about the payload. Never read inside a string that is
 * itself revert wording, whose reason the reverting contract chose.
 */
const ENDPOINT_WORDING =
  /\brate[- ]?limit|\btoo many requests\b|\bcache[ds]?\b|\bheader not found\b|\bmissing trie node\b|\bgas required exceeds allowance\b/iu

/**
 * Whether an error is the chain answering that the payload does not execute,
 * rather than the endpoint failing to answer.
 *
 * Read from evidence only the EVM produces, anywhere in the cause chain: viem
 * wraps every call failure as `CallExecutionError`, so the outer error's name
 * says nothing — a keyless endpoint's "Missing or invalid parameters" and an
 * endpoint's "Internal error" arrive in the same wrapper as a revert. Anything
 * not recognised here is the endpoint's failure and the next one is asked, so a
 * revert behind an unusable endpoint is still found.
 *
 * Code 3 is decisive on its own. Every other signal counts only beside a link
 * carrying a JSON-RPC code, the one shape a node's answer has: viem names an
 * error `ExecutionRevertedError` from a substring of whatever text it holds,
 * an HTTP body included, and a proxy may word its own failure as a revert.
 * Those signals also yield to endpoint wording anywhere in the chain, except
 * inside a string that is itself revert wording.
 *
 * Out of gas is deliberately not here: `eth_call` runs under the node's own
 * gas cap, which differs between providers, so it says as much about the
 * endpoint as about the payload.
 *
 * @param error - What `PublicClient.call` threw.
 * @returns True only when some link of the chain carries a revert.
 */
const isExecutionRevert = (error: unknown): boolean => {
  const links: Record<string, unknown>[] = []
  for (
    let link: unknown = error;
    typeof link === 'object' && link !== null && !links.includes(link as never);
    link = (link as { cause?: unknown }).cause
  )
    links.push(link as Record<string, unknown>)

  // viem's `details` is the node's own string; its `message` is a composed
  // report that also carries the endpoint URL, which is no evidence either way.
  const texts = (link: Record<string, unknown>): unknown[] => [
    typeof link.details === 'string' ? link.details : link.message,
    link.data,
  ]
  const answers = links.filter((link) => typeof link.code === 'number')

  if (answers.some((link) => link.code === 3)) return true
  if (
    answers.length === 0 ||
    links.some((link) =>
      texts(link).some(
        (text) =>
          typeof text === 'string' &&
          ENDPOINT_WORDING.test(text) &&
          !REVERT_WORDING.test(text.trim())
      )
    )
  )
    return false

  return (
    links.some((link) => link.name === 'ExecutionRevertedError') ||
    answers.some(
      (link) =>
        (REVERT_DATA_CODES.has(link.code) &&
          typeof link.data === 'string' &&
          REVERT_DATA.test(link.data)) ||
        texts(link).some(
          (text) => typeof text === 'string' && REVERT_WORDING.test(text.trim())
        )
    )
  )
}

const ECHOED_BLOCK =
  /^(?:raw call arguments|request arguments|contract call):$/iu
const LIBRARY_VERSION = /^version:/iu
const DETAILS_PREFIX = /^details:\s*(.*)$/iu
const NODE_REVERT_PREFIX = /^execution reverted:?\s*/iu

/**
 * Reduces an RPC error to the part the signer cannot already see.
 *
 * viem formats a call failure as a multi-paragraph report whose middle section
 * re-prints the payload verbatim — the same `to` and `data` zone 1 shows above
 * it. Carried through, that pushes the revert reason several hundred characters
 * down inside a red block, which is where a signer stops reading.
 *
 * @param message - The error message as the transport threw it.
 * @returns The summary, or the original when nothing was recognised to drop.
 */
export const summariseRpcError = (message: string): string => {
  const kept: string[] = []
  let inEchoedBlock = false

  for (const line of message.split('\n')) {
    const trimmed = line.trim()

    if (ECHOED_BLOCK.test(trimmed)) {
      inEchoedBlock = true
      continue
    }

    // An echoed block runs until the next unindented line, so a blank line
    // inside it does not end it.
    if (inEchoedBlock) {
      if (trimmed === '' || line !== trimmed) continue
      inEchoedBlock = false
    }

    if (trimmed === '' || LIBRARY_VERSION.test(trimmed)) continue

    kept.push(trimmed)
  }

  const surviving = kept.filter((line, index) => {
    const payload = DETAILS_PREFIX.exec(line)?.[1]
    if (payload === undefined) return true

    // viem's `Details:` is the node's own string, which for a named revert is
    // the reason the line above already states. Kept, it reads as a second
    // finding; dropped when it adds a word, it would be the only place the
    // reason appears — so it survives on whether it says anything new.
    const bare = payload.replace(NODE_REVERT_PREFIX, '').trim()
    const rest = kept.filter((_, other) => other !== index).join(' ')
    return !rest.toLowerCase().includes(bare.toLowerCase())
  })

  return surviving.length > 0 ? surviving.join(' ') : message.trim()
}

/**
 * Wires the reads to a real endpoint.
 *
 * Every read resolves to `undefined` rather than throwing, because the
 * simulation's contract is that an unanswered read is absent: a throw here
 * would abort the collection and lose the reads that did land.
 *
 * @param client - A viem public client pointed at the network's endpoint.
 * @returns Reads backed by that endpoint.
 */
export const createExecutabilityChainReader = (
  client: PublicClient,
  simulators: readonly PublicClient[] = [client]
): IExecutabilityChainReader => ({
  hasCode: async (address) => {
    try {
      const code = await client.getCode({ address })
      return code !== undefined && code !== '0x'
    } catch {
      return undefined
    }
  },
  facetAddress: async (diamond, selector) => {
    try {
      return await client.readContract({
        address: diamond,
        abi: DIAMOND_LOUPE_ABI,
        functionName: 'facetAddress',
        args: [selector],
      })
    } catch {
      return undefined
    }
  },
  owner: async (diamond) => {
    try {
      return await client.readContract({
        address: diamond,
        abi: OWNER_ABI,
        functionName: 'owner',
      })
    } catch {
      return undefined
    }
  },
  staticCall: async (call) => {
    // Endpoint by endpoint, never through a fallback transport. viem's fallback
    // stops failing over only for a revert it recognises by wording — a node
    // that answers `-32000 "Reverted 0x…"` instead of "execution reverted" is
    // treated as unreachable, and the next endpoint's success becomes the
    // answer. That turns a proposal which reverts into a green row, which is
    // the one outcome this whole gate exists to prevent.
    let lastError: string | undefined

    // viem names the sender `account`; `from` is not one of its call
    // parameters, so passing it through sends `eth_call` with no sender at
    // all. Every payload would then simulate as address(0) and revert on the
    // first caller check it meets — a red row on every proposal the timelock
    // gates, which is indistinguishable from the real reverts this gate exists
    // to catch.
    const request: CallParameters = {
      account: call.from,
      to: call.to,
      data: call.data,
    }

    for (const simulator of simulators)
      try {
        await simulator.call(request)
        return { outcome: 'succeeded' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (isExecutionRevert(error))
          return {
            outcome: 'reverted',
            revertReason: redactUrls(summariseRpcError(message)),
          }

        lastError = message
      }

    return {
      outcome: 'errored',
      errorReason: redactUrls(
        lastError === undefined
          ? 'no endpoint was available to simulate this payload'
          : summariseRpcError(lastError)
      ),
    }
  },
  simulateInOrder: async (calls) => {
    // Every endpoint is asked, and a revert from any of them wins, as it does
    // for an isolated eth_call: this result can clear a revert, so a single
    // stale or permissive endpoint must not be the one that clears it.
    let lastError: string | undefined
    let merged: TInOrderSimulation | undefined

    for (const simulator of simulators) {
      const answer = await simulateOn(simulator, calls)
      if (answer.kind === 'unavailable') {
        lastError = answer.reason
        continue
      }
      merged =
        merged?.kind === 'simulated'
          ? {
              kind: 'simulated',
              outcomes: merged.outcomes.map((outcome, index) =>
                outcome.outcome === 'reverted'
                  ? outcome
                  : (answer.outcomes[index] ?? outcome)
              ),
            }
          : answer
    }

    if (merged !== undefined) return merged
    return {
      kind: 'unavailable',
      reason: redactUrls(
        lastError ?? 'no endpoint was available to simulate the batch in order'
      ),
    }
  },
})

/**
 * One endpoint's `eth_simulateV1` answer for a batch, or why it gave none.
 *
 * @param simulator - The endpoint to ask.
 * @param calls - The batch, in execution order.
 * @returns One outcome per call, or the endpoint's failure.
 */
const simulateOn = async (
  simulator: PublicClient,
  calls: readonly { from: Address; to: Address; data: Hex }[]
): Promise<TInOrderSimulation> => {
  try {
    const [block] = await simulator.simulateBlocks({
      blocks: [
        {
          calls: calls.map((call) => ({
            account: call.from,
            to: call.to,
            data: call.data,
          })),
        },
      ],
    })
    // A node that answers with fewer results than calls has not simulated the
    // batch, and pairing what it did return by index would grade one call on
    // another's outcome.
    if (block?.calls.length !== calls.length)
      return {
        kind: 'unavailable',
        reason: `the node returned ${block?.calls.length ?? 0} results for ${calls.length} calls`,
      }
    // A failure without revert data is not told apart from a VM error (out of
    // gas under the node's own cap), which the isolated eth_call does not
    // count as a revert either, so it leaves this endpoint without an answer.
    const silent = block.calls.findIndex(
      (result) =>
        result.status !== 'success' && (!result.data || result.data === '0x')
    )
    if (silent !== -1)
      return {
        kind: 'unavailable',
        reason: `eth_simulateV1 call ${silent} failed without revert data`,
      }
    return {
      kind: 'simulated',
      outcomes: block.calls.map((result) =>
        result.status === 'success'
          ? { outcome: 'succeeded' }
          : {
              outcome: 'reverted',
              revertReason: `revert data ${result.data.slice(0, 74)}`,
            }
      ),
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `eth_simulateV1 failed: ${summariseRpcError(
        error instanceof Error ? error.message : String(error)
      )}`,
    }
  }
}
