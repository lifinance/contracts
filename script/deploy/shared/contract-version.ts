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
 * `MAJOR.MINOR.PATCH`, with an optional dot-separated lowercase suffix.
 *
 * The suffix carries a fork's overlay identity (`2.1.3-tron`): the same
 * contract name at the same upstream version but deliberately different source,
 * which has to be distinguishable or one audit gets credited to two different
 * bodies of code. Lowercase only, so a suffix has exactly one spelling.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?$/

/** What the source said, once the tag has been read but before it is trusted. */
export type ContractVersionRead =
  | { kind: 'ok'; version: string }
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
  if (!VERSION_RE.test(raw)) return { kind: 'malformed', raw }

  return { kind: 'ok', version: raw }
}
