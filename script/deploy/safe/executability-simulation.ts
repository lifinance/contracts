/**
 * Decides whether a Safe proposal would revert if it were executed now, and
 * grades every reason it found by how much the answer can be trusted.
 *
 * A sign-time decision module: pure, so every refusal can be exercised against
 * a real diamond's selector map without a Safe, a signer or a broadcast. It
 * grades payloads a decoder has already recovered from calldata together with
 * the chain reads a collector has already made; it neither decodes nor reads.
 *
 * Two grades of answer, and the verdict says which one it is holding. A
 * **proven** revert follows from the calldata alone — no chain state can make
 * that payload succeed, so the finding cannot be wrong. A **predicted** revert
 * follows from state read a moment ago, which another execution can move before
 * this proposal reaches the front of the queue. Nothing here is evidence that a
 * proposal is *benign*: a payload that executes cleanly is still whatever it
 * was, and that stays the codehash gate's question.
 */

import { ZERO_ADDRESS } from '../shared/constants'

/** The `FacetCutAction` values `LibDiamond` defines. */
export enum FacetCutActionEnum {
  Add = 0,
  Replace = 1,
  Remove = 2,
}

/** How far a finding can be trusted. */
export enum RevertCertaintyEnum {
  /**
   * Follows from the payload's own bytes. No state this proposal could meet
   * makes it execute, so the finding holds however stale the chain reads are.
   */
  Proven = 'proven',
  /**
   * Follows from chain state as it was read. A cut queued ahead of this one, a
   * later deployment or an advancing nonce can each turn the answer over.
   */
  Predicted = 'predicted',
}

/**
 * What a finding says will happen. The names of the `diamondCut` cases are the
 * custom errors `LibDiamond` reverts with, so an operator can grep the source
 * for the line that will fire.
 */
export enum ExecutabilityFindingEnum {
  /** A `Remove` cut whose facet address is not zero. */
  FacetAddressIsNotZero = 'FacetAddressIsNotZero',
  /** An `Add` or `Replace` cut whose facet address is zero. */
  FacetAddressIsZero = 'FacetAddressIsZero',
  /** A cut carrying no selectors. */
  NoSelectorsInFace = 'NoSelectorsInFace',
  /** A cut action outside `Add` / `Replace` / `Remove`. */
  IncorrectFacetCutAction = 'IncorrectFacetCutAction',
  /** `_init` is zero and `_calldata` is not empty. */
  InitZeroButCalldataNotEmpty = 'InitZeroButCalldataNotEmpty',
  /** `_init` is not zero and `_calldata` is empty. */
  CalldataEmptyButInitNotZero = 'CalldataEmptyButInitNotZero',
  /** A selector this cut adds is already served. */
  FunctionAlreadyExists = 'FunctionAlreadyExists',
  /** A selector this cut replaces or removes is served by nobody. */
  FunctionDoesNotExist = 'FunctionDoesNotExist',
  /** A selector this cut replaces or removes is defined on the diamond itself. */
  FunctionIsImmutable = 'FunctionIsImmutable',
  /** A facet or `_init` address that holds no code. */
  FacetContainsNoCode = 'FacetContainsNoCode',
  /** The caller is not the diamond's owner. */
  OnlyContractOwner = 'OnlyContractOwner',
  /** The nonce this proposal is built at has already been consumed. */
  NonceAlreadyUsed = 'NonceAlreadyUsed',
  /** Another pending proposal is built at the same nonce. */
  NonceCollision = 'NonceCollision',
  /** The nonce sits beyond a gap no pending proposal fills. */
  NonceGap = 'NonceGap',
  /** `eth_call` of this payload reverted. */
  StaticCallReverted = 'static-call-reverted',
  /** A call carrying a function selector whose target holds no code. */
  TargetHasNoCode = 'target-has-no-code',
  /** The broadcasting account cannot pay for the transaction. */
  ExecutorUnderfunded = 'executor-underfunded',
}

/** One `FacetCut`, as a decoder recovered it. */
export interface IFacetCutInput {
  /**
   * Typed `number` rather than {@link FacetCutActionEnum} because the value
   * arrives through a decode and can therefore hold anything at runtime.
   */
  action: number
  facetAddress: string
  selectors: readonly string[]
  /** Where this cut sits, e.g. `call[0].scheduleBatch[1].diamondCut.cuts[0]`. */
  path: string
}

