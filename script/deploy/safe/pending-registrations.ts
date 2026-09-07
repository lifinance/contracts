/**
 * Scheduled-but-not-yet-executed diamond registrations and whitelist entries, read from
 * the timelock execution queue.
 *
 * Import it from the health-check invariants to tell a rollout still waiting on its
 * timelock delay apart from a genuinely missing registration; intent
 * is for alerting only and must never reach a generator ([CONV:HEALTHCHECK-INTENT]
 * in `.agents/rules/601-healthcheck-invariants.md`).
 *
 * The covered window is narrower than "merge to execution": a row appears only once the
 * Safe transaction executing `scheduleBatch` is mined, so the multisig signing window
 * before it stays uncovered, as does any rollout proposed without `--timelock` and every
 * Tron rollout. Widening it to the signing window would mean reading the Safe proposal
 * collection, which needs a secret the health-check workflows do not carry.
 *
 * The queue rather than the Safe proposal collection, on two counts: it lives on the
 * un-gated `MONGODB_URI` cluster the health-check workflows already pass, whereas the
 * Safe collection sits behind a tunnel those workflows cannot open; and a `queued` row
 * means `scheduleBatch` already executed, while an unsigned proposal may never be.
 *
 * Every helper below the Mongo wrapper is pure and takes its documents injected, so the
 * decode and grouping logic is unit-testable without a live cluster.
 */

import { decodeFunctionData, isAddress, parseAbi, type Hex } from 'viem'

import { DAY_MS } from '../shared/constants'

import {
  getTimelockQueueCollection,
  type ITimelockQueueDoc,
} from './timelock-queue'

/** `LibDiamond.FacetCutAction` values that leave the facet address routed afterwards. */
const ROUTING_CUT_ACTIONS = new Set([0, 1]) // Add, Replace

const ABI_DIAMOND_CUT = parseAbi([
  'function diamondCut((address,uint8,bytes4[])[],address,bytes)',
])

const ABI_REGISTER_PERIPHERY_CONTRACT = parseAbi([
  'function registerPeripheryContract(string,address)',
])

const ABI_SET_CONTRACT_SELECTOR_WHITELIST = parseAbi([
  'function setContractSelectorWhitelist(address,bytes4,bool)',
])

const ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST = parseAbi([
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

/**
 * What an inner call would leave in place. Consumers must match on this rather than on
 * which optional fields happen to be set: each kind covers something the others do not,
 * and a check keyed on the absence of a field silently widens every time a kind is added.
 */
export type RegistrationKind = 'facet-cut' | 'periphery' | 'whitelist'

/** One address an inner call would leave in place, and what it leaves it as. */
export interface IDecodedRegistration {
  /** Which of the tracked calls this record came from. */
  kind: RegistrationKind
  /** Lowercased address the call registers, or whitelists for `whitelist`. */
  address: string
  /**
   * Registry name the address is bound to; `periphery` only. A periphery address
   * registered under one name says nothing about any other name, so the caller must
   * match this, not just the address.
   */
  peripheryName?: string
  /**
   * Lowercased selector whitelisted for `address`; `whitelist` only. Whitelisting is
   * per contract *and* selector, so the caller must match this too.
   */
  selector?: Hex
}

/** One scheduled registration, traceable back to the timelock operation carrying it. */
export interface IPendingRegistration extends IDecodedRegistration {
  /** Timelock operation id the registration was decoded from. */
  operationId: Hex
  /** Lowercased inner-call target — the diamond the registration applies to. */
  target: string
}

/**
 * Pairs positionally, dropping any entry that is not a usable address/selector pair.
 *
 * @param contracts - Contract addresses from the decoded call.
 * @param selectors - Selectors from the decoded call, index-aligned with `contracts`.
 * @returns One `whitelist` record per usable pair.
 */
function toWhitelistRegistrations(
  contracts: readonly unknown[],
  selectors: readonly unknown[]
): IDecodedRegistration[] {
  const registrations: IDecodedRegistration[] = []
  contracts.forEach((contract, index) => {
    const selector = selectors[index]
    if (
      typeof contract === 'string' &&
      isAddress(contract) &&
      typeof selector === 'string'
    )
      registrations.push({
        kind: 'whitelist',
        address: contract.toLowerCase(),
        selector: selector.toLowerCase() as Hex,
      })
  })
  return registrations
}

/**
 * Addresses a single queued inner call would leave registered on its target diamond.
 *
 * Recognises the calls that leave something in place: `diamondCut` (facet addresses
 * under an `Add`/`Replace` action — a `Remove` leaves nothing routed),
 * `registerPeripheryContract` (the periphery address), and the whitelist setters
 * `setContractSelectorWhitelist` / `batchSetContractSelectorWhitelist` with
 * `_whitelisted` true — passing false un-whitelists, the counterpart of a `Remove`.
 * Anything else — a role change, an unknown selector — contributes nothing rather than
 * throwing, because the queue legitimately carries operations this check has no
 * opinion about.
 *
 * @param payload - Raw calldata of one inner call from a `scheduleBatch` operation.
 * @returns What the call would register, empty when it registers nothing.
 */
export function extractRegistrations(
  payload: Hex | string
): IDecodedRegistration[] {
  if (typeof payload !== 'string' || payload.length < 10) return []
  const data = payload as Hex

  try {
    const { args } = decodeFunctionData({ abi: ABI_DIAMOND_CUT, data })
    const cuts = args?.[0]
    if (!Array.isArray(cuts)) return []
    const registrations: IDecodedRegistration[] = []
    for (const cut of cuts) {
      const [facetAddress, action] = cut as [unknown, unknown, unknown]
      if (!ROUTING_CUT_ACTIONS.has(Number(action))) continue
      if (typeof facetAddress === 'string' && isAddress(facetAddress))
        registrations.push({
          kind: 'facet-cut',
          address: facetAddress.toLowerCase(),
        })
    }
    return registrations
  } catch {
    // Not a diamondCut; fall through to the periphery shape.
  }

  try {
    const { args } = decodeFunctionData({
      abi: ABI_REGISTER_PERIPHERY_CONTRACT,
      data,
    })
    const peripheryName = args?.[0]
    const peripheryAddress = args?.[1]
    // Registering the zero address unregisters the name — the periphery counterpart of
    // a Remove cut, and like a Remove it leaves nothing registered.
    if (
      typeof peripheryName === 'string' &&
      typeof peripheryAddress === 'string' &&
      isAddress(peripheryAddress) &&
      BigInt(peripheryAddress) !== 0n
    )
      return [
        {
          kind: 'periphery',
          address: peripheryAddress.toLowerCase(),
          peripheryName,
        },
      ]
  } catch {
    // Not a periphery registration; fall through to the whitelist shapes.
  }

  try {
    const { args } = decodeFunctionData({
      abi: ABI_SET_CONTRACT_SELECTOR_WHITELIST,
      data,
    })
    const [contract, selector, whitelisted] = args ?? []
    return whitelisted === true
      ? toWhitelistRegistrations([contract], [selector])
      : []
  } catch {
    // Not the single-pair setter; fall through to the batch shape.
  }

  try {
    const { args } = decodeFunctionData({
      abi: ABI_BATCH_SET_CONTRACT_SELECTOR_WHITELIST,
      data,
    })
    const [contracts, selectors, whitelisted] = args ?? []
    if (whitelisted !== true) return []
    // The facet reverts on a length mismatch (`InvalidConfig`), so such a batch
    // whitelists nothing at all rather than the pairs it could have paired up.
    if (
      !Array.isArray(contracts) ||
      !Array.isArray(selectors) ||
      contracts.length !== selectors.length
    )
      return []
    return toWhitelistRegistrations(contracts, selectors)
  } catch {
    // None of the shapes — the operation registers nothing this check tracks.
  }

  return []
}

/**
 * Collapses one queue row into the registrations its inner calls would perform.
 *
 * `targets[i]` pairs with `payloads[i]`, so the target is carried through per call:
 * the caller matches it against the network's diamond, and a `diamondCut` aimed at
 * anything else must not be read as covering that diamond's missing facet.
 *
 * Every record for an address is kept rather than the last one winning: two inner calls
 * may register the same address against different targets, or under different registry
 * names, and each says something the others do not.
 *
 * @param doc - A queued timelock operation.
 * @returns Lowercased address → every registration the row would perform for it.
 */
export function registrationsFromQueueDoc(
  doc: Pick<ITimelockQueueDoc, 'operationId' | 'targets' | 'payloads'>
): Map<string, IPendingRegistration[]> {
  const registrations = new Map<string, IPendingRegistration[]>()
  doc.payloads.forEach((payload, index) => {
    const target = doc.targets[index]
    if (!target) return
    for (const decoded of extractRegistrations(payload)) {
      const records = registrations.get(decoded.address) ?? []
      records.push({
        ...decoded,
        operationId: doc.operationId,
        target: String(target).toLowerCase(),
      })
      registrations.set(decoded.address, records)
    }
  })
  return registrations
}

/**
 * How long past its own timelock delay a `queued` row still counts as intent.
 *
 * A row is not always retired when its operation dies: when the Safe transaction never
 * actually scheduled the batch, or the operation was cancelled directly on the timelock,
 * `execute-pending-timelock-tx` reports it and moves on **without changing the status**,
 * so the row stays `queued` forever. That state — contract deployed, recorded in the
 * deploy log, cut never landed — is precisely what the registration invariants exist to
 * catch, so honouring such a row indefinitely would invert the gate. Bounding by age
 * turns "masked forever" into "masked briefly", and the direction of the error is safe:
 * past the bound the registration reports as a hard error, never as silently fine.
 *
 * Three days is generous on purpose. Across the 900 executed rows in the live queue the
 * observed create→execute spread was p50 ~3.3 h and max ~70.7 h against a uniform 3 h
 * delay, so this clears even the slowest real rollout on record while still being finite.
 */
export const STALE_QUEUE_GRACE_MS = 3 * DAY_MS

/**
 * True while a queued row is still plausibly waiting rather than stuck.
 *
 * @param doc - Queue row carrying its creation time and configured delay (seconds).
 * @param now - Current epoch milliseconds.
 * @returns Whether the row is within its delay plus {@link STALE_QUEUE_GRACE_MS}.
 */
function isWithinExecutionWindow(
  doc: Pick<ITimelockQueueDoc, 'createdAt' | 'delay'>,
  now: number
): boolean {
  const createdAt = new Date(doc.createdAt).getTime()
  if (Number.isNaN(createdAt)) return false
  const delayMs = Number(doc.delay) * 1000
  // A row whose delay is unparseable says nothing trustworthy about its own window;
  // fall back to the grace alone rather than to an unbounded one.
  return (
    now <
    createdAt + (Number.isFinite(delayMs) ? delayMs : 0) + STALE_QUEUE_GRACE_MS
  )
}

/**
 * Groups queue rows into the registrations each network's diamonds would receive.
 *
 * Pure and injectable so the grouping is testable without a cluster; the Mongo read
 * lives in {@link listPendingRegistrationsByNetwork}. Rows past their execution window
 * are dropped here — see {@link STALE_QUEUE_GRACE_MS}.
 *
 * @param docs - Queue rows to group. Callers pass only rows they consider live.
 * @param now - Current epoch milliseconds; injectable so staleness is testable.
 * @returns Network → (lowercased registered address → every operation registering it).
 */
export function groupRegistrationsByNetwork(
  docs: Array<
    Pick<
      ITimelockQueueDoc,
      'operationId' | 'targets' | 'payloads' | 'network' | 'createdAt' | 'delay'
    >
  >,
  now: number = Date.now()
): Map<string, Map<string, IPendingRegistration[]>> {
  const byNetwork = new Map<string, Map<string, IPendingRegistration[]>>()
  for (const doc of docs) {
    if (!isWithinExecutionWindow(doc, now)) continue
    const registrations = registrationsFromQueueDoc(doc)
    if (registrations.size === 0) continue
    const network = doc.network.toLowerCase()
    const forNetwork =
      byNetwork.get(network) ?? new Map<string, IPendingRegistration[]>()
    for (const [address, records] of registrations)
      forNetwork.set(address, [...(forNetwork.get(address) ?? []), ...records])
    byNetwork.set(network, forNetwork)
  }
  return byNetwork
}

/**
 * Every scheduled-but-unexecuted registration fleet-wide, grouped by network.
 *
 * Only `queued` rows count: `executed` has already landed on-chain (the loupe shows
 * it), and `cancelled`/`failed` are terminal — a `failed` row in particular is not a
 * promise of anything, so treating it as intent would suppress a real alert forever. A
 * `blocked` row is the one live status left out: it is still executable once an operator
 * clears the cause, but nothing bounds how long that takes, so it reports as a finding.
 *
 * Known sharp edge, deliberately left erring toward over-alerting: a row marked
 * `failed` can still be a live, executable on-chain operation when what failed was a
 * pre-execute guard rather than execution itself. Such a row will not cover anything
 * here, so its registration reports as a hard error rather than expected-pending. If
 * you are debugging why a downgrade did not apply during a live rollout, check the
 * row's status first.
 *
 * @returns Network → (lowercased registered address → every operation registering it).
 * @throws Whatever the MongoDB driver throws; callers degrade rather than guess.
 */
export async function listPendingRegistrationsByNetwork(): Promise<
  Map<string, Map<string, IPendingRegistration[]>>
> {
  const { client, timelockQueue } = await getTimelockQueueCollection()
  try {
    return groupRegistrationsByNetwork(
      await timelockQueue
        .find<ITimelockQueueDoc>({ status: 'queued' })
        .toArray()
    )
  } finally {
    await client.close()
  }
}
