/**
 * Splits "this contract changed" from "something it imports changed".
 *
 * Import this to classify a content-equality result. The two facts carry
 * different authority: a contract whose own source differs from its audit is not
 * the audited contract, while one that is byte-identical but whose import
 * closure moved may still behave differently — worth reporting, not worth
 * blocking a merge on.
 */

/** What the comparison against the audit commit found. */
export interface IClosureComparison {
  /** Whether the contract's own file is audit-relevant-identical. */
  ownSourceMatches: boolean
  /** Whether every file in the closure is. */
  closureMatches: boolean
  /** Closure files whose audit-relevant content differs, own file excluded. */
  driftingDependencies: string[]
}

/**
 * `closure-drift` is reported on its own status check rather than as a warning
 * inside a green one, so it cannot be mistaken for nothing having happened.
 */
export type ContentVerdict = 'pass' | 'fail' | 'closure-drift'

export interface IContentClassification {
  verdict: ContentVerdict
  reason: string
  /** True only for `fail`. `closure-drift` reports and lets the merge proceed. */
  blocksMerge: boolean
}

/**
 * Classifies a content comparison.
 *
 * @param subject - Contract name for the message, e.g. `ERC20Proxy@1.2.0`.
 * @param comparison - The result of comparing head against the audit commit.
 * @returns The verdict, whether it blocks, and a line for the CI log.
 */
export const classifyContentVerdict = (
  subject: string,
  comparison: IClosureComparison
): IContentClassification => {
  const { ownSourceMatches, closureMatches, driftingDependencies } = comparison

  if (!ownSourceMatches)
    return {
      verdict: 'fail',
      reason: `${subject}: the contract's own source differs from the audited source, so this is not the audited contract`,
      blocksMerge: true,
    }

  if (closureMatches)
    return {
      verdict: 'pass',
      reason: `${subject}: audit-relevant source matches the audit, across the whole import closure`,
      blocksMerge: false,
    }

  // Reached by 48 of 59 audited contracts on main, because they share libraries:
  // one library gaining an error moves the closure of every contract importing
  // it, while none of their own sources changed.
  const named = driftingDependencies.slice(0, 5).join(', ')
  const rest =
    driftingDependencies.length > 5
      ? ` and ${driftingDependencies.length - 5} more`
      : ''
  return {
    verdict: 'closure-drift',
    reason: `${subject}: own source is audit-relevant-identical, but ${driftingDependencies.length} file(s) in its import closure changed since the audit (${named}${rest}). A library can change what a facet does, so this is reported rather than ignored — and it does not block, because the contract itself is what was audited`,
    blocksMerge: false,
  }
}