/** A `diamondCut` call Tier-0 models element by element. */
export interface IDiamondCutPayload {
  kind: 'diamond-cut'
  /** Where this call sits in the proposal. */
  path: string
  /** The diamond the cut executes against. */
  diamond: string
  /** The account the diamond will see as `msg.sender` — the Safe or the timelock. */
  caller: string
  cuts: readonly IFacetCutInput[]
  init: string
  /** `_calldata` as hex. `0x` and the empty string both mean absent. */
  initCalldata: string
}

/** A call Tier-0 has no revert model for, carried so it cannot be silently dropped. */
export interface IOpaquePayload {
  kind: 'opaque'
  /** Where this call sits in the proposal. */
  path: string
  /** What the call is, for the operator's line. */
  description: string
  target: string
  /** Bytes of calldata. Zero means a plain value transfer. */
  calldataLength: number
}

export type TSimulatedPayload = IDiamondCutPayload | IOpaquePayload

/**
 * Chain reads a collector made, keyed lowercase.
 *
 * A key being absent means the collector never asked, which is not the same as
 * an answer of no — grading an unasked question would refuse honest proposals
 * whenever a caller narrowed its reads, so every map below reports absence as
 * an unchecked finding rather than as a revert.
 */
export interface IChainObservations {
  /** False when no read succeeded at all. */
  available: boolean
  /** Set exactly when `available` is false. */
  unavailableReason?: string
  /** Selector to the facet address serving it, {@link ZERO_ADDRESS} for none. */
  selectorFacets: ReadonlyMap<string, string>
  /** Address to whether `eth_getCode` returned any code. */
  hasCode: ReadonlyMap<string, boolean>
  /** Diamond address to the owner it reports. */
  owners: ReadonlyMap<string, string>
}

/** The outcome of one `eth_call` against the payload at `path`. */
export interface IStaticCallObservation {
  /** The payload this call simulated, matched against {@link TSimulatedPayload.path}. */
  path: string
  outcome: 'succeeded' | 'reverted' | 'errored'
  /**
   * The account the call was made from. Must be the account that will really
   * send it — the timelock for a timelock-wrapped batch, the Safe for a direct
   * transaction — because every `diamondCut` is owner-gated and a call made
   * from anyone else reverts for a reason the proposal is not responsible for.
   */
  from: string
  /** The revert reason the node returned, decoded if it could be. */
  revertReason?: string
  /** Why the call could not be made. Set exactly when `outcome` is `errored`. */
  errorReason?: string
}

/** Whether the account that broadcasts can pay for it. */
export interface IExecutorFunding {
  executor: string
  /** Wei the executor holds. Absent when it was not read. */
  balanceWei?: bigint
  /** Wei the broadcast is estimated to cost. Absent when it was not estimated. */
  estimatedCostWei?: bigint
}

/** How the proposal's nonce relates to the Safe's. */
export interface INonceObservation {
  /** Nonce the proposal is built at. */
  proposalNonce: number
  /** The Safe's nonce on chain. Absent when it was not read. */
  safeNonce?: number
  /** Nonces of the Safe's other pending proposals, when the caller listed them. */
  pendingNonces?: readonly number[]
}

/** Everything one verdict is decided from. */
export interface IExecutabilityInput {
  /** Network the proposal executes on, as `config/networks.json` names it. */
  network: string
  /**
   * The proposal's payloads **in execution order**.
   *
   * Load-bearing: a selector one payload moves is what the next one meets, so a
   * caller that groups by target or sorts by path rather than preserving the
   * order the proposal executes in gets a verdict about a proposal nobody will
   * submit.
   */
  payloads: readonly TSimulatedPayload[]
  observations: IChainObservations
  /**
   * `eth_call` results. `attempted: false` is itself an error: Tier-0's stated
   * mechanism is simulating the inner payloads, so a verdict reached without
   * one is a narrower check reported under the same name.
   */
  staticCalls: {
    attempted: boolean
    results: readonly IStaticCallObservation[]
  }
  nonce?: INonceObservation
  funding?: IExecutorFunding
  /**
   * Identifiers of calls the decoder could not read all the way through. Any
   * entry makes the verdict an error: the payloads are then a subset of the
   * proposal, and simulating a subset cleanly is how an envelope becomes a
   * bypass.
   */
  undecodable?: readonly string[]
}

