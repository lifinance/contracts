/**
 * Decides what the unattended timelock runner does with one queued operation:
 * execute it, cancel it on-chain, hold it for the next pass, or block it for an
 * operator. Import it from the pre-execute path in
 * `execute-pending-timelock-tx.ts`; it is pure, so nothing here reads chain,
 * config or the queue.
 *
 * Cancelling is destructive — a cancelled operation has to be re-proposed and
 * re-signed by a threshold of humans — so the only input that reaches it is a
 * divergence that has been *proven*: derived from an authoritative anchor rather
 * than a stored value, and agreed by at least a quorum of independent providers.
 * Everything a caller can get wrong or be lied to about is enumerated on
 * {@link ICancelDecisionInput} and each case has a named non-cancelling verdict.
 */

/** What the runner should do with the operation. */
export type TTimelockOpAction = 'execute' | 'cancel' | 'hold' | 'block'

/**
 * Machine-readable cause of a decision. Stable: it is written to the queue row
 * and matched by alerting, so treat a rename as a breaking change.
 */
export type TCancelDecisionReason =
  | 'integrity-and-identity-verified'
  | 'op-not-schedulable'
  | 'op-not-yet-matured'
  | 'proven-integrity-divergence'
  | 'proven-identity-divergence'
  | 'divergence-not-proven'
  | 'canceller-authority-missing'
  | 'verification-error'
  | 'op-form-unsupported'
  | 'deployment-record-missing'
  | 'would-revert'
  | 'unclassified-signals'
  | 'cancel-circuit-breaker'

/** How loudly the decision has to reach a human. */
export type TCancelAlertLevel = 'none' | 'notice' | 'page'

/**
 * Outcome of one proving leg of the pre-execute re-derivation.
 *
 * `unsupported` is not a spelling of `error`: it means the re-derivation has no
 * implementation for this operation's shape (the singular
 * `schedule(address,uint256,bytes,bytes32,bytes32,uint256)` where only
 * `scheduleBatch` is handled, say), so silence from it is absence of a check
 * rather than a failed check.
 */
export type TProvingLegOutcome = 'match' | 'mismatch' | 'error' | 'unsupported'

/** Whether the timelock's `EXECUTOR_ROLE` still lets anyone execute. */
export type TExecutorPosture = 'open' | 'restricted' | 'unknown'

/**
 * Where a divergence verdict came from.
 *
 * Only `anchors` can justify a cancel. A verdict recomputed from a stored
 * codehash is a verdict about a writable store, and an attacker who can write
 * that store and then deploy matching code passes it — so a `stored` mismatch is
 * an anomaly to page about, never a proof to destroy an operation over.
 */
export type TVerdictProvenance = 'anchors' | 'stored' | 'unknown'

/**
 * How many independent providers must agree before a divergence counts as
 * proven. Two, because a single injected or lying endpoint is then unable to
 * force a cancel on its own.
 */
export const MIN_AGREEING_PROVIDERS_FOR_CANCEL = 2

/**
 * How many cancels one runner pass may issue before the circuit-breaker trips.
 *
 * Two: an attacker who got divergent code past sign-time on three networks at
 * once and a bug in our own checker produce the same picture, and the second is
 * the likelier of the two, so the third cancel is where a human should look
 * instead. Applies per pass, so the next pass re-decides from scratch.
 */
export const MAX_CANCELS_PER_PASS = 2

/**
 * The pre-execute signals for one queued operation.
 *
 * Each field is something the runner observed, and several of them can be wrong
 * in a way that would be dangerous to act on:
 *
 * - a divergence recomputed from a stored value rather than an anchor
 *   (`verdictProvenance`) is not proof — it proves something about a writable
 *   store;
 * - a divergence only one provider can see (`agreeingProviders`) is not proof;
 * - a transient RPC failure relabelled as a divergence would turn a regional
 *   outage into a fleet-wide cancel storm, so `error` on any leg holds;
 * - a leg the re-derivation cannot evaluate at all reports `unsupported`, which
 *   must not read as `match`;
 * - a *missing deployment record* and a *missing sign-time verdict record* are
 *   different records with opposite consequences, so they are separate fields;
 * - `cancellerAuthority` is what the runner actually holds on this timelock, not
 *   what the deployment scripts intended to grant it.
 */
