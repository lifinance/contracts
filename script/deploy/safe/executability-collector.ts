/**
 * Gathers the chain reads `evaluateExecutability` decides from.
 *
 * Import this from a script that has a pending proposal and an RPC endpoint;
 * it turns one Safe transaction into the {@link IExecutabilityInput} the
 * simulation grades. The reads are behind {@link IExecutabilityChainReader} so
 * the assembly can be exercised without a node — the decision module is already
 * pure, and this is the part that was missing between it and a signer.
 *
 * Nothing here decides anything. Every read that fails is left absent rather
 * than defaulted, because the simulation grades an absent observation as
 * unchecked and an unchecked observation as an error: a collector that filled
 * in a plausible value would convert "nobody asked" into "the chain said yes".
 */

import { getAddress, type Address, type Hex } from 'viem'

import {
  collectDiamondCutCalls,
  type IDiamondCutCall,
} from '../shared/diamond-cut-calls'

import type {
  IChainObservations,
  IExecutabilityInput,
  IStaticCallObservation,
  TSimulatedPayload,
} from './executability-simulation'

/** The reads one verdict needs, each returning `undefined` when it could not be made. */
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
}

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

const ZERO = '0x0000000000000000000000000000000000000000'

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
const buildPayloads = (
  input: ICollectExecutabilityInput,
  calls: readonly IDiamondCutCall[]
): TSimulatedPayload[] => {
  if (calls.length === 0)
    return [
      {
        kind: 'opaque',
        path: 'call[0]',
        description: 'an unrecognised function',
        target: input.to,
        calldataLength: Math.max(0, (input.data.length - 2) / 2),
      },
    ]

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

  const addresses = new Map<string, Address>()
  const remember = (value: string): void => {
    if (normalise(value) === ZERO) return
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

  const ownerReads = cutPayloads.map(async (payload) => {
    const diamond = getAddress(payload.diamond)
    const owner = await reader.owner(diamond)
    if (owner !== undefined) owners.set(normalise(payload.diamond), owner)
  })

  const onlyDiamond =
    diamonds.size === 1
      ? getAddress(cutPayloads[0]?.diamond ?? ZERO)
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
    addresses.size + cutPayloads.length + (onlyDiamond ? selectors.size : 0)
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
  input: ICollectExecutabilityInput,
  payloads: readonly TSimulatedPayload[],
  calls: readonly IDiamondCutCall[],
  reader: IExecutabilityChainReader
): Promise<IExecutabilityInput['staticCalls']> => {
  const simulated = payloads.map((payload, at) => {
    const call = calls[at]
    if (payload.kind === 'diamond-cut' && call)
      return {
        path: payload.path,
        from: payload.caller,
        to: payload.diamond,
        // The cut's own bytes, replayed against the diamond. The proposal's
        // top-level calldata would only schedule it, and simulating that says
        // nothing about whether the cut itself executes.
        data: call.raw,
      }

    return {
      path: payload.path,
      from: input.safeAddress,
      to: input.to,
      data: input.data,
    }
  })

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
  const { calls, undecodable } = collectDiamondCutCalls([input.data], {
    targets: [input.to],
    caller: input.safeAddress,
  })

  const payloads = buildPayloads(input, calls)
  const observations = await readObservations(payloads, reader)
  const staticCalls = await runStaticCalls(input, payloads, calls, reader)

  return {
    network: input.network,
    payloads,
    observations,
    staticCalls,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    // `collectDiamondCutCalls` reports the indices of the proposal's own calls;
    // the verdict names them the way its other paths are named.
    ...(undecodable.length > 0
      ? { undecodable: undecodable.map((index) => `call[${index}]`) }
      : {}),
  }
}