/** One reason this proposal would not execute. */
export interface IExecutabilityFinding {
  code: ExecutabilityFindingEnum
  certainty: RevertCertaintyEnum
  /** Where in the proposal, e.g. `call[0].diamondCut.cuts[2]`. */
  path: string
  /** The cut action this finding is about, when it is about one. */
  action?: number
  /**
   * True when the proof rests on what an *earlier payload* in this proposal
   * does, rather than on this payload's own bytes.
   *
   * A node simulates each call against the state before the proposal runs, so a
   * proof of this kind is invisible to that payload's own `eth_call` — a
   * succeeding call is then the expected result rather than a contradiction.
   */
  composed?: boolean
  /** One line naming what will happen and what was read. */
  detail: string
  /**
   * True when this finding blocks. False for the findings T2 keeps warn-only
   * and for the ones a top-up or a queue pass resolves.
   */
  blocking: boolean
}

/** The decision. */
export interface IExecutabilityVerdict {
  /** True when this proposal must not be signed: it would not execute. */
  refuses: boolean
  /** True when the simulation could not be made. Never a pass. */
  error: boolean
  findings: readonly IExecutabilityFinding[]
  /** Why the simulation could not decide. Empty unless `error`. */
  errors: readonly string[]
  /** Findings reported without blocking. */
  warnings: readonly string[]
  /** Payload paths Tier-0 has no revert model for. */
  notSimulated: readonly string[]
  /** One line a signer can act on. Empty only when nothing is refused or errored. */
  reason: string
}

const EMPTY_CALLDATA: ReadonlySet<string> = new Set(['', '0x', '0X'])

const KNOWN_ACTIONS: ReadonlySet<number> = new Set([
  FacetCutActionEnum.Add,
  FacetCutActionEnum.Replace,
  FacetCutActionEnum.Remove,
])

const normalise = (value: string): string => value.trim().toLowerCase()

const isZero = (value: string): boolean => normalise(value) === ZERO_ADDRESS

const isEvmAddress = (value: string): boolean =>
  /^0x[0-9a-fA-F]{40}$/.test(value.trim())

const describeAction = (action: number): string =>
  KNOWN_ACTIONS.has(action)
    ? `${action === FacetCutActionEnum.Add ? 'an' : 'a'} ${
        FacetCutActionEnum[action]
      }`
    : `a cut with action ${action}`

/**
 * Whether a predicted revert on this cut may block.
 *
 * T2 rules subtractive operations warn-only, and the state-dependent reason a
 * `Remove` fails is that the selector is not where the map said it was — which
 * is exactly the unverifiability of what is being removed that T2 refuses to
 * block a rollback over. A **proven** revert on a `Remove` is not that: it is a
 * cut that cannot execute whatever anyone verifies, and letting it through
 * spends a threshold of human signatures on a transaction that reverts. So
 * certainty, not action, decides.
 */
const mayBlock = (action: number, certainty: RevertCertaintyEnum): boolean =>
  certainty === RevertCertaintyEnum.Proven ||
  action !== FacetCutActionEnum.Remove

const gradeCutShape = (cut: IFacetCutInput): IExecutabilityFinding[] => {
  const findings: IExecutabilityFinding[] = []
  const proven = RevertCertaintyEnum.Proven

  if (!KNOWN_ACTIONS.has(cut.action))
    findings.push({
      code: ExecutabilityFindingEnum.IncorrectFacetCutAction,
      certainty: proven,
      path: cut.path,
      action: cut.action,
      detail: `${cut.path} carries cut action ${cut.action}, and only 0 (Add), 1 (Replace) and 2 (Remove) exist`,
      blocking: true,
    })

  if (cut.selectors.length === 0)
    findings.push({
      code: ExecutabilityFindingEnum.NoSelectorsInFace,
      certainty: proven,
      path: cut.path,
      action: cut.action,
      detail: `${cut.path} is ${describeAction(
        cut.action
      )} cut with no selectors, which LibDiamond rejects before it looks at anything else`,
      blocking: true,
    })

  if (cut.action === FacetCutActionEnum.Remove) {
    if (!isZero(cut.facetAddress))
      findings.push({
        code: ExecutabilityFindingEnum.FacetAddressIsNotZero,
        certainty: proven,
        path: cut.path,
        action: cut.action,
        detail: `${cut.path} is a Remove cut naming facet ${cut.facetAddress}; a removal points the diamond at no new code, so LibDiamond requires the zero address here and reverts on anything else`,
        blocking: true,
      })
  } else if (KNOWN_ACTIONS.has(cut.action) && isZero(cut.facetAddress))
    findings.push({
      code: ExecutabilityFindingEnum.FacetAddressIsZero,
      certainty: proven,
      path: cut.path,
      action: cut.action,
      detail: `${cut.path} is ${describeAction(
        cut.action
      )} cut with the zero facet address, so there is no code to route these selectors to`,
      blocking: true,
    })

  return findings
}