export interface ICancelDecisionInput {
  /** Live code at every signed address vs the re-derived attested build. */
  integrity: TProvingLegOutcome
  /** Recomputed operation id vs the id scheduled on-chain. */
  opIdentity: TProvingLegOutcome
  /** Whether the divergence verdict was derived from anchors or from a stored value. */
  verdictProvenance: TVerdictProvenance
  /** Independent providers that agreed on the integrity and identity reads. */
  agreeingProviders: number
  /** Executability simulation of the pending `executeBatch`. */
  executability: 'ok' | 'would-revert' | 'error'
  /** Deployment record for every address in the operation's calldata. */
  deploymentRecord: 'present' | 'missing' | 'error'
  /** The sign-time verdict record (the reconstruction trail), if the runner found one. */
  signTimeVerdictRecord: 'present' | 'missing'
  /** On-chain state of the operation, as the controller reports it. */
  operationState: 'ready' | 'pending' | 'done' | 'unset'
  /** Whether the runner's key holds `CANCELLER_ROLE` on this timelock. */
  cancellerAuthority: 'held' | 'absent' | 'unknown'
  /** Reverted `executeBatch` attempts since the last requeue. */
  revertAttempts: number
  /** Attempts a reverting row absorbs before it stops being retried. */
  revertBlockThreshold: number
}

/** A decision about one operation. */
export interface ICancelDecision {
  action: TTimelockOpAction
  reason: TCancelDecisionReason
  /** One operator-facing sentence explaining the action. */
  detail: string
  alert: TCancelAlertLevel
  /** Whether the next pass should pick the operation up again unattended. */
  retry: boolean
  /** Process anomalies that do not change the action, e.g. an absent verdict record. */
  notes: string[]
}

/** One operation's decision, tagged so a pass-level verdict can be read per row. */
export interface IIdentifiedCancelDecision {
  /** Operation id, for the operator; never interpreted here. */
  operationId: string
  /** Network key, for the operator; never interpreted here. */
  network: string
  decision: ICancelDecision
}

/** What a whole runner pass should do, after the circuit-breaker has been applied. */
export interface ICancelPassVerdict {
  decisions: IIdentifiedCancelDecision[]
  /** True when the pass wanted more cancels than {@link MAX_CANCELS_PER_PASS}. */
  circuitBreakerTripped: boolean
  /** Cancels the pass will actually issue. */
  cancels: number
  /** Cancels the breaker converted into blocks. Always 0 unless it tripped. */
  cancelsWithheld: number
  alert: TCancelAlertLevel
  /** One operator-facing sentence about the pass as a whole. */
  detail: string
}

const isProven = (input: ICancelDecisionInput): boolean =>
  input.verdictProvenance === 'anchors' &&
  input.agreeingProviders >= MIN_AGREEING_PROVIDERS_FOR_CANCEL

const describeUnprovenDivergence = (input: ICancelDecisionInput): string => {
  if (input.verdictProvenance !== 'anchors')
    return `divergence reported from a ${input.verdictProvenance} verdict, which is not an authoritative anchor`

  return `divergence seen by ${input.agreeingProviders} provider(s), below the quorum of ${MIN_AGREEING_PROVIDERS_FOR_CANCEL}`
}

/**
 * Decide what to do with one queued timelock operation.
 *
 * Checks are ordered, and the order is the safety property: the state guard runs
 * first so a cancel is never aimed at an operation the controller would reject
 * it for; proven divergence runs before the error paths, because a proof on one
 * leg stands even when another leg failed to read; every error, unsupported leg
 * and unproven divergence lands on a non-destructive verdict; and the final
 * branch requires all four legs to be affirmative, so an unforeseen combination
 * blocks instead of executing.
 *
 * @param input - the pre-execute signals for this operation
 * @returns the action, its stable reason, and whether the next pass may retry
 */
