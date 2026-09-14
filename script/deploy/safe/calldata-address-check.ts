/**
 * Resolves the addresses a Safe proposal's calldata references against the
 * deployment record, and refuses the ones the record does not account for.
 *
 * A sign-time decision module: pure, so every refusal can be exercised against
 * real deploy-log tuples without a Safe, an RPC or a Mongo connection. It grades
 * addresses an extractor has already recovered from calldata; it does not decode
 * calldata itself, because `collectInstalledFacetAddresses`
 * (`script/deploy/shared/funnel-deploy-gate.ts`) already walks the timelock
 * envelopes and reports what it could not read through.
 *
 * This is a mistake-catcher, not a lie-catcher. The record is written by the
 * deploying machine, so a proposer who controls that machine controls what it
 * says; only an attested build (WP-2.1) makes an address's identity
 * proposer-independent. What this closes is the typo, the copied-from-another-
 * chain address, and the contract nobody deployed.
 */

import { ZERO_ADDRESS } from '../shared/constants'

/**
 * Where a set of deployment entries came from. Only `DeploymentRecord` may
 * decide a verdict; the other two are named rather than merely absent so that
 * wiring the check to one of them is a refusal instead of a silent false red,
 * and a source this enum does not name may not decide either.
 */
export enum DeploymentIndexSourceEnum {
  /**
   * The MongoDB deploy log. Written by the deploy script *before* the proposal
   * exists, so it is the only source that knows an address at sign time.
   */
  DeploymentRecord = 'deployment-record',
  /**
   * `deployments/<network>.json` and `<network>.diamond.json`. These merge to
   * `main` *after* execution, so at sign time they lack every address the
   * proposal is about.
   */
  RepoDeploymentsFile = 'repo-deployments-file',
  /**
   * `deployments/_deployments_log_file.json`. An export of the record that lags
   * and omits recent contracts entirely.
   */
  DeploymentLogExport = 'deployment-log-export',
}

/**
 * Why an address is in the calldata. The role decides whether the zero address
 * is legal and whether a failure to resolve blocks the signature or only warns.
 */
export enum AddressRoleEnum {
  /** `diamondCut` FacetCut with action Add. */
  FacetAdd = 'facet-add',
  /** `diamondCut` FacetCut with action Replace. */
  FacetReplace = 'facet-replace',
  /** `diamondCut` FacetCut with action Remove. `LibDiamond` requires zero here. */
  FacetRemove = 'facet-remove',
  /** The cut's `_init` delegatecall target. */
  CutInit = 'cut-init',
  /** The address argument of `registerPeripheryContract`. */
  PeripheryRegistration = 'periphery-registration',
}

/** How one address related to the record. */
export enum AddressGradeEnum {
  /** A record on this network, and it matches the identity the anchor expects. */
  Resolved = 'resolved',
  /** A record on this network, with no anchor-supplied identity to check it against. */
  IdentityUnchecked = 'identity-unchecked',
  /** A record on this network under a different contract name. */
  NameMismatch = 'name-mismatch',
  /** A record on this network under the expected name but a different version. */
  VersionMismatch = 'version-mismatch',
  /** Records exist, none of them on this network. */
  WrongNetwork = 'wrong-network',
  /** The store was asked and holds no record for this address anywhere. */
  Unknown = 'unknown',
  /** The store was never asked about this address, so its absence proves nothing. */
  NotQueried = 'not-queried',
  /** Not a 20-byte hex address. */
  Malformed = 'malformed',
  /** The zero address in a role that must carry a contract. */
  IllegalZero = 'illegal-zero',
  /** The zero address in the only role where it is the required value. */
  NotApplicable = 'not-applicable',
}

/** One deployment the record holds. */
export interface IDeploymentIndexEntry {
  contractName: string
  network: string
  version: string
  address: string
  /**
   * When the contract was deployed, not when the row was written. The two
   * differ across 1,679 production rows, written in 2025 and carrying 2023 or
   * 2024 deploy times, so ordering on the write time would rank a backfilled
   * first deployment above the redeploy that superseded it. Absent on an entry
   * a caller assembled without one, which leaves the name-anchored lookup
   * unable to say which record is current.
   */
  timestamp?: Date | string
}