const gradeInit = (
  payload: IDiamondCutPayload,
  observations: IChainObservations,
  unchecked: string[]
): IExecutabilityFinding[] => {
  const findings: IExecutabilityFinding[] = []
  const calldataEmpty = EMPTY_CALLDATA.has(payload.initCalldata.trim())

  if (isZero(payload.init)) {
    if (!calldataEmpty)
      findings.push({
        code: ExecutabilityFindingEnum.InitZeroButCalldataNotEmpty,
        certainty: RevertCertaintyEnum.Proven,
        path: `${payload.path}._init`,
        detail: `${payload.path} has no _init target but carries ${payload.initCalldata.length} characters of _calldata, which LibDiamond rejects`,
        blocking: true,
      })
    return findings
  }

  if (calldataEmpty) {
    findings.push({
      code: ExecutabilityFindingEnum.CalldataEmptyButInitNotZero,
      certainty: RevertCertaintyEnum.Proven,
      path: `${payload.path}._init`,
      detail: `${payload.path} names _init ${payload.init} with empty _calldata, so there is nothing to delegatecall and LibDiamond reverts`,
      blocking: true,
    })
    return findings
  }

  // The diamond delegatecalling itself skips the code check, and it has code by
  // definition — it is executing.
  if (normalise(payload.init) === normalise(payload.diamond)) return findings

  const hasCode = observations.hasCode.get(normalise(payload.init))
  if (hasCode === undefined) {
    unchecked.push(
      `${payload.path}._init (${payload.init}) was never checked for code, so whether it can be delegatecalled is unknown`
    )
    return findings
  }

  if (!hasCode)
    findings.push({
      code: ExecutabilityFindingEnum.FacetContainsNoCode,
      certainty: RevertCertaintyEnum.Predicted,
      path: `${payload.path}._init`,
      detail: `${payload.path} names _init ${payload.init}, which holds no code`,
      blocking: true,
    })

  return findings
}

const gradeOwner = (
  payload: IDiamondCutPayload,
  observations: IChainObservations,
  unchecked: string[]
): IExecutabilityFinding[] => {
  const owner = observations.owners.get(normalise(payload.diamond))

  if (owner === undefined) {
    unchecked.push(
      `the owner of ${payload.diamond} was never read, so whether ${payload.caller} may cut it is unknown`
    )
    return []
  }

  if (normalise(owner) === normalise(payload.caller)) return []

  return [
    {
      code: ExecutabilityFindingEnum.OnlyContractOwner,
      certainty: RevertCertaintyEnum.Predicted,
      path: payload.path,
      detail: `${payload.path} would be sent by ${payload.caller}, and ${payload.diamond} reports its owner as ${owner}; diamondCut is owner-gated, so the whole call reverts`,
      blocking: true,
    },
  ]
}

/** A selector an earlier cut moved, and which payload moved it. */
interface IAmendedSelector {
  facet: string
  /** `path` of the payload whose cut moved it. */
  byPayload: string
}

/**
 * Grades every selector in a `diamondCut`, walking the cuts in order against a
 * selector map amended by the cuts before them.
 *
 * The sequential walk is what makes a batch answerable at all: a cut that
 * removes a selector and a later cut that adds it back are each wrong against
 * the diamond as it stands now and right against the state the batch produces.
 * A conflict the proposal creates within itself is therefore proven, while one
 * against the diamond's own map is predicted.
 *
 * The walk spans the whole proposal, not one payload: a `multiSend` or a
 * `scheduleBatch` can carry two `diamondCut` calls against the same diamond, and
 * each is clean read alone while the second reverts once the first has run. The
 * accumulator is keyed by diamond, because a selector moved on one diamond says
 * nothing about another.
 * The accumulator is keyed by the normalised diamond and mutated as each payload
 * is walked, so a selector one payload moves is what the next one meets.
 */
