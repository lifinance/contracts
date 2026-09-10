/**
 * Reduces Solidity source to the lines the audit gate treats as relevant.
 *
 * Import this before hashing source for comparison against an audit entry. The
 * same rule drives the version-bump filter in `versionControlAndAuditCheck.yml`:
 * a line is ignored only when it is wholly comment, wholly pragma, or blank.
 * Trailing code after a terminated pragma or a closed block comment is
 * audit-relevant — otherwise a pragma line with extra statements matches a
 * clean pragma (F24).
 */

/**
 * True when a source line is ignored by both the version-bump check and the
 * content hash.
 *
 * @param line - One Solidity source line, without a trailing newline.
 * @returns True when the line is blank, a line comment, a wholly-closed
 *   block comment, an unclosed block-comment opener, or a wholly-terminated
 *   pragma.
 */
export const isAuditNonRelevantLine = (line: string): boolean => {
  const trimmed = line.trim()
  if (trimmed === '') return true
  if (trimmed.startsWith('//')) return true
  if (trimmed.startsWith('/*')) {
    const close = trimmed.indexOf('*/')
    if (close === -1) return true
    return trimmed.slice(close + 2).trim() === ''
  }
  if (/^pragma\b/u.test(trimmed)) {
    const semi = trimmed.indexOf(';')
    if (semi === -1) return false
    return trimmed.slice(semi + 1).trim() === ''
  }
  return false
}

/**
 * Drops the lines the version-bump check would ignore.
 *
 * @param source - Solidity source, as read from disk or git.
 * @returns The remaining lines, newline-joined, with no trailing newline.
 */
export const normaliseAuditRelevantSource = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !isAuditNonRelevantLine(line))
    .join('\n')
