/**
 * The false-refusal budget, and the promotion criterion it feeds.
 *
 * Shadow mode is report-only by construction: nothing here proposes, signs,
 * broadcasts or writes. It grades merged gates against real fleet data and
 * sorts every refusal into exactly one of three classes — true positive, a
 * *named* accepted false red, or unexplained. The last class is the budget.
 *
 * `evaluatePromotion` is the only control this package ships. A gate may flip
 * report-only to blocking when its unexplained-refusal count is 0, every
 * accepted false red it produced carries a remedy that grades grey, and
 * something was actually measured. It is code rather than prose so that a gate
 * cannot be promoted by someone reading a table and deciding it looks fine.
 */

/** Where a refusal lands. `unexplained` is the budget, and its target is 0. */
export type RefusalAdjudication =
  | 'true-positive'
  | 'accepted-false-red'
  | 'unexplained'

/**
 * How a named class of refusal reads to a signer once its remedy is applied.
 *
 * D19 already requires "no attested build" to grade grey. A class whose remedy
 * still leaves the signer looking at a red is not promotable, because a red
 * that is usually wrong is a red signers learn to click through.
 */
export type RemedyGrade = 'grey' | 'red'

/** One named accepted false red, with the remedy that decides its grade. */
export interface IAcceptedFalseRedRule {
  id: string
  /** The ruling or audit finding that enumerates this risk. */
  namedBy: string
  /** What the input actually is, in one line. */
  describes: string
  /** The named remedy path, and what a signer sees once it is applied. */
  remedy: string
  remedyGrade: RemedyGrade
}

/**
 * The enumerated accepted false reds.
 *
 * A refusal matching none of these is `unexplained`, which is the point of
 * keeping the list closed and small: growing it is how a budget of 0 is faked.
 */
export const ACCEPTED_FALSE_RED_RULES: readonly IAcceptedFalseRedRule[] = [
  {
    id: 'AFR-1-retired-pin',
    namedBy: 'D19 — "a pre-profile deployment"',
    describes:
      "the compiler pair that provably reproduces the deployed code is pinned by no profile in today's foundry.toml, so the build predates the current pin set",
    remedy:
      'carry the fleet attestation corpus (script/deploy/resources/reproducibilityAttestations.json) as an additional source of attested builds, so a retired pin is still an attested lineage. Repo-controlled input, not proposer-controlled, so it widens nothing a proposer can reach.',
    // Not yet applied. Until it is, compareToAttestedSet reaches its closed-set
    // branch and returns MISMATCH — a statement that the code is not ours.
    remedyGrade: 'red',
  },
  {
    id: 'AFR-2-cross-profile-network',
    namedBy: 'D19 — "stale config"',
    describes:
      "the reproducing pair IS pinned today, but config/networks.json's targetEvmVersion for this network selects the other pinned profile",
    remedy:
      "same corpus-as-attestation-source remedy as AFR-1. Widening deriveToolchainScope instead — reading foundry.toml at the record's own commit — is refused: D3 asserts commit presence, not ancestry, so it would let a proposer choose the compiler they are graded against.",
    remedyGrade: 'red',
  },
  {
    id: 'AFR-3-unresolvable-network',
    namedBy: 'D19 — "stale config"',
    describes:
      "deriveToolchainScope cannot enumerate the network's legitimate builds at all — the row is absent, its two flags contradict each other, or its targetEvmVersion is blank",
    remedy:
      'fix the config/networks.json row. Until then the gate errors rather than judging, which already reads as "we could not check" and not as "this is not our code".',
    remedyGrade: 'grey',
  },
] as const

/** One gate's verdict about one corpus row, in shadow mode. */
export interface IShadowObservation {
  /** Stable row id, e.g. `mantle/GenericSwapFacet@2.0.0`. */
  slot: string
  refused: boolean
  /** Why it refused, verbatim from the gate. Empty when it did not. */
  reason: string
  /**
   * Which accepted-false-red rule the corpus loader believes applies.
   *
   * Supplied by the caller because only the caller knows the input; validated
   * here against the closed rule list, so an id nobody wrote cannot silently
   * become an accepted class.
   */
  ruleId?: string
  /** Set when the refusal is a real defect the gate was right to catch. */
  truePositive?: boolean
}

/** One refusal, sorted. */
export interface IAdjudication {
  slot: string
  adjudication: RefusalAdjudication
  rule?: IAcceptedFalseRedRule
  reason: string
}

/**
 * Sorts one refusal into exactly one class.
 *
 * An unrecognised `ruleId` is `unexplained` rather than an error: a budget that
 * throws on the interesting case reports nothing, and the whole point is that
 * refusals nobody has a name for are counted.
 *
 * @param observation - one gate's refusal
 * @returns The class, and the rule when one applies
 */
export const adjudicateRefusal = (
  observation: IShadowObservation
): IAdjudication => {
  if (observation.truePositive === true)
    return {
      slot: observation.slot,
      adjudication: 'true-positive',
      reason: observation.reason,
    }

  const rule = ACCEPTED_FALSE_RED_RULES.find(
    (candidate) => candidate.id === observation.ruleId
  )
  if (rule === undefined)
    return {
      slot: observation.slot,
      adjudication: 'unexplained',
      reason: observation.reason,
    }

  return {
    slot: observation.slot,
    adjudication: 'accepted-false-red',
    rule,
    reason: observation.reason,
  }
}