const gradeSelectors = (
  payload: IDiamondCutPayload,
  observations: IChainObservations,
  unchecked: string[],
  amendedByDiamond: Map<string, Map<string, IAmendedSelector>>
): IExecutabilityFinding[] => {
  const findings: IExecutabilityFinding[] = []
  const diamond = normalise(payload.diamond)
  const existing = amendedByDiamond.get(diamond)
  const amended = existing ?? new Map<string, IAmendedSelector>()
  if (existing === undefined) amendedByDiamond.set(diamond, amended)

  for (const cut of payload.cuts) {
    if (!KNOWN_ACTIONS.has(cut.action)) continue
    const facet = normalise(cut.facetAddress)

    for (const [index, rawSelector] of cut.selectors.entries()) {
      const selector = normalise(rawSelector)
      const at = `${cut.path}.selectors[${index}]`
      const moved = amended.get(selector)
      const observed = observations.selectorFacets.get(selector)
      const current = moved === undefined ? observed : moved.facet
      // Proven only where the proposal itself put the selector where it is: the
      // diamond's own map is a read that another execution can invalidate.
      const certainty =
        moved === undefined
          ? RevertCertaintyEnum.Predicted
          : RevertCertaintyEnum.Proven
      // An earlier payload's doing is invisible to this payload's own
      // `eth_call`, which a node runs against the state before the proposal
      // does anything. Within one payload the cuts run in a single call, so
      // that conflict does show up there.
      const composed = moved !== undefined && moved.byPayload !== payload.path
      const source =
        moved === undefined
          ? 'on chain'
          : composed
          ? 'by an earlier call in this proposal'
          : 'by an earlier cut in this same call'

      if (current === undefined) {
        unchecked.push(
          `${at} (${rawSelector}) was never looked up on ${
            payload.diamond
          }, so whether ${describeAction(cut.action)} of it succeeds is unknown`
        )
        continue
      }

      const servedBy = isZero(current) ? undefined : current

      if (cut.action === FacetCutActionEnum.Add) {
        if (servedBy !== undefined)
          findings.push({
            code: ExecutabilityFindingEnum.FunctionAlreadyExists,
            certainty,
            composed,
            path: at,
            action: cut.action,
            detail: `${at} adds ${rawSelector}, which is already served by ${servedBy} ${source}`,
            blocking: mayBlock(cut.action, certainty),
          })
        amended.set(selector, { facet, byPayload: payload.path })
        continue
      }

      if (cut.action === FacetCutActionEnum.Replace) {
        if (servedBy === undefined)
          findings.push({
            code: ExecutabilityFindingEnum.FunctionDoesNotExist,
            certainty,
            composed,
            path: at,
            action: cut.action,
            detail: `${at} replaces ${rawSelector}, which is served by nobody ${source}`,
            blocking: mayBlock(cut.action, certainty),
          })
        else if (servedBy === facet)
          findings.push({
            code: ExecutabilityFindingEnum.FunctionAlreadyExists,
            certainty,
            composed,
            path: at,
            action: cut.action,
            detail: `${at} replaces ${rawSelector} with ${cut.facetAddress}, which already serves it ${source}, so the cut is a no-op LibDiamond rejects`,
            blocking: mayBlock(cut.action, certainty),
          })
        else if (servedBy === diamond)
          findings.push({
            code: ExecutabilityFindingEnum.FunctionIsImmutable,
            certainty,
            composed,
            path: at,
            action: cut.action,
            detail: `${at} replaces ${rawSelector}, which is defined on the diamond itself and cannot be moved`,
            blocking: mayBlock(cut.action, certainty),
          })
        amended.set(selector, { facet, byPayload: payload.path })
        continue
      }

      if (servedBy === undefined)
        findings.push({
          code: ExecutabilityFindingEnum.FunctionDoesNotExist,
          certainty,
          composed,
          path: at,
          action: cut.action,
          detail: `${at} removes ${rawSelector}, which is served by nobody ${source}`,
          blocking: mayBlock(cut.action, certainty),
        })
      else if (servedBy === diamond)
        findings.push({
          code: ExecutabilityFindingEnum.FunctionIsImmutable,
          certainty,
          composed,
          path: at,
          action: cut.action,
          detail: `${at} removes ${rawSelector}, which is defined on the diamond itself and cannot be removed`,
          blocking: mayBlock(cut.action, certainty),
        })
      amended.set(selector, {
        facet: ZERO_ADDRESS,
        byPayload: payload.path,
      })
    }
  }

  return findings
}