/**
 * The deployment entries this verdict is decided against.
 *
 * `IDeploymentRecord` (`script/deploy/shared/mongo-log-utils.ts`) satisfies this
 * structurally; the fields are restated here rather than imported so that a pure
 * decision module does not pull the Mongo driver into whatever imports it.
 */
export interface IDeploymentIndex {
  source: DeploymentIndexSourceEnum
  /** False when the store could not be consulted at all. */
  available: boolean
  /** Set exactly when `available` is false. */
  unavailableReason?: string
  /**
   * The addresses the store was actually asked about, lowercase. An address
   * absent from a store that was never asked about it is not an unknown address,
   * and grading it as one would refuse honest proposals whenever a caller
   * narrowed its query.
   */
  queried: readonly string[]
  /**
   * The contract names the store was asked about, verbatim, for the same
   * reason `queried` lists addresses: a name absent from a store that was never
   * asked about it is not a name nobody deployed. Absent here means no name was
   * looked up, so every name-anchored reference reports that rather than
   * resolving against entries that were fetched for some other question.
   *
   * Verbatim rather than folded, because `PeripheryRegistryFacet` stores
   * `mapping(string => address)` and writes `s.contracts[_name]` unnormalised —
   * so `executor` and `Executor` are two different registry slots, and matching
   * them together would report a registration that lands on neither the name
   * the record knows nor the one the diamond already serves.
   */
  queriedNames?: readonly string[]
  entries: readonly IDeploymentIndexEntry[]
}

/** One address recovered from calldata, and where in it. */
export interface IAddressReference {
  address: string
  role: AddressRoleEnum
  /** Where this was found, e.g. `call[0].scheduleBatch[1].diamondCut.cuts[0]`. */
  path: string
  /**
   * The registry name a `registerPeripheryContract` call binds this address to.
   *
   * This is a lookup key, not an anchor, and the distinction is what keeps it
   * inside the rule `expectations` states. The proposer writes the name, so the
   * name cannot be what the address is checked against. What the address is
   * checked against is the record's own answer to "which address is currently
   * deployed under this name on this network" — and that answer comes from the
   * record, which was written before the proposal existed. Reversing the two
   * matters: checking instead that the record's name for this address equals
   * the calldata's name passes a stale address, because the superseded
   * deployment is still in the record under the same name.
   */
  registeredName?: string
}

/** The identity an address must have, according to something the proposer does not write. */
export interface IExpectedIdentity {
  contractName: string
  /** Checked only when present. */
  version?: string
}

/** What is being judged. */
export interface ICalldataAddressInput {
  /** Network the proposal executes on, as `config/networks.json` names it. */
  network: string
  references: readonly IAddressReference[]
  /**
   * Identities keyed by address in any case, from an anchor the proposer does
   * not control. Never from the calldata being judged: an expectation derived
   * from the proposal cannot contradict it. A refusal-bearing reference with no
   * identity here errors, so this is required rather than an enrichment —
   * except for a reference carrying {@link IAddressReference.registeredName},
   * which is anchored by the record's own answer for that name and never
   * consults this map.
   *
   * No committed file supplies this yet — `_targetState.json` holds no addresses
   * and the selector registry maps selectors to signatures — so the wiring
   * package has to name an address-bearing anchor, and that choice is the one
   * this check's whole verdict rests on.
   */
  expectations?: ReadonlyMap<string, IExpectedIdentity>
  /**
   * Identifiers of calls the extractor could not read all the way through
   * (`collectInstalledFacetAddresses`'s `undecodable`). Any entry here makes the
   * verdict an error: the references are then a subset of the proposal's
   * addresses, and grading a subset green is how an envelope becomes a bypass.
   */
  undecodable?: readonly string[]
}