export function evaluateCancelDecision(
  input: ICancelDecisionInput
): ICancelDecision {
  const notes: string[] = []
  if (input.signTimeVerdictRecord === 'missing')
    notes.push(
      'no sign-time verdict record for this operation — a process anomaly, not a safety hole, because the verdict is re-derived here and no stored value is read'
    )

  const decide = (
    decision: Omit<ICancelDecision, 'notes'>
  ): ICancelDecision => ({
    ...decision,
    // A note never changes the action, but it must not be silent either.
    alert:
      notes.length > 0 && decision.alert === 'none' ? 'notice' : decision.alert,
    notes,
  })

  // A state this does not recognise — a controller returning something new, an
  // absent field, a prototype property — must not reach any action. `pending`
  // passes deliberately: an operation still inside its delay is exactly one
  // worth cancelling, it just cannot be executed, which the execute branch
  // enforces separately.
  if (input.operationState !== 'ready' && input.operationState !== 'pending')
    return decide({
      action: 'block',
      reason: 'op-not-schedulable',
      detail: `operation is ${String(
        input.operationState
      )} on-chain: neither execute nor cancel applies`,
      alert: 'notice',
      retry: false,
    })

  const divergentLeg =
    input.integrity === 'mismatch'
      ? 'integrity'
      : input.opIdentity === 'mismatch'
      ? 'identity'
      : undefined

  if (divergentLeg) {
    if (!isProven(input))
      return decide({
        action: 'block',
        reason: 'divergence-not-proven',
        detail: `${describeUnprovenDivergence(
          input
        )}; holding the operation instead of cancelling it`,
        alert: 'page',
        retry: false,
      })

    if (input.cancellerAuthority !== 'held')
      return decide({
        action: 'block',
        reason: 'canceller-authority-missing',
        detail: `proven divergence but the runner's canceller role is ${input.cancellerAuthority}: the operation must be cancelled through the Safe`,
        alert: 'page',
        retry: false,
      })

    return decide({
      action: 'cancel',
      reason:
        divergentLeg === 'integrity'
          ? 'proven-integrity-divergence'
          : 'proven-identity-divergence',
      detail:
        divergentLeg === 'integrity'
          ? `live code at a signed address differs from the re-derived attested build, agreed by ${input.agreeingProviders} providers`
          : `recomputed operation id differs from the id scheduled on-chain, agreed by ${input.agreeingProviders} providers`,
      alert: 'page',
      retry: false,
    })
  }

  if (input.integrity === 'unsupported' || input.opIdentity === 'unsupported')
    return decide({
      action: 'hold',
      reason: 'op-form-unsupported',
      detail:
        'the pre-execute re-derivation has no implementation for this operation shape, so it was never verified',
      alert: 'page',
      retry: true,
    })

  if (
    input.integrity === 'error' ||
    input.opIdentity === 'error' ||
    input.deploymentRecord === 'error' ||
    input.executability === 'error'
  )
    return decide({
      action: 'hold',
      reason: 'verification-error',
      detail:
        'a pre-execute check could not complete, which is not evidence of divergence: holding for the next pass',
      alert: 'notice',
      retry: true,
    })

  if (input.deploymentRecord === 'missing')
    return decide({
      action: 'block',
      reason: 'deployment-record-missing',
      detail:
        'an address in the operation has no deployment record: nothing is wired into a diamond the deployment log does not know about',
      alert: 'page',
      retry: false,
    })

  if (input.executability === 'would-revert') {
    const exhausted = input.revertAttempts >= input.revertBlockThreshold

    return decide({
      action: exhausted ? 'block' : 'hold',
      reason: 'would-revert',
      detail: exhausted
        ? `the operation would revert after ${input.revertAttempts} attempt(s): it stays live but is no longer retried unattended`
        : `the operation would revert (attempt ${input.revertAttempts} of ${input.revertBlockThreshold}): not broadcast, and not cancelled — a reverting operation cannot change state`,
      alert: exhausted ? 'page' : 'notice',
      retry: !exhausted,
    })
  }

  if (
    input.integrity === 'match' &&
    input.opIdentity === 'match' &&
    input.deploymentRecord === 'present' &&
    input.executability === 'ok' &&
    // `execute` is the only irreversible action this function authorises, so
    // every condition it needs is named at the point of authorisation.
    input.operationState === 'ready'
  )
    return decide({
      action: 'execute',
      reason: 'integrity-and-identity-verified',
      detail:
        'live code and operation id both match the re-derived build, and the operation simulates cleanly',
      alert: 'none',
      retry: false,
    })

  // Everything checks out and the delay has not elapsed. That is a wait, not an
  // unrecognised combination: `--rejectAll` routes pending operations through
  // here, so reporting them as unclassified would page a human for an ordinary
  // queue state and drop them from the retry that resolves it.
  if (input.operationState === 'pending')
    return decide({
      action: 'hold',
      reason: 'op-not-yet-matured',
      detail:
        'every pre-execute check passed and the timelock delay has not elapsed, so the operation is neither executed nor cancelled yet',
      alert: 'notice',
      retry: true,
    })

  return decide({
    action: 'block',
    reason: 'unclassified-signals',
    detail:
      'the pre-execute signals do not form a case this matrix recognises, so the operation is not executed',
    alert: 'page',
    retry: false,
  })
}