const gradeFacetCode = (
  payload: IDiamondCutPayload,
  observations: IChainObservations,
  unchecked: string[]
): IExecutabilityFinding[] => {
  const findings: IExecutabilityFinding[] = []
  const seen = new Set<string>()

  for (const cut of payload.cuts) {
    if (cut.action === FacetCutActionEnum.Remove) continue
    if (!KNOWN_ACTIONS.has(cut.action)) continue
    if (!isEvmAddress(cut.facetAddress) || isZero(cut.facetAddress)) continue

    const facet = normalise(cut.facetAddress)
    if (seen.has(facet)) continue
    seen.add(facet)

    const hasCode = observations.hasCode.get(facet)
    if (hasCode === undefined) {
      unchecked.push(
        `${cut.path} names facet ${cut.facetAddress}, which was never checked for code`
      )
      continue
    }

    // LibDiamond only reaches its code check for a facet that serves no
    // selectors yet, but an address holding no code has none by construction —
    // and routing selectors at an empty address is a mistake at any depth.
    if (!hasCode)
      findings.push({
        code: ExecutabilityFindingEnum.FacetContainsNoCode,
        certainty: RevertCertaintyEnum.Predicted,
        path: cut.path,
        action: cut.action,
        detail: `${cut.path} is ${describeAction(
          cut.action
        )} cut naming facet ${cut.facetAddress}, which holds no code`,
        blocking: true,
      })
  }

  return findings
}

const gradeOpaque = (
  payload: IOpaquePayload,
  observations: IChainObservations,
  unchecked: string[]
): IExecutabilityFinding[] => {
  if (payload.calldataLength === 0) return []

  const hasCode = observations.hasCode.get(normalise(payload.target))
  if (hasCode === undefined) {
    unchecked.push(
      `${payload.path} targets ${payload.target}, which was never checked for code`
    )
    return []
  }
  if (hasCode) return []

  // A call to an address with no code does not revert — it returns empty and
  // the Safe records success. So this is the one finding that is not about a
  // revert: it is a proposal that spends a threshold of signatures to do
  // nothing, which no later state can turn into the call it was written to be.
  return [
    {
      code: ExecutabilityFindingEnum.TargetHasNoCode,
      certainty: RevertCertaintyEnum.Predicted,
      path: payload.path,
      detail: `${payload.path} calls ${payload.description} on ${payload.target}, which holds no code; the call will not revert, it will silently do nothing`,
      blocking: true,
    },
  ]
}

const gradeNonce = (nonce: INonceObservation): IExecutabilityFinding[] => {
  if (nonce.safeNonce === undefined) return []

  if (nonce.proposalNonce < nonce.safeNonce)
    // Proven despite resting on a chain read: a Safe nonce only ever rises, so
    // no state this proposal could meet brings it back.
    return [
      {
        code: ExecutabilityFindingEnum.NonceAlreadyUsed,
        certainty: RevertCertaintyEnum.Proven,
        path: 'nonce',
        detail: `this proposal is built at nonce ${nonce.proposalNonce} and the Safe is already at ${nonce.safeNonce}; a Safe nonce only rises, so this can never execute and has to be rebuilt`,
        blocking: true,
      },
    ]

  const others = (nonce.pendingNonces ?? []).filter(
    (candidate) => candidate === nonce.proposalNonce
  )
  if (others.length > 0)
    return [
      {
        code: ExecutabilityFindingEnum.NonceCollision,
        certainty: RevertCertaintyEnum.Predicted,
        path: 'nonce',
        detail: `${others.length} other pending proposal(s) share nonce ${nonce.proposalNonce}; whichever executes first invalidates the rest`,
        blocking: false,
      },
    ]

  if (nonce.pendingNonces === undefined) return []

  const filled = new Set(nonce.pendingNonces)
  const gaps: number[] = []
  for (let n = nonce.safeNonce; n < nonce.proposalNonce; n++)
    if (!filled.has(n)) gaps.push(n)

  if (gaps.length === 0) return []

  return [
    {
      code: ExecutabilityFindingEnum.NonceGap,
      certainty: RevertCertaintyEnum.Predicted,
      path: 'nonce',
      detail: `this proposal is built at nonce ${
        nonce.proposalNonce
      } and nothing pending fills nonce(s) ${gaps.join(
        ', '
      )}; it cannot execute until they are`,
      blocking: false,
    },
  ]
}

