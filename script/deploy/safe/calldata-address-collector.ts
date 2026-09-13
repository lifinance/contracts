/**
 * Recovers the addresses a Safe proposal references, and the deployment
 * entries to grade them against.
 *
 * Import this from a script that is about to sign a proposal;
 * `evaluateCalldataAddresses` grades what this returns. The split is the gate's
 * own: it judges addresses an extractor has already recovered and deliberately
 * does not decode calldata itself.
 *
 * Every reference carries the role it was found in, because the role — not the
 * address — decides whether failing to account for it blocks a signature. A
 * removal target that the record cannot name is a warning; an installed facet
 * that it cannot name is not.
 */

import { ZERO_ADDRESS } from '../shared/constants'
import {
  collectDiamondCutCalls,
  type IDiamondCutCall,
} from '../shared/diamond-cut-calls'

import {
  AddressRoleEnum,
  DeploymentIndexSourceEnum,
  type IAddressReference,
  type IDeploymentIndex,
  type IDeploymentIndexEntry,
} from './calldata-address-check'
import type { IPreBroadcastAuthority } from './prebroadcast-authorities'

/**
 * `LibDiamond.FacetCutAction` to the role the gate grades it in. An action
 * outside the three is left unmapped rather than defaulted, because defaulting
 * it to `FacetAdd` would grade an unknown action under a policy written for a
 * known one. Unmapped is not dropped: the cut is reported as unreadable, since
 * an address nobody graded is an unchecked address.
 */
const ROLE_BY_ACTION: Readonly<Record<number, AddressRoleEnum>> = {
  0: AddressRoleEnum.FacetAdd,
  1: AddressRoleEnum.FacetReplace,
  2: AddressRoleEnum.FacetRemove,
}

const referencesOfCall = (
  call: IDiamondCutCall,
  ordinal: number
): { references: IAddressReference[]; unreadable: string[] } => {
  const path = `call[${call.callIndex}].diamondCut[${ordinal}]`
  const references: IAddressReference[] = []
  const unreadable: string[] = []

  for (const [at, cut] of call.cuts.entries()) {
    const role = ROLE_BY_ACTION[cut.action]
    if (role === undefined) {
      unreadable.push(`${path}.cuts[${at}] (action ${cut.action})`)
      continue
    }
    references.push({
      address: cut.facetAddress,
      role,
      path: `${path}.cuts[${at}]`,
    })
  }

  // The init target is delegatecalled in the diamond's own context, so its code
  // runs against the diamond's storage exactly as a facet's would.
  references.push({
    address: call.init,
    role: AddressRoleEnum.CutInit,
    path: `${path}.init`,
  })

  return { references, unreadable }
}

/**
 * Recovers every address a proposal's calls reference, with its role.
 *
 * @param calldatas - The proposal's top-level calls, in the order they are sent.
 * @returns The references, and the identifiers of calls that could not be read through.
 */
export const collectAddressReferences = (
  calldatas: readonly `0x${string}`[]
): { references: IAddressReference[]; undecodable: string[] } => {
  const { calls, undecodable } = collectDiamondCutCalls(calldatas)
  const seen = new Map<number, number>()

  const references: IAddressReference[] = []
  const unreadable: string[] = []

  for (const call of calls) {
    const ordinal = seen.get(call.callIndex) ?? 0
    seen.set(call.callIndex, ordinal + 1)
    const perCall = referencesOfCall(call, ordinal)
    references.push(...perCall.references)
    unreadable.push(...perCall.unreadable)
  }

  return {
    references,
    undecodable: [
      ...undecodable.map((index) => `call[${index}]`),
      ...unreadable,
    ],
  }
}

/**
 * Roles in which an address is code this proposal puts into service.
 *
 * Keyed by role rather than by action number so a role added to
 * `AddressRoleEnum` has to be classified here before it compiles into the set.
 * `FacetRemove` is the one deliberate omission: a removal takes code out, and
 * `LibDiamond` requires the zero address in that slot anyway.
 */
const INSTALLING_ROLES: ReadonlySet<AddressRoleEnum> = new Set([
  AddressRoleEnum.FacetAdd,
  AddressRoleEnum.FacetReplace,
  AddressRoleEnum.CutInit,
  AddressRoleEnum.PeripheryRegistration,
])

/**
 * The contracts a proposal installs, as lowercased addresses.
 *
 * This is the subject set for the storage-authority gate (R2.6), which exists
 * because constructor args written to storage are invisible to both bytecode
 * layers. It follows that the gate has subjects only where code is being put
 * into service: a cut that only removes installs nothing, and neither the
 * diamond being cut into nor any other address the calldata merely mentions is
 * a subject — their storage is not what this proposal is introducing.
 *
 * The zero address is dropped rather than filtered by the caller: it is what
 * `LibDiamond` requires in a removal's facet slot and what a cut with no
 * initialiser carries, so it is an absence of an address, never one to read.
 *
 * @param references - Every address reference the proposal's calldata yielded.
 * @returns The addresses being installed, lowercased and deduplicated.
 */
export const installedAddresses = (
  references: readonly IAddressReference[]
): ReadonlySet<string> =>
  new Set(
    references
      .filter(
        (reference) =>
          INSTALLING_ROLES.has(reference.role) &&
          reference.address.toLowerCase() !== ZERO_ADDRESS.toLowerCase()
      )
      .map((reference) => reference.address.toLowerCase())
  )

/**
 * The authority observations gate G may grade, out of everything that was read.
 *
 * The reader observes every address the calldata names, because the record it
 * writes is a forensic trail and the pre-broadcast gate re-reads all of them to
 * catch an authority that moved during the delay window. This gate asks the
 * narrower R2.6 question, so it is handed the narrower set — and the narrowing
 * lives here, as a value a test can produce, rather than inside the CLI where
 * nothing can observe it.
 *
 * @param authorities - Every declared authority the run read.
 * @param references - Every address reference the calldata yielded.
 * @returns The observations whose contract this proposal installs.
 */
export const authoritiesOfInstalled = (
  authorities: readonly IPreBroadcastAuthority[],
  references: readonly IAddressReference[]
): readonly IPreBroadcastAuthority[] => {
  const installed = installedAddresses(references)
  return authorities.filter((authority) =>
    installed.has(authority.contractAddress.toLowerCase())
  )
}

/**
 * Wraps deployment records as the index the gate may decide against.
 *
 * The source names the deploy log because that is the only source this gate may
 * decide against — it is the one written before the proposal exists. Whether the
 * log was actually read is carried by `available`, not by the source: a caller
 * that could not reach it passes `undefined`, and the gate then errors rather
 * than reading an empty record as "nobody deployed this".
 *
 * @param records - Deployment entries from the deploy log, or undefined when it could not be read.
 * @param queried - The addresses the log was asked about, so an absence from
 * `entries` means "not deployed" rather than "not looked up". Ignored when
 * `records` is undefined, since nothing was asked.
 * @param unavailableReason - Why the log could not be read.
 * @returns The index `evaluateCalldataAddresses` grades against.
 */
export const buildDeploymentIndex = (
  records: readonly IDeploymentIndexEntry[] | undefined,
  queried: readonly string[],
  unavailableReason?: string
): IDeploymentIndex =>
  records === undefined
    ? {
        source: DeploymentIndexSourceEnum.DeploymentRecord,
        available: false,
        unavailableReason:
          unavailableReason ?? 'the deployment record could not be reached',
        queried: [],
        entries: [],
      }
    : {
        source: DeploymentIndexSourceEnum.DeploymentRecord,
        available: true,
        queried: queried.map((address) => address.trim().toLowerCase()),
        entries: records,
      }