/**
 * Apply the pass-level circuit-breaker to per-operation decisions.
 *
 * Above {@link MAX_CANCELS_PER_PASS} the cause is more likely one bug in the
 * checker than that many independent divergences, so the cancels are withheld
 * and a human is paged. That is only safe where declining to execute is itself a
 * control: while `EXECUTOR_ROLE` is still granted to `address(0)`, anyone can
 * execute a matured operation, so withholding a cancel would leave a
 * provably-divergent operation executable by a stranger. With an `open` or
 * `unknown` posture the breaker therefore pages without withholding.
 *
 * @param decisions - per-operation decisions from {@link evaluateCancelDecision}
 * @param executorPosture - whether the timelock's executor role is restricted
 * @param maxCancelsPerPass - breaker threshold, for tests
 * @returns the decisions the pass should act on, plus what the breaker did
 */
export function evaluateCancelPass(
  decisions: readonly IIdentifiedCancelDecision[],
  executorPosture: TExecutorPosture,
  maxCancelsPerPass: number = MAX_CANCELS_PER_PASS
): ICancelPassVerdict {
  const requested = decisions.filter(
    (entry) => entry.decision.action === 'cancel'
  ).length
  const tripped = requested > maxCancelsPerPass
  const withhold = tripped && executorPosture === 'restricted'

  const applied = decisions.map((entry) => {
    if (!withhold || entry.decision.action !== 'cancel') return entry

    return {
      ...entry,
      decision: {
        ...entry.decision,
        action: 'block' as TTimelockOpAction,
        reason: 'cancel-circuit-breaker' as TCancelDecisionReason,
        detail: `${requested} cancels in one pass exceeds ${maxCancelsPerPass}: cancels withheld pending a human, because a mass divergence is likelier one checker bug than that many attacks`,
        alert: 'page' as TCancelAlertLevel,
        retry: false,
      },
    }
  })

  const cancels = applied.filter(
    (entry) => entry.decision.action === 'cancel'
  ).length

  const detail = !tripped
    ? `${cancels} cancel(s) in this pass, within the limit of ${maxCancelsPerPass}`
    : withhold
    ? `${requested} cancels exceeded the limit of ${maxCancelsPerPass}: all withheld, operations blocked, human paged`
    : `${requested} cancels exceeded the limit of ${maxCancelsPerPass} but the executor role is ${executorPosture}, so declining to execute is not a control: cancels proceed and a human is paged`

  return {
    decisions: applied,
    circuitBreakerTripped: tripped,
    cancels,
    cancelsWithheld: requested - cancels,
    alert: tripped ? 'page' : maxAlert(applied),
    detail,
  }
}

const ALERT_ORDER: TCancelAlertLevel[] = ['none', 'notice', 'page']

const maxAlert = (
  decisions: readonly IIdentifiedCancelDecision[]
): TCancelAlertLevel =>
  decisions.reduce<TCancelAlertLevel>(
    (worst, entry) =>
      ALERT_ORDER.indexOf(entry.decision.alert) > ALERT_ORDER.indexOf(worst)
        ? entry.decision.alert
        : worst,
    'none'
  )