const gradeFunding = (funding: IExecutorFunding): IExecutabilityFinding[] => {
  if (
    funding.balanceWei === undefined ||
    funding.estimatedCostWei === undefined
  )
    return []
  if (funding.balanceWei >= funding.estimatedCostWei) return []

  // Warn-only: both sides of this comparison move on their own, and the remedy
  // is a top-up rather than a new proposal, so refusing a signature over it
  // would block a correct transaction on a condition that fixes itself.
  return [
    {
      code: ExecutabilityFindingEnum.ExecutorUnderfunded,
      certainty: RevertCertaintyEnum.Predicted,
      path: 'executor',
      detail: `${funding.executor} holds ${funding.balanceWei} wei and the broadcast is estimated at ${funding.estimatedCostWei} wei; it needs topping up before execution`,
      blocking: false,
    },
  ]
}

/**
 * Decides whether a proposal would execute, from decoded payloads and chain
 * reads that were already made.
 *
 * Errors — rather than passing — whenever the simulation could not be made: no
 * chain read available, no `eth_call` attempted, an `eth_call` that could not be
 * sent, a call the decoder could not read through, or any single fact a finding
 * would have needed. An unanswerable question is not an answer of yes.
 * @param input - the payloads, the chain reads, and the `eth_call` outcomes
 * @returns Whether to refuse, whether the simulation could decide, and every reason found
 */
export const evaluateExecutability = (
  input: IExecutabilityInput
): IExecutabilityVerdict => {
  const errors: string[] = []
  const findings: IExecutabilityFinding[] = []
  const notSimulated: string[] = []
  const unchecked: string[] = []

  for (const call of input.undecodable ?? [])
    errors.push(
      `${call} could not be read all the way through, so the payloads simulated here are only the readable ones and this proposal may contain others.`
    )

  if (!input.observations.available)
    errors.push(
      `Chain state for ${input.network} could not be read${
        input.observations.unavailableReason
          ? `: ${input.observations.unavailableReason}`
          : ''
      }, so nothing in this proposal was simulated against the state it will execute in.`
    )

  if (!input.staticCalls.attempted)
    errors.push(
      'No payload in this proposal was simulated with eth_call, so a reverting call body would not have been seen. Only the calldata-only and state-comparison checks ran.'
    )

  const byPath = new Map<string, IStaticCallObservation>()
  for (const result of input.staticCalls.results)
    byPath.set(result.path, result)

  /** Selectors this proposal has already moved, per diamond, across payloads. */
  const amendedByDiamond = new Map<string, Map<string, IAmendedSelector>>()

  for (const payload of input.payloads) {
    const here: IExecutabilityFinding[] = []

    if (payload.kind === 'diamond-cut') {
      for (const cut of payload.cuts) here.push(...gradeCutShape(cut))
      here.push(...gradeInit(payload, input.observations, unchecked))
      here.push(...gradeOwner(payload, input.observations, unchecked))
      here.push(...gradeFacetCode(payload, input.observations, unchecked))
      here.push(
        ...gradeSelectors(
          payload,
          input.observations,
          unchecked,
          amendedByDiamond
        )
      )
    } else {
      notSimulated.push(
        `${payload.path} calls ${payload.description} on ${payload.target}, whose revert conditions Tier-0 does not model; it is judged only on its target holding code and on its eth_call outcome.`
      )
      here.push(...gradeOpaque(payload, input.observations, unchecked))
    }

    findings.push(...here)
    const call = byPath.get(payload.path)

    if (call === undefined) {
      if (input.staticCalls.attempted)
        errors.push(
          `${payload.path} has no eth_call result, so it was not simulated even though the other payloads were.`
        )
      continue
    }

    if (call.outcome === 'errored') {
      errors.push(
        `eth_call of ${payload.path} could not be made${
          call.errorReason ? `: ${call.errorReason}` : ''
        }, so whether it reverts is unknown.`
      )
      continue
    }

    if (call.outcome === 'reverted') {
      findings.push({
        code: ExecutabilityFindingEnum.StaticCallReverted,
        certainty: RevertCertaintyEnum.Predicted,
        path: payload.path,
        detail: `eth_call of ${payload.path} from ${call.from} reverted${
          call.revertReason ? ` with ${call.revertReason}` : ' without a reason'
        }`,
        blocking: true,
      })
      continue
    }

    // A proven finding says this payload cannot execute whatever the state is,
    // and the node says it just did. One of the two is wrong about what was
    // simulated — the wrong target, the wrong caller, a payload that is not the
    // one being signed — and neither may be preferred over the other.
    //
    // A proof resting on an earlier payload is excluded: no `eth_call` of this
    // payload can see what a previous call in the proposal did, so a succeeding
    // call there agrees with the finding rather than contradicting it.
    const provenHere = here.filter(
      (finding) =>
        finding.certainty === RevertCertaintyEnum.Proven &&
        finding.composed !== true
    )
    if (provenHere.length > 0)
      errors.push(
        `eth_call of ${payload.path} from ${call.from} succeeded, while ${
          provenHere.length
        } finding(s) prove it cannot execute: ${provenHere
          .map((finding) => finding.code)
          .join(
            ', '
          )}. The simulation and the calldata disagree, so neither is reported as the answer.`
      )
  }

  if (input.nonce) findings.push(...gradeNonce(input.nonce))
  if (input.funding) findings.push(...gradeFunding(input.funding))

  errors.push(...unchecked.map((message) => `${message}.`))

  const blocking = findings.filter((finding) => finding.blocking)
  const refuses = blocking.length > 0
  const error = errors.length > 0

  const proven = blocking.filter(
    (finding) => finding.certainty === RevertCertaintyEnum.Proven
  ).length

  return {
    refuses,
    error,
    findings,
    errors,
    warnings: findings
      .filter((finding) => !finding.blocking)
      .map((finding) => finding.detail),
    notSimulated,
    reason: refuses
      ? `This proposal would not execute on ${input.network}: ${
          blocking.length
        } blocking finding(s), ${proven} of them proven from the calldata alone — ${blocking
          .map((finding) => finding.detail)
          .join('; ')}`
      : error
      ? errors.join(' ')
      : '',
  }
}