/** How one reference was graded, and the record it was graded against. */
export interface IAddressFinding {
  reference: IAddressReference
  grade: AddressGradeEnum
  /** Every record the store holds for this address, any network. */
  candidates: readonly IDeploymentIndexEntry[]
  expected?: IExpectedIdentity
  /** One line naming what was found and what was expected. */
  detail: string
}

/** The decision. */
export interface ICalldataAddressVerdict {
  /** True when an address contradicts the record and must not be signed. */
  refuses: boolean
  /** True when the check could not decide. Never a pass. */
  error: boolean
  findings: readonly IAddressFinding[]
  /** Why the check could not decide. Empty unless `error`. */
  errors: readonly string[]
  /** Findings that are reported without refusing. */
  warnings: readonly string[]
  /** One line a signer can act on. Empty only when nothing is refused or errored. */
  reason: string
}

/** Roles where the record failing to account for the address blocks signing. */
const REFUSAL_BEARING_ROLES: ReadonlySet<AddressRoleEnum> = new Set([
  AddressRoleEnum.FacetAdd,
  AddressRoleEnum.FacetReplace,
  AddressRoleEnum.CutInit,
  AddressRoleEnum.PeripheryRegistration,
])

/**
 * Roles where the same failure is printed and nothing is blocked.
 *
 * T2: subtractive operations are never blocked by the unverifiability of what
 * they remove. So however little the record says about a removal target — a
 * never-queried one included — that alone neither refuses nor errors, because a
 * narrower query must not block the rollback path. A defect in the check's own
 * inputs still errors under T3: not knowing the target is tolerated, not being
 * able to read the record at all is not.
 */
const WARN_ONLY_ROLES: ReadonlySet<AddressRoleEnum> = new Set([
  AddressRoleEnum.FacetRemove,
])

/**
 * Roles where the zero address is the required value rather than a mistake.
 *
 * `registerPeripheryContract(name, address(0))` unregisters the name, and
 * [docs/DeploymentLogs.md](../../../docs/DeploymentLogs.md) names that call as
 * the cleanup proposal a deprecated periphery contract's registry residue is
 * input for. Refusing it would block a documented flow, and the removal it
 * performs is subtractive, which T2 does not block on.
 */
const ZERO_LEGAL_ROLES: ReadonlySet<AddressRoleEnum> = new Set([
  AddressRoleEnum.CutInit,
  AddressRoleEnum.FacetRemove,
  AddressRoleEnum.PeripheryRegistration,
])

const CONTRADICTING_GRADES: ReadonlySet<AddressGradeEnum> = new Set([
  AddressGradeEnum.NameMismatch,
  AddressGradeEnum.VersionMismatch,
  AddressGradeEnum.WrongNetwork,
  AddressGradeEnum.Unknown,
  AddressGradeEnum.Malformed,
  AddressGradeEnum.IllegalZero,
])

/** Grades where the record was not made to say anything either way. */
const UNANSWERED_GRADES: ReadonlySet<AddressGradeEnum> = new Set([
  AddressGradeEnum.NotQueried,
  AddressGradeEnum.IdentityUnchecked,
])

const SOURCE_REFUSALS: ReadonlyMap<DeploymentIndexSourceEnum, string> = new Map(
  [
    [
      DeploymentIndexSourceEnum.RepoDeploymentsFile,
      'deployments/<network>.json merges to main only after the proposal has been executed, so at sign time it does not contain the address the proposal is about and every new deployment would read as unknown',
    ],
    [
      DeploymentIndexSourceEnum.DeploymentLogExport,
      'deployments/_deployments_log_file.json lags the deploy log and omits recent contracts entirely, so an address it does not carry is not an address nobody deployed',
    ],
  ]
)

/**
 * Why this source may not decide, or `undefined` for the one that may.
 *
 * Decided by naming the source that may: a source added to the enum later must
 * not become authoritative by being absent from a map nobody extended.
 */