/**
 * Render one decision for an operator.
 *
 * @param decision - the decision to render
 * @returns a multi-line block: action, reason, detail, alert level, and any notes
 */
export function renderCancelDecision(decision: ICancelDecision): string {
  const lines = [
    `action : ${decision.action.toUpperCase()}`,
    `reason : ${decision.reason}`,
    `detail : ${decision.detail}`,
    `alert  : ${decision.alert}${decision.retry ? ' (retried next pass)' : ''}`,
  ]
  for (const note of decision.notes) lines.push(`note   : ${note}`)

  return lines.join('\n')
}

/**
 * Render a whole pass for an operator.
 *
 * @param verdict - the pass verdict
 * @returns a multi-line block: the pass summary, then one line per operation
 */
export function renderCancelPass(verdict: ICancelPassVerdict): string {
  const header = [
    `pass   : ${verdict.detail}`,
    `alert  : ${verdict.alert}`,
    `breaker: ${
      verdict.circuitBreakerTripped
        ? `TRIPPED (${verdict.cancelsWithheld} cancel(s) withheld)`
        : 'not tripped'
    }`,
  ]
  const rows = verdict.decisions.map(
    (entry) =>
      `  ${entry.network} ${
        entry.operationId
      } → ${entry.decision.action.toUpperCase()} (${entry.decision.reason})`
  )

  return [...header, ...rows].join('\n')
}

/**
 * Guard the broadcast path: let only an `execute` decision through.
 *
 * @param decision - the decision for the operation about to be broadcast
 * @param context - operator-facing label for the operation, e.g. `mainnet 0xabc…`
 * @throws If the decision is anything other than `execute`
 */
export function assertDecisionPermitsExecution(
  decision: ICancelDecision,
  context: string
): void {
  if (decision.action === 'execute') return

  throw new Error(
    `Refusing to execute ${context}: ${decision.reason} — ${decision.detail}`
  )
}

/**
 * Read the executor posture from a timelock's `EXECUTOR_ROLE` holders.
 *
 * Every doubt resolves away from `restricted`, because that is the only posture
 * under which the circuit breaker may withhold a cancel.
 *
 * @param holders - addresses the timelock reports as holding `EXECUTOR_ROLE`
 * @returns `open` when a holder denotes no address, `restricted` only when every
 *   holder is a well-formed non-zero address, `unknown` otherwise — including a
 *   holder that is not readable as either
 */
export function evaluateExecutorPosture(
  holders: readonly string[]
): TExecutorPosture {
  const normalized = holders.map((holder) =>
    typeof holder === 'string' ? holder.trim().toLowerCase() : ''
  )
  if (normalized.length === 0) return 'unknown'

  // Any spelling of "nobody in particular" is the open posture: an unprefixed or
  // short zero, and a zero padded to a bytes32 word, all denote no address.
  const denotesNoAddress = (holder: string): boolean =>
    /^(?:0x)?0+$/u.test(holder)
  if (normalized.some(denotesNoAddress)) return 'open'

  const isNamedAddress = (holder: string): boolean =>
    /^0x[0-9a-f]{40}$/u.test(holder)
  if (!normalized.every(isNamedAddress)) return 'unknown'

  return 'restricted'
}

/**
 * Read the executor posture a `LiFiTimelockController` deployment script grants.
 *
 * The on-chain `EXECUTOR_ROLE` holders are authoritative — a role can be changed
 * after deployment — so this reports what a freshly deployed timelock would get,
 * which is what the fleet still has until the role-change ceremony lands.
 *
 * @param source - Solidity source of a `DeployLiFiTimelockController` script
 * @returns `open` when the script grants the role to the zero address,
 *   `restricted` when it grants named addresses, `unknown` when no executor
 *   assignment is present
 */
export function parseDeployScriptExecutorPosture(
  source: string
): TExecutorPosture {
  const assignments = [
    ...source.matchAll(/executors\[\s*\d+\s*\]\s*=\s*([^;]+);/g),
  ].map((match) => match[1]?.trim() ?? '')
  if (assignments.length === 0) return 'unknown'
  if (assignments.some((value) => /^address\(\s*0\s*\)$/.test(value)))
    return 'open'

  return 'restricted'
}
