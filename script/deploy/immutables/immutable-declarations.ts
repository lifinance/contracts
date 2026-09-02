/**
 * Finds the immutables a Solidity file declares.
 *
 * Import this to enumerate what the per-immutable registry has to account for,
 * together with {@link findUnreadableImmutableLines} — which is not optional. It
 * reads source rather than build output so the CI gate needs no compile, and it
 * is deliberately narrow, recognising the forms this repo uses.
 *
 * That narrowness is the danger. A declaration it cannot read produces NOTHING,
 * so the immutable is never asked for and never shows as unanswered — the worst
 * failure available to a registry gate. `address payable public immutable` was
 * one such shape, and a declaration wrapped across lines is another. So the gate
 * must also ask what this parser failed to read.
 */

/** One `<type> [visibility] immutable <name>;` in a contract. */
export interface IImmutableDeclaration {
  /** Repo-relative path, as given by the caller. */
  file: string
  /** 1-indexed line the declaration sits on. */
  line: number
  /** The declared type, e.g. `address`, `uint256`, `IGasZip`. */
  type: string
  /** As written; undefined when the declaration omits it. */
  visibility?: 'public' | 'private' | 'internal'
  name: string
}

/**
 * `<type> [visibility] immutable <name>` with `immutable` as a whole word, so
 * `immutableOwner` and prose mentioning the word do not match. Anchored at the
 * start of the line's content, which keeps it out of strings and trailing
 * comments — a declaration is always the first thing on its line in this repo.
 *
 * The optional `payable` is not decoration: `address payable public immutable
 * POLYMER_FEE_RECEIVER` is a real declaration in `src/`, and a single-token type
 * pattern reads straight past it — an immutable the registry would never be
 * asked to account for.
 */
const DECLARATION_RE =
  /^\s*([A-Za-z_$][\w$.]*(?:\[\d*\])*(?:\s+payable)?)\s+(?:(public|private|internal)\s+)?immutable\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/u

const isCommentLine = (line: string): boolean =>
  /^\s*(\/\/|\/\*|\*)/u.test(line)

/**
 * Parses one file's immutable declarations.
 *
 * @param source - The file's contents.
 * @param file - Repo-relative path, carried onto each result.
 * @returns One entry per declaration, in source order.
 */
export const parseImmutableDeclarations = (
  source: string,
  file: string
): IImmutableDeclaration[] => {
  const found: IImmutableDeclaration[] = []

  source.split('\n').forEach((text, index) => {
    if (isCommentLine(text)) return
    const match = DECLARATION_RE.exec(text)
    if (!match) return

    const [, type, visibility, name] = match
    if (!type || !name) return

    found.push({
      file,
      line: index + 1,
      type,
      ...(visibility
        ? { visibility: visibility as IImmutableDeclaration['visibility'] }
        : {}),
      name,
    })
  })

  return found
}

/**
 * Lines that mention `immutable` but that {@link parseImmutableDeclarations}
 * could not read as a declaration.
 *
 * The gate treats these as errors rather than ignoring them: whatever the shape
 * is, an immutable the enumerator cannot see is one the registry will never be
 * asked to account for. Fixing it means either teaching the parser the shape or
 * rewriting the declaration onto one line.
 *
 * @param source - The file's contents.
 * @param file - Repo-relative path, carried onto each result.
 * @returns One entry per unreadable line, in source order.
 */
export const findUnreadableImmutableLines = (
  source: string,
  file: string
): { file: string; line: number; text: string }[] => {
  const read = new Set(
    parseImmutableDeclarations(source, file).map((d) => d.line)
  )

  return source
    .split('\n')
    .map((text, index) => ({ file, line: index + 1, text: text.trim() }))
    .filter(
      ({ text, line }) =>
        /\bimmutable\b/u.test(text) &&
        !isCommentLine(text) &&
        !read.has(line) &&
        // A doc line inside a block comment starts with `*`, which
        // `isCommentLine` covers, but a natspec tag can also sit mid-line.
        !/@(notice|dev|param|return|custom)/u.test(text)
    )
}