const refuseSource = (
  source: DeploymentIndexSourceEnum
): string | undefined => {
  if (source === DeploymentIndexSourceEnum.DeploymentRecord) return undefined
  return (
    SOURCE_REFUSALS.get(source) ??
    `"${source}" is not a source this check has a provenance argument for, and entries whose provenance it cannot reason about cannot tell an unrecorded address from an address this source never carried`
  )
}

const isEvmAddress = (value: string): boolean =>
  /^0x[0-9a-fA-F]{40}$/.test(value.trim())

const isZero = (value: string): boolean =>
  value.trim().toLowerCase() === ZERO_ADDRESS

const describeEntry = (entry: IDeploymentIndexEntry): string =>
  `${entry.contractName}@${entry.version || 'unversioned'} on ${entry.network}`

const describeIdentity = (identity: IExpectedIdentity): string =>
  `${identity.contractName}@${identity.version ?? 'any version'}`

/**
 * Re-keys the caller's expectations to lowercase, and reports the keys that
 * cannot be used.
 *
 * A caller assembles this map from whatever names an address, and the helpers
 * that hand one back — `getAddress`, `checksumAddress` — return the checksummed
 * form, while references arrive lowercased. A map keyed the checksummed way
 * would match no reference at all and grade every one identity-unchecked: the
 * name check the caller asked for, silently not performed. A key that is not an
 * address, and two keys that normalise together carrying different identities,
 * are reported rather than resolved, because both leave an identity the caller
 * meant to pin unpinned.
 */
const normalizeExpectations = (
  expectations?: ReadonlyMap<string, IExpectedIdentity>
): {
  identities: ReadonlyMap<string, IExpectedIdentity>
  errors: readonly string[]
} => {
  const identities = new Map<string, IExpectedIdentity>()
  const errors: string[] = []

  for (const [key, identity] of expectations ?? []) {
    if (!isEvmAddress(key)) {
      errors.push(
        `The expectations map is keyed with "${key}", which is not a 20-byte hex address, so no reference can ever match it and the identity it names would never be checked.`
      )
      continue
    }

    const normalized = key.trim().toLowerCase()
    const existing = identities.get(normalized)
    // An absent `version` means any version, so a name-only expectation and a
    // name-plus-version one for the same address agree — the second narrows the
    // first rather than contradicting it. Only two *stated* versions can
    // disagree, and merging a broad anchor with a specific one is exactly the
    // shape a caller assembling this map produces.
    const versionsDisagree =
      existing?.version !== undefined &&
      identity.version !== undefined &&
      existing.version.trim() !== identity.version.trim()
    if (
      existing !== undefined &&
      (existing.contractName.trim().toLowerCase() !==
        identity.contractName.trim().toLowerCase() ||
        versionsDisagree)
    ) {
      errors.push(
        `The expectations map names ${normalized} twice, as ${describeIdentity(
          existing
        )} and as ${describeIdentity(
          identity
        )}, so which identity this address must have is not decided.`
      )
      continue
    }

    // The narrower expectation wins: a stated version pins more than none, and
    // the two have already been shown to agree.
    identities.set(
      normalized,
      existing?.version !== undefined && identity.version === undefined
        ? existing
        : identity
    )
  }

  return { identities, errors }
}

/** `2023-07-27 16:43:51` / `2023-07-27T16:43:51` — a wall clock naming no zone. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/

/**
 * When the record says a contract was deployed, as a UTC instant.
 *
 * A zone-less timestamp is read as UTC rather than left to `Date`, which would
 * read it in whichever zone the signer's machine runs. Two signers would then
 * order the same two records differently — seven hours apart between a laptop
 * on UTC+7 and a CI runner on UTC — and reach opposite verdicts on identical
 * calldata and an identical record.
 *
 * @param entry - the record whose deploy time is wanted
 * @returns Milliseconds since the epoch, or `NaN` when there is no usable time.
 */
