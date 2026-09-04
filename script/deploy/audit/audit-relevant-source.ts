/**
 * Reduces Solidity source to the lines the audit gate treats as relevant.
 *
 * Import this before hashing source for comparison against an audit entry. The
 * authority for what counts is `versionControlAndAuditCheck.yml`, which already
 * declares comments, pragma and blank lines non-audit-relevant when it decides
 * whether a change needs a version bump; this mirrors that declaration so the
 * two gates cannot disagree about the same word.
 */

/**
 * The workflow's filter, line by line:
 *
 * ```bash
 * grep -vE "^[\+\-][[:space:]]*(//|/\*|pragma)"   # comments, block openers, pragma
 * grep -vE '^([\+\-])[[:space:]]*$'               # blank
 * ```
 *
 * It is a line filter, not a comment parser, and mirroring it faithfully means
 * inheriting two gaps: a trailing comment on a code line stays, and the body
 * lines of a block comment stay, because neither begins with `//` or `/*`.
 * Deliberate — a second, stricter definition here would mean the version-bump
 * check and the content check disagree about what an audit covers, and the
 * workflow is the one signers' expectations are already built on.
 */
const NON_RELEVANT_LINE_RE = /^\s*(\/\/|\/\*|pragma\b)/u

const isBlank = (line: string): boolean => line.trim() === ''

/**
 * Drops the lines the version-bump check would ignore.
 *
 * @param source - Solidity source, as read from disk or git.
 * @returns The remaining lines, newline-joined, with no trailing newline.
 */
export const normaliseAuditRelevantSource = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !isBlank(line) && !NON_RELEVANT_LINE_RE.test(line))
    .join('\n')
