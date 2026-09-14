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
  decodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem'

import {
  carriesAnySelectorAligned,
  collectLeafCalls,
  diamondCutCallsIn,
  type ICollectedLeafCalls,
  type IDiamondCutCall,
  type ILeafCall,
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

const REGISTER_PERIPHERY_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
])

const REGISTER_PERIPHERY_SELECTOR = toFunctionSelector(
  'registerPeripheryContract(string,address)'
).toLowerCase() as Hex

/**
 * The periphery registrations a proposal's calls reach.
 *
 * The name travels with the address because the address alone cannot be graded:
 * what the record is asked is which address it currently holds under that name,
 * and without the name there is no question to ask. A call whose selector says
 * `registerPeripheryContract` but whose arguments do not decode is reported as
 * unreadable rather than skipped — a registration nobody could read is a
 * registration nobody graded.
 *
 * @param leaves - what the proposal's single walk reached
 * @returns The references, and the identifiers of registrations that could not be read.
 */
const peripheryReferences = (
  leaves: readonly ILeafCall[]
): { references: IAddressReference[]; unreadable: string[] } => {
  const references: IAddressReference[] = []
  const unreadable: string[] = []
  const seen = new Map<number, number>()

  for (const leaf of leaves) {
    if (leaf.selector !== REGISTER_PERIPHERY_SELECTOR) {
      // A leaf this walk could not open, which could be carrying a registration.
      // `collectLeafCalls` reports the envelopes it failed on; this covers the
      // ones it never recognised as envelopes at all.
      if (carriesAnySelectorAligned(leaf.data, [REGISTER_PERIPHERY_SELECTOR]))
        unreadable.push(
          `call[${leaf.callIndex}] (carries a registerPeripheryContract selector this could not read through)`
        )
      continue
    }

    const ordinal = seen.get(leaf.callIndex) ?? 0
    seen.set(leaf.callIndex, ordinal + 1)
    const path = `call[${leaf.callIndex}].registerPeripheryContract[${ordinal}]`

    let args
    try {
      ;({ args } = decodeFunctionData({
        abi: REGISTER_PERIPHERY_ABI,
        data: leaf.data,
      }))
    } catch {
      unreadable.push(path)
      continue
    }

    references.push({
      address: args[1] as string,
      role: AddressRoleEnum.PeripheryRegistration,
      path,
      registeredName: args[0] as string,
    })
  }

  return { references, unreadable }
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
  const walked: ICollectedLeafCalls = collectLeafCalls(calldatas)
  const { calls, undecodable } = diamondCutCallsIn(walked)
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

  const periphery = peripheryReferences(walked.leaves)
  references.push(...periphery.references)
  unreadable.push(...periphery.unreadable)

  return {
    references,
    undecodable: [
      ...undecodable.map((index) => `call[${index}]`),
      ...unreadable,
    ],
  }
}

/**
 * The contract names a set of references needs the record to answer for.
 *
 * @param references - what `collectAddressReferences` recovered
 * @returns Each distinct registry name, in the order first referenced.
 */
export const referencedNames = (
  references: readonly IAddressReference[]
): string[] => [
  ...new Set(
    references
      .map((reference) => reference.registeredName)
      .filter((name): name is string => name !== undefined)
  ),
]

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
 * @param queriedNames - The contract names the log was asked about, verbatim,
 * for the same reason and with the same consequence: a name-anchored reference
 * whose name is not here reports that the record was never asked, rather than
 * reading an unasked question as an answer. Not folded — a registry name is a
 * mapping key on chain, so case is part of its identity.
 * @param unavailableReason - Why the log could not be read.
 * @returns The index `evaluateCalldataAddresses` grades against.
 */
export const buildDeploymentIndex = (
  records: readonly IDeploymentIndexEntry[] | undefined,
  queried: readonly string[],
  queriedNames: readonly string[] = [],
  unavailableReason?: string
): IDeploymentIndex =>
  records === undefined
    ? {
        source: DeploymentIndexSourceEnum.DeploymentRecord,
        available: false,
        unavailableReason:
          unavailableReason ?? 'the deployment record could not be reached',
        queried: [],
        queriedNames: [],
        entries: [],
      }
    : {
        source: DeploymentIndexSourceEnum.DeploymentRecord,
        available: true,
        queried: queried.map((address) => address.trim().toLowerCase()),
        queriedNames: [...queriedNames],
        entries: records,
      }
