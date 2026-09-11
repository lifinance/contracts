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

/**
 * `LibDiamond.FacetCutAction` to the role the gate grades it in. An action
 * outside the three is left unmapped rather than defaulted: the gate refuses a
 * role it has no policy for, which is the right answer for a cut nobody can
 * classify, whereas defaulting it to `FacetAdd` would grade an unknown action
 * under a policy written for a known one.
 */
const ROLE_BY_ACTION: Readonly<Record<number, AddressRoleEnum>> = {
  0: AddressRoleEnum.FacetAdd,
  1: AddressRoleEnum.FacetReplace,
  2: AddressRoleEnum.FacetRemove,
}

const referencesOfCall = (
  call: IDiamondCutCall,
  ordinal: number
): IAddressReference[] => {
  const path = `call[${call.callIndex}].diamondCut[${ordinal}]`
  const references: IAddressReference[] = []

  for (const [at, cut] of call.cuts.entries()) {
    const role = ROLE_BY_ACTION[cut.action]
    if (role === undefined) continue
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

  return references
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

  const references = calls.flatMap((call) => {
    const ordinal = seen.get(call.callIndex) ?? 0
    seen.set(call.callIndex, ordinal + 1)
    return referencesOfCall(call, ordinal)
  })

  return {
    references,
    undecodable: undecodable.map((index) => `call[${index}]`),
  }
}

/**
 * Wraps deployment records as the index the gate may decide against.
 *
 * The source is named `DeploymentRecord` only when the records really came from
 * the deploy log: it is the one source written before the proposal exists, and
 * the gate refuses to decide against any other. A caller that could not reach
 * the log passes `undefined`, which produces an unavailable index — the gate
 * then errors rather than reading an empty record as "nobody deployed this".
 *
 * @param records - Deployment entries from the deploy log, or undefined when it could not be read.
 * @param queried - The addresses the store was asked about, so an absence means something.
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