const deployedAt = (entry: IDeploymentIndexEntry): number => {
  const { timestamp } = entry
  if (timestamp === undefined) return Number.NaN
  if (timestamp instanceof Date) return timestamp.getTime()
  const text = timestamp.trim()
  return new Date(
    ZONELESS.test(text) ? `${text.replace(' ', 'T')}Z` : text
  ).getTime()
}

/**
 * The record's current deployment under a name on a network.
 *
 * `undecided` names why there is no single answer, and is never merged into
 * "no entry": a record that cannot say which of two deployments is current has
 * not said the address is wrong, and naming it a mismatch would put the blame
 * for the record's own ambiguity on the address. It is not the lenient outcome
 * either — for a refusal-bearing role an undecided answer errors, which stops a
 * signature just as a mismatch does; what differs is which of the two the
 * signer is told to go and fix.
 *
 * Of the two shapes, only the tie is attested in the record today: one group,
 * `Permit2Proxy` on `abstract`, holds two versions at the same second. No
 * production row is missing a deploy time, so the undated branch guards a shape
 * the record could take rather than one it takes.
 *
 * @param entries - every record the store holds
 * @param name - the registry name the calldata binds the address to
 * @param network - the network the proposal executes on
 * @returns The current entry, or why the record could not name one.
 */
const currentUnderName = (
  entries: readonly IDeploymentIndexEntry[],
  name: string,
  network: string
): { entry?: IDeploymentIndexEntry; undecided?: string } => {
  // The name is compared byte for byte: it is a mapping key on chain, not a
  // label. The network is not — it comes from repo config rather than calldata.
  const onNetwork = entries.filter(
    (entry) =>
      entry.contractName === name &&
      entry.network.trim().toLowerCase() === network.trim().toLowerCase()
  )

  if (onNetwork.length === 0) return {}

  const undated = onNetwork.filter((entry) => Number.isNaN(deployedAt(entry)))
  if (undated.length > 0)
    return {
      undecided: `${undated.length} of the ${onNetwork.length} records for "${name}" on ${network} carry no usable deploy time, so which one is current is not decided`,
    }

  const newest = Math.max(...onNetwork.map(deployedAt))
  const latest = onNetwork.filter((entry) => deployedAt(entry) === newest)
  const addresses = new Set(
    latest.map((entry) => entry.address.trim().toLowerCase())
  )

  if (addresses.size > 1)
    return {
      undecided: `the record holds ${
        addresses.size
      } different addresses for "${name}" on ${network} at the same newest deploy time (${latest
        .map(describeEntry)
        .join(', ')}), so which one is current is not decided`,
    }

  return { entry: latest[0] }
}

/**
 * Grades an address against the record's current deployment under the name the
 * calldata registers it as.
 *
 * Reached only once the address itself has resolved to this network, so a
 * disagreement here is specifically "the record has this name pointing
 * somewhere else", not "this address is unknown".
 *
 * @param reference - the reference being graded, carrying its registry name
 * @param base - the partial finding the caller has already assembled
 * @param onNetwork - the record's entries for this address on this network
 * @param input - the network and the rest of what is being judged
 * @param index - the entries and the names they were fetched for
 * @returns The finding for a name-anchored reference.
 */