/**
 * Collapses a verdict to the three values `evaluateCancelDecision`'s
 * `executability` field accepts.
 *
 * `error` wins over `would-revert` deliberately: the cancel matrix holds on an
 * error and cancels on nothing, while a `would-revert` it believes drives a row
 * towards a destructive block, so a verdict that could not decide must not
 * arrive there wearing a decision.
 * @param verdict - what {@link evaluateExecutability} decided
 * @returns The signal the timelock cancel-decision matrix reads
 */
export const toCancelDecisionExecutability = (
  verdict: IExecutabilityVerdict
): 'ok' | 'would-revert' | 'error' => {
  if (verdict.error) return 'error'
  return verdict.refuses ? 'would-revert' : 'ok'
}

const ESC = String.fromCharCode(27)
const REFUSED = `${ESC}[31m⛔ WOULD REVERT${ESC}[0m`
const CANNOT_SIMULATE = `${ESC}[31m⛔ CANNOT SIMULATE${ESC}[0m`
const WARN = `${ESC}[33m⚠${ESC}[0m`
const INFO = `${ESC}[36mℹ${ESC}[0m`
const OK = `${ESC}[32m✓${ESC}[0m`

/**
 * The lines a signer sees.
 *
 * A verdict with nothing to refuse still prints a line, naming how many
 * payloads had no revert model. Silence would make "this proposal executes" and
 * "this check was never wired" look identical from the terminal.
 * @param verdict - what {@link evaluateExecutability} decided
 * @returns One or more display lines
 */
export const renderExecutability = (
  verdict: IExecutabilityVerdict
): string[] => {
  const lines: string[] = []

  for (const message of verdict.errors)
    lines.push(`${CANNOT_SIMULATE} ${message}`)

  for (const finding of verdict.findings)
    if (finding.blocking)
      lines.push(`${REFUSED} [${finding.certainty}] ${finding.detail}`)

  for (const message of verdict.warnings) lines.push(`${WARN} ${message}`)

  for (const message of verdict.notSimulated) lines.push(`${INFO} ${message}`)

  if (!verdict.refuses && !verdict.error)
    lines.push(
      `${OK} Nothing in this proposal reverts against the state read now; ${verdict.notSimulated.length} payload(s) have no Tier-0 revert model. A clean simulation is not a statement that the proposal is correct.`
    )

  return lines
}

/**
 * Throws unless this proposal would execute.
 *
 * Separate from the evaluation so the refusal sits inside the funnel every
 * signature passes through, rather than depending on a caller reading a
 * boolean. An error blocks exactly as a revert does, with no acknowledgement
 * path: a simulation that could not run is not a simulation that passed.
 * @param verdict - what {@link evaluateExecutability} decided
 * @throws When the proposal would not execute, or the simulation could not decide
 */
export const assertProposalWouldExecute = (
  verdict: IExecutabilityVerdict
): void => {
  if (!verdict.refuses && !verdict.error) return

  throw new Error(
    `Executability simulation: this transaction will not be signed. ${
      verdict.refuses ? verdict.reason : verdict.errors.join(' ')
    } Nothing has been signed.`
  )
}
