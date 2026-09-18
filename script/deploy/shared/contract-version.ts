/**
 * The one grammar for the `@custom:version` tag every contract carries.
 *
 * Import this wherever a version is read out of Solidity source. The tag is a
 * comment, so each consumer used to parse it with its own regex — and a version
 * that one reader truncates while another reads it whole means audit coverage
 * gets looked up for a different version than the content gate compares
 * (EXSC-1033). The bash half of the same grammar is
 * `script/utils/extract-contract-version.sh`; both are driven from one table of
 * cases in `contract-version.test.ts`.
 */

/**
 * A version tag line, capturing everything after the tag so a malformed value
 * can be reported rather than silently truncated to its well-formed prefix.
 */
const TAG_LINE_RE = /^\/\/\/[ \t]+@custom:version[ \t]+(.*)$/m

/**
 * `MAJOR.MINOR.PATCH`, with an optional lowercase suffix whose segments are
 * separated by `.` or `-`.
 *
 * The suffix carries a fork's overlay identity (`2.1.3-tron`): the same
 * contract name at the same upstream version but deliberately different source,
 * which has to be distinguishable or one audit gets credited to two different
 * bodies of code. Multi-segment because a redeploy of that overlay takes
 * `-tron-r2`, `-tron-r3` (`docs/TronFork.md`). Lowercase only, so a suffix has
 * exactly one spelling.
 */
const VERSION_RE = /^(\d+\.\d+\.\d+)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/

/** What the source said, once the tag has been read but before it is trusted. */
export type ContractVersionRead =
  | {
      kind: 'ok'
      version: string
      /**
       * The `MAJOR.MINOR.PATCH` the version is built on, suffix dropped.
       *
       * Ordering is defined on these three numbers only — a suffix marks a
       * variant of that release, not a point before or after it, and semver
       * would sort `2.1.3-tron` *below* `2.1.3`, which is not what the suffix
       * means here. Callers that compare versions compare this.
       */
      base: string
    }
  | { kind: 'missing' }
  | { kind: 'malformed'; raw: string }

/**
 * Reads the first `@custom:version` tag in a Solidity source file.
 *
 * First tag wins: a file holding two interfaces carries two tags, and the
 * leading one describes the file the way the audit log keys it.
 *
 * @param source - Solidity source text.
 * @returns the version, that there is no tag, or the value that is not one.
 */
export const readContractVersion = (source: string): ContractVersionRead => {
  const tagged = TAG_LINE_RE.exec(source)
  if (!tagged?.[1]) return { kind: 'missing' }

  const raw = tagged[1].replace(/\s+$/, '')
  if (!raw) return { kind: 'missing' }

  const matched = VERSION_RE.exec(raw)
  if (!matched?.[1]) return { kind: 'malformed', raw }

  return { kind: 'ok', version: raw, base: matched[1] }
}