const gradeAgainstName = (
  reference: IAddressReference,
  base: Omit<IAddressFinding, 'grade' | 'detail'>,
  onNetwork: readonly IDeploymentIndexEntry[],
  input: ICalldataAddressInput,
  index: IDeploymentIndex
): IAddressFinding => {
  const name = reference.registeredName ?? ''
  const address = reference.address.trim().toLowerCase()

  if (!(index.queriedNames ?? []).includes(name))
    return {
      ...base,
      grade: AddressGradeEnum.NotQueried,
      detail: `${reference.path} (${reference.address}) registers "${name}", and the record was never asked what it currently holds under that name, so its absence proves nothing`,
    }

  const { entry, undecided } = currentUnderName(
    index.entries,
    name,
    input.network
  )

  if (undecided !== undefined)
    return {
      ...base,
      grade: AddressGradeEnum.IdentityUnchecked,
      detail: `${reference.path} (${reference.address}) registers "${name}", and ${undecided}`,
    }

  if (entry === undefined)
    return {
      ...base,
      grade: AddressGradeEnum.NameMismatch,
      detail: `${reference.path} (${
        reference.address
      }) registers "${name}", and the record holds nothing under "${name}" on ${
        input.network
      } at all — it has this address as ${onNetwork
        .map(describeEntry)
        .join(', ')}`,
    }

  // Re-registering a superseded deployment — the rollback path when a fresh
  // periphery contract turns out broken — reads as a mismatch here, because the
  // record's most recent under the name is the contract being rolled back. The
  // gate reports rather than blocks, so it costs a line the signer has to
  // overrule; promoting it to a block would need an anchor for that intent.
  if (entry.address.trim().toLowerCase() !== address)
    return {
      ...base,
      grade: AddressGradeEnum.NameMismatch,
      detail: `${reference.path} registers "${name}" as ${
        reference.address
      }, and the most recent ${name} the record has on ${input.network} is ${
        entry.address
      } (${describeEntry(entry)}) — this address is ${onNetwork
        .map(describeEntry)
        .join(', ')}`,
    }

  return {
    ...base,
    grade: AddressGradeEnum.Resolved,
    detail: `${reference.path} registers "${name}" as ${
      reference.address
    }, which is the most recent ${name} the record has on ${
      input.network
    } (${describeEntry(entry)})`,
  }
}

const gradeReference = (
  reference: IAddressReference,
  input: ICalldataAddressInput,
  index: IDeploymentIndex,
  expectations: ReadonlyMap<string, IExpectedIdentity>
): IAddressFinding => {
  const expected = expectations.get(reference.address.trim().toLowerCase())
  const base = {
    reference,
    expected,
    candidates: [] as IDeploymentIndexEntry[],
  }

  if (!isEvmAddress(reference.address))
    return {
      ...base,
      grade: AddressGradeEnum.Malformed,
      detail: `${reference.path} carries "${reference.address}", which is not a 20-byte hex address, so there is nothing to look up`,
    }

  const address = reference.address.trim().toLowerCase()

  if (isZero(address))
    return ZERO_LEGAL_ROLES.has(reference.role)
      ? {
          ...base,
          grade: AddressGradeEnum.NotApplicable,
          detail: `${reference.path} is the zero address, which is the required value for ${reference.role}`,
        }
      : {
          ...base,
          grade: AddressGradeEnum.IllegalZero,
          detail: `${reference.path} is the zero address in role ${reference.role}, which has to name a deployed contract`,
        }

  if (!index.queried.some((q) => q.trim().toLowerCase() === address))
    return {
      ...base,
      grade: AddressGradeEnum.NotQueried,
      detail: `${reference.path} (${reference.address}) was never looked up, so the record says nothing about it either way`,
    }

  const candidates = index.entries.filter(
    (entry) => entry.address.trim().toLowerCase() === address
  )

  if (candidates.length === 0)
    return {
      ...base,
      grade: AddressGradeEnum.Unknown,
      detail: `${reference.path} (${reference.address}) has no deployment record on any network`,
    }

  const onNetwork = candidates.filter(
    (entry) =>
      entry.network.trim().toLowerCase() === input.network.trim().toLowerCase()
  )

  if (onNetwork.length === 0)
    return {
      ...base,
      candidates,
      grade: AddressGradeEnum.WrongNetwork,
      detail: `${reference.path} (${
        reference.address
      }) is deployed, but not on ${
        input.network
      } — the record has it as ${candidates.map(describeEntry).join(', ')}`,
    }

  // The name the calldata registers pins this address harder than any
  // `expectations` entry could, so it decides rather than being one more check
  // layered on top.
  if (reference.registeredName !== undefined)
    return gradeAgainstName(
      reference,
      { ...base, candidates },
      onNetwork,
      input,
      index
    )

  if (expected === undefined)
    return {
      ...base,
      candidates,
      grade: AddressGradeEnum.IdentityUnchecked,
      detail: `${reference.path} (${reference.address}) is ${onNetwork
        .map(describeEntry)
        .join(
          ', '
        )}; no anchor named what it should be, so the name was reported and not verified`,
    }

  const nameMatches = onNetwork.filter(
    (entry) =>
      entry.contractName.trim().toLowerCase() ===
      expected.contractName.trim().toLowerCase()
  )

  if (nameMatches.length === 0)
    return {
      ...base,
      candidates,
      grade: AddressGradeEnum.NameMismatch,
      detail: `${reference.path} (${reference.address}) should be ${
        expected.contractName
      } on ${input.network}, and the record has it as ${onNetwork
        .map(describeEntry)
        .join(', ')}`,
    }

  if (
    expected.version !== undefined &&
    !nameMatches.some(
      (entry) => entry.version.trim() === expected.version?.trim()
    )
  )
    return {
      ...base,
      candidates,
      grade: AddressGradeEnum.VersionMismatch,
      detail: `${reference.path} (${reference.address}) should be ${
        expected.contractName
      }@${expected.version} on ${
        input.network
      }, and the record has it as ${nameMatches.map(describeEntry).join(', ')}`,
    }

  return {
    ...base,
    candidates,
    grade: AddressGradeEnum.Resolved,
    detail: `${reference.path} (${reference.address}) is ${
      expected.contractName
    }${expected.version === undefined ? '' : `@${expected.version}`} on ${
      input.network
    }, as expected`,
  }
}

