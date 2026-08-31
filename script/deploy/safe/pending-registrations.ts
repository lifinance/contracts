/**
 * Scheduled-but-not-yet-executed diamond registrations, read from the timelock
 * execution queue.
 *
 * Import it from the health-check registration invariants to tell a rollout still
 * waiting on its timelock delay apart from a genuinely missing registration; intent
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
 * Every helper below the Mongo wrapper is pure and takes its documents injected, so
 * the decode and grouping logic is unit-testable without a live cluster — the same
 * split `parked-tasks.ts` uses.
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

/** One scheduled registration, traceable back to the timelock operation carrying it. */
export interface IPendingRegistration {
  /** Timelock operation id the registration was decoded from. */
  operationId: Hex
  /** Lowercased inner-call target — the diamond the registration applies to. */
  target: string
}

/**
 * Addresses a single queued inner call would leave registered on its target diamond.
 *
 * Recognises the two calls that register something: `diamondCut` (facet addresses
 * under an `Add`/`Replace` action — a `Remove` leaves nothing routed) and
 * `registerPeripheryContract` (the periphery address). Anything else — a role
 * change, a whitelist batch, an unknown selector — contributes nothing rather than
 * throwing, because the queue legitimately carries operations this check has no
 * opinion about.
 *
 * @param payload - Raw calldata of one inner call from a `scheduleBatch` operation.
 * @returns Lowercased addresses the call would register, empty when it registers none.
 */
export function extractRegisteredAddresses(payload: Hex | string): string[] {
  if (typeof payload !== 'string' || payload.length < 10) return []
  const data = payload as Hex

  try {
    const { args } = decodeFunctionData({ abi: ABI_DIAMOND_CUT, data })
    const cuts = args?.[0]
    if (!Array.isArray(cuts)) return []
    const addresses: string[] = []
    for (const cut of cuts) {
      const [facetAddress, action] = cut as [unknown, unknown, unknown]
      if (!ROUTING_CUT_ACTIONS.has(Number(action))) continue
      if (typeof facetAddress === 'string' && isAddress(facetAddress))
        addresses.push(facetAddress.toLowerCase())
    }
    return addresses
  } catch {
    // Not a diamondCut; fall through to the periphery shape.
  }

  try {
    const { args } = decodeFunctionData({
      abi: ABI_REGISTER_PERIPHERY_CONTRACT,
      data,
    })
    const peripheryAddress = args?.[1]
    // Registering the zero address unregisters the name — the periphery counterpart of
    // a Remove cut, and like a Remove it leaves nothing registered.
    if (
      typeof peripheryAddress === 'string' &&
      isAddress(peripheryAddress) &&
      BigInt(peripheryAddress) !== 0n
    )
      return [peripheryAddress.toLowerCase()]
  } catch {
    // Neither shape — the operation registers nothing this check tracks.
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
 * @param doc - A queued timelock operation.
 * @returns Lowercased address → registration, for every address the row would register.
 */
export function registrationsFromQueueDoc(
  doc: Pick<ITimelockQueueDoc, 'operationId' | 'targets' | 'payloads'>
): Map<string, IPendingRegistration> {
  const registrations = new Map<string, IPendingRegistration>()
  doc.payloads.forEach((payload, index) => {
    const target = doc.targets[index]
    if (!target) return
    for (const address of extractRegisteredAddresses(payload))
      registrations.set(address, {
        operationId: doc.operationId,
        target: String(target).toLowerCase(),
      })
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
 * @returns Network → (lowercased registered address → the operation registering it).
 */
export function groupRegistrationsByNetwork(
  docs: Array<
    Pick<
      ITimelockQueueDoc,
      'operationId' | 'targets' | 'payloads' | 'network' | 'createdAt' | 'delay'
    >
  >,
  now: number = Date.now()
): Map<string, Map<string, IPendingRegistration>> {
  const byNetwork = new Map<string, Map<string, IPendingRegistration>>()
  for (const doc of docs) {
    if (!isWithinExecutionWindow(doc, now)) continue
    const registrations = registrationsFromQueueDoc(doc)
    if (registrations.size === 0) continue
    const network = doc.network.toLowerCase()
    const forNetwork =
      byNetwork.get(network) ?? new Map<string, IPendingRegistration>()
    for (const [address, registration] of registrations)
      forNetwork.set(address, registration)
    byNetwork.set(network, forNetwork)
  }
  return byNetwork
}

/**
 * Every scheduled-but-unexecuted registration fleet-wide, grouped by network.
 *
 * Only `queued` rows count: `executed` has already landed on-chain (the loupe shows
 * it), and `cancelled`/`failed` are terminal — a `failed` row in particular is not a
 * promise of anything, so treating it as intent would suppress a real alert forever.
 *
 * Known sharp edge, deliberately left erring toward over-alerting: a row marked
 * `failed` can still be a live, executable on-chain operation when what failed was a
 * pre-execute guard rather than execution itself. Such a row will not cover anything
 * here, so its registration reports as a hard error rather than expected-pending. If
 * you are debugging why a downgrade did not apply during a live rollout, check the
 * row's status first.
 *
 * @returns Network → (lowercased registered address → the operation registering it).
 * @throws Whatever the MongoDB driver throws; callers degrade rather than guess.
 */
export async function listPendingRegistrationsByNetwork(): Promise<
  Map<string, Map<string, IPendingRegistration>>
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
