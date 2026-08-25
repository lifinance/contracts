/**
 * Scheduled-but-not-yet-executed diamond registrations, read from the timelock
 * execution queue.
 *
 * A production rollout merges its `_targetState.json` entry before the diamond cut
 * runs, so between merge and execution the registration invariants see a facet the
 * target state expects and the loupe does not route yet. This module supplies the
 * missing intent: the set of addresses a *queued* timelock operation would register.
 *
 * Intent is read for **alerting only**. It downgrades an alert whose remediation is
 * "wait"; it never feeds a generator. A bad queue read costs a false alert or reduced
 * coverage and self-corrects on the next run, whereas letting intent decide what a
 * deploy log records leaves a wrong file in git with no owner for the compensating
 * write (`.agents/rules/601-healthcheck-invariants.md`, docs/DeploymentLogs.md).
 *
 * The queue — not the Safe proposal collection — is the source on purpose:
 *
 * - It lives on the un-gated `MONGODB_URI` cluster the parked-task queue already
 *   uses, so the health-check workflows reach it with no new secret. The Safe
 *   collection needs `SC_MONGODB_URI` behind the `lifi-connect` tunnel, which the
 *   health-check workflows do not have — sourcing intent there would make the
 *   downgrade permanently inert in CI, the one place it matters.
 * - A `queued` row means the Safe transaction already executed `scheduleBatch`, so
 *   the operation is live on the timelock and will execute once the delay elapses.
 *   An unsigned Safe proposal may never be signed; treating it as intent would
 *   over-claim. `queued` is the point at which the addition is actually committed.
 */

import { decodeFunctionData, isAddress, parseAbi, type Hex } from 'viem'

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
      const actionNum =
        typeof action === 'bigint' ? Number(action) : Number(action)
      if (!ROUTING_CUT_ACTIONS.has(actionNum)) continue
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
    if (typeof peripheryAddress === 'string' && isAddress(peripheryAddress))
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
 * Every scheduled-but-unexecuted registration fleet-wide, grouped by network.
 *
 * Only `queued` rows count: `executed` has already landed on-chain (the loupe shows
 * it), and `cancelled`/`failed` are terminal — a `failed` row in particular is not a
 * promise of anything, so treating it as intent would suppress a real alert forever.
 *
 * @returns Network → (lowercased registered address → the operation registering it).
 * @throws Whatever the MongoDB driver throws; callers degrade rather than guess.
 */
export async function listPendingRegistrationsByNetwork(): Promise<
  Map<string, Map<string, IPendingRegistration>>
> {
  const { client, timelockQueue } = await getTimelockQueueCollection()
  try {
    const queued = await timelockQueue
      .find<ITimelockQueueDoc>({ status: 'queued' })
      .toArray()
    const byNetwork = new Map<string, Map<string, IPendingRegistration>>()
    for (const doc of queued) {
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
  } finally {
    await client.close()
  }
}