/**
 * Grades every address a proposal references against the deployment record.
 *
 * Errors — rather than passing — whenever the check could not be made: an
 * unavailable store, a source that may not decide, a call the extractor could
 * not read through, an unusable expectations key, or a role this module has no
 * policy for. An unanswerable question is not an answer of yes.
 *
 * Two of those are narrower, and only they turn on the role: an address nobody
 * looked up, and an identity no anchor named, error for a refusal-bearing
 * reference and warn for a removal target. The rest are defects in the check's
 * own inputs, so they hold whatever the proposal asks for — the role-with-no-
 * policy case necessarily so, since it fires exactly when the role is in
 * neither set.
 * @param input - the network, the references, and the anchor-supplied identities
 * @param index - deployment entries and where they came from
 * @returns Whether to refuse, whether the check could decide, and a finding per reference
 */
export const evaluateCalldataAddresses = (
  input: ICalldataAddressInput,
  index: IDeploymentIndex
): ICalldataAddressVerdict => {
  const { identities, errors: expectationErrors } = normalizeExpectations(
    input.expectations
  )
  const errors: string[] = [...expectationErrors]

  const sourceRefusal = refuseSource(index.source)
  if (sourceRefusal !== undefined)
    errors.push(
      `Addresses were resolved against ${index.source}, which cannot decide this: ${sourceRefusal}. The deployment record is the only source written before the proposal exists.`
    )

  if (!index.available)
    errors.push(
      `The deployment record could not be read${
        index.unavailableReason ? `: ${index.unavailableReason}` : ''
      }, so no address in this proposal was checked against it.`
    )

  for (const call of input.undecodable ?? [])
    errors.push(
      `${call} could not be read all the way through, so the addresses listed here are only the ones that were readable and this proposal may reference others.`
    )

  // A source that may not decide decides nothing: grading its entries would
  // produce refusals whose reason is the source, reported as if the address were
  // at fault.
  const decidable = index.available && sourceRefusal === undefined

  const findings = decidable
    ? input.references.map((reference) =>
        gradeReference(reference, input, index, identities)
      )
    : input.references.map((reference) => ({
        reference,
        candidates: [] as IDeploymentIndexEntry[],
        expected: identities.get(reference.address.trim().toLowerCase()),
        grade: AddressGradeEnum.NotQueried,
        detail: `${reference.path} (${reference.address}) was not checked against the deployment record`,
      }))

  const refusing: IAddressFinding[] = []
  const warnings: string[] = []

  for (const finding of findings) {
    const { role } = finding.reference

    // A role neither set names has no answer to "does failing to resolve this
    // refuse?", and an unanswerable question is not an answer of no.
    if (!REFUSAL_BEARING_ROLES.has(role) && !WARN_ONLY_ROLES.has(role)) {
      errors.push(
        `${finding.reference.path} (${finding.reference.address}) is in role "${role}", which this check has no refusal policy for, so whether the record accounting for it is required was never decided.`
      )
      continue
    }

    const refusalBearing = REFUSAL_BEARING_ROLES.has(role)

    if (UNANSWERED_GRADES.has(finding.grade)) {
      if (refusalBearing) errors.push(finding.detail)
      else warnings.push(finding.detail)
      continue
    }

    if (CONTRADICTING_GRADES.has(finding.grade)) {
      if (refusalBearing) refusing.push(finding)
      else warnings.push(finding.detail)
    }
  }

  const refuses = refusing.length > 0
  const error = errors.length > 0

  return {
    refuses,
    error,
    findings,
    errors,
    warnings,
    reason: refuses
      ? `${refusing.length} of ${
          input.references.length
        } addresses in this proposal's calldata do not match the deployment record for ${
          input.network
        }: ${refusing.map((finding) => finding.detail).join('; ')}`
      : error
      ? errors.join(' ')
      : '',
  }
}