/** One gate's measured budget, always carrying the denominator. */
export interface IGateBudget {
  gate: string
  /** What the corpus is, so a rate is never read without knowing what of. */
  corpus: string
  /** Rows actually graded. Zero is a legitimate answer and never a pass. */
  denominator: number
  /**
   * What the corpus could not cover, and why. Required, because "clean" and
   * "measured on nothing" are the two things this package exists to keep apart.
   */
  coverageNote: string
  refusals: number
  /** Refusals ÷ denominator, or undefined when nothing was measured. */
  falseRefusalRate: number | undefined
  adjudications: IAdjudication[]
  truePositives: number
  acceptedFalseReds: number
  unexplained: number
  /** Count per accepted-false-red rule id, largest first. */
  byRule: [string, number][]
}

/**
 * Totals one gate's observations into a budget.
 *
 * @param input.gate - the gate id
 * @param input.corpus - what was graded
 * @param input.denominator - rows graded; pass it explicitly rather than
 *   counting observations, so a loader that silently dropped rows is visible
 * @param input.coverageNote - what the corpus does not cover
 * @param input.observations - one entry per graded row
 * @returns The budget, with the rate and the three counts
 * @throws When more observations arrive than rows were said to be graded
 */
export const summariseGate = (input: {
  gate: string
  corpus: string
  denominator: number
  coverageNote: string
  observations: readonly IShadowObservation[]
}): IGateBudget => {
  if (input.observations.length > input.denominator)
    throw new Error(
      `${input.gate}: ${input.observations.length} observations against a stated denominator of ${input.denominator}. A rate whose numerator can exceed its denominator is not a measurement.`
    )

  const adjudications = input.observations
    .filter((observation) => observation.refused)
    .map(adjudicateRefusal)

  const byRule = new Map<string, number>()
  for (const entry of adjudications)
    if (entry.rule)
      byRule.set(entry.rule.id, (byRule.get(entry.rule.id) ?? 0) + 1)

  return {
    gate: input.gate,
    corpus: input.corpus,
    denominator: input.denominator,
    coverageNote: input.coverageNote,
    refusals: adjudications.length,
    falseRefusalRate:
      input.denominator === 0
        ? undefined
        : adjudications.length / input.denominator,
    adjudications,
    truePositives: adjudications.filter(
      (a) => a.adjudication === 'true-positive'
    ).length,
    acceptedFalseReds: adjudications.filter(
      (a) => a.adjudication === 'accepted-false-red'
    ).length,
    unexplained: adjudications.filter((a) => a.adjudication === 'unexplained')
      .length,
    byRule: [...byRule.entries()].sort((a, b) => b[1] - a[1]),
  }
}

/** Whether a gate has earned the right to stop being report-only. */
export interface IPromotionVerdict {
  gate: string
  mayEnforce: boolean
  /** Every reason it may not, not just the first. */
  blockers: string[]
}

/**
 * The promotion criterion, as the control this package ships.
 *
 * A gate may flip report-only to blocking when three things hold together:
 * its unexplained-refusal count over the corpus is 0; every accepted false red
 * it produced has a remedy that grades grey rather than red; and something was
 * actually measured.
 *
 * The third clause is not decoration. A gate no corpus reached has an
 * unexplained count of 0 and no accepted false reds, so the first two clauses
 * pass it — which would promote every gate this run could not exercise.
 * "Measured on 0" is the honest reading and it is not a pass.
 *
 * @param budget - one gate's measured budget
 * @returns Whether it may enforce, and every blocker if not
 */
export const evaluatePromotion = (budget: IGateBudget): IPromotionVerdict => {
  const blockers: string[] = []

  if (budget.denominator === 0)
    blockers.push(
      `${budget.gate} was measured on 0 rows (${budget.coverageNote}). An unmeasured gate has an unexplained count of 0 for the same reason a gate that cannot fail does: nothing ran.`
    )

  if (budget.unexplained > 0)
    blockers.push(
      `${budget.gate} produced ${budget.unexplained} unexplained refusal${
        budget.unexplained === 1 ? '' : 's'
      } over ${
        budget.denominator
      } rows. Each one is a finding that needs its own ticket before this gate blocks anything.`
    )

  for (const [ruleId, count] of budget.byRule) {
    const rule = ACCEPTED_FALSE_RED_RULES.find((r) => r.id === ruleId)
    if (rule === undefined || rule.remedyGrade === 'grey') continue
    blockers.push(
      `${budget.gate} produced ${count} refusal${
        count === 1 ? '' : 's'
      } in the accepted class ${ruleId} (${
        rule.namedBy
      }), whose remedy path grades red, not grey. Apply the remedy first: ${
        rule.remedy
      }`
    )
  }

  return { gate: budget.gate, mayEnforce: blockers.length === 0, blockers }
}

/**
 * Renders the budget table a reviewer reads, denominators included.
 *
 * @param budgets - one entry per gate, in report order
 * @returns Lines to print
 */
export const renderBudgetReport = (
  budgets: readonly IGateBudget[]
): string[] => {
  const lines: string[] = [
    '| Gate | Corpus | Refusals / denominator | Rate | True positive | Accepted false red | Unexplained | May enforce |',
    '|---|---|---|---|---|---|---|---|',
  ]

  for (const budget of budgets) {
    const verdict = evaluatePromotion(budget)
    // A denominator of 0 renders as the words rather than as a dash, because a
    // dash in a rate column reads as "nothing to report".
    const rate =
      budget.falseRefusalRate === undefined
        ? `measured on 0`
        : `${(budget.falseRefusalRate * 100).toFixed(1)}%`
    lines.push(
      `| \`${budget.gate}\` | ${budget.corpus} | ${budget.refusals} / ${
        budget.denominator
      } | ${rate} | ${budget.truePositives} | ${budget.acceptedFalseReds} | ${
        budget.unexplained
      } | ${verdict.mayEnforce ? 'yes' : 'no'} |`
    )
  }

  return lines
}