const ESC = String.fromCharCode(27)
const REFUSED = `${ESC}[31m⛔ REFUSED${ESC}[0m`
const CANNOT_CHECK = `${ESC}[31m⛔ CANNOT CHECK${ESC}[0m`
const WARN = `${ESC}[33m⚠${ESC}[0m`
const OK = `${ESC}[32m✓${ESC}[0m`

/**
 * The lines a signer sees.
 *
 * A verdict with nothing to say still prints a line, because silence would make
 * "the check found nothing wrong" and "the check was never wired" look
 * identical from the terminal. A proposal that references no address at all
 * gets a different line from one whose addresses resolved, so that the count of
 * verified addresses is never zero on a line claiming verification.
 * @param verdict - what `evaluateCalldataAddresses` decided
 * @returns One or more display lines
 */
export const renderCalldataAddresses = (
  verdict: ICalldataAddressVerdict
): string[] => {
  const lines: string[] = []

  for (const message of verdict.errors) lines.push(`${CANNOT_CHECK} ${message}`)

  for (const finding of verdict.findings)
    if (
      CONTRADICTING_GRADES.has(finding.grade) &&
      REFUSAL_BEARING_ROLES.has(finding.reference.role)
    )
      lines.push(`${REFUSED} ${finding.detail}`)

  for (const message of verdict.warnings) lines.push(`${WARN} ${message}`)

  if (!verdict.refuses && !verdict.error) {
    if (verdict.findings.length === 0)
      lines.push(
        `${OK} Calldata address check skipped: no call in this proposal references an address.`
      )
    else {
      const resolved = verdict.findings.filter(
        (finding) => finding.grade === AddressGradeEnum.Resolved
      ).length
      lines.push(
        `${OK} ${resolved} of ${verdict.findings.length} calldata addresses resolved to the deployment record with the expected name and version.`
      )
    }
  }

  return lines
}

/**
 * Throws unless every address the calldata references is accounted for.
 *
 * Separate from the evaluation so that a call site cannot reduce the verdict to
 * a boolean and then forget to read it.
 * @param verdict - what `evaluateCalldataAddresses` decided
 * @throws When an address contradicts the record, or the check could not decide
 */
export const assertCalldataAddressesResolve = (
  verdict: ICalldataAddressVerdict
): void => {
  if (!verdict.refuses && !verdict.error) return

  throw new Error(
    `Calldata address check: this transaction will not be signed. ${verdict.reason} Nothing has been signed.`
  )
}
