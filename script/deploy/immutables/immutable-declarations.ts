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
 * Replaces every comment and string literal with spaces, keeping all other
 * characters and every newline where they are, so line numbers still line up.
 *
 * Everything downstream reads the masked text, because the two cheap ways of
 * approximating this both hid a real immutable. Pairing quotes with a regex let
 * an escaped quote inside a string swallow the declaration that followed it, and
 * skipping any line whose first characters open a comment hid a declaration that
 * merely had a block comment in front of it. Both compile, and both were
 * invisible to the gate rather than reported by it.
 *
 * @param source - The file's contents.
 * @returns The same length of text with comments and string bodies blanked.
 */
const maskCommentsAndStrings = (source: string): string => {
  const out = source.split('')
  let state: 'code' | 'lineComment' | 'blockComment' | 'string' = 'code'
  let quote = ''

  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string
    const next = source[i + 1]

    if (state === 'code') {
      // Both delimiter characters are consumed here so that `/*/` opens a
      // comment without also closing it.
      if (char === '/' && next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'lineComment'
      } else if (char === '/' && next === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'blockComment'
      } else if (char === '"' || char === "'") {
        out[i] = ' '
        quote = char
        state = 'string'
      }
      continue
    }

    if (state === 'lineComment') {
      if (char === '\n') state = 'code'
      else out[i] = ' '
      continue
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'code'
      } else if (char !== '\n') out[i] = ' '
      continue
    }

    if (char === '\\') {
      out[i] = ' '
      if (next !== undefined && next !== '\n') {
        out[i + 1] = ' '
        i++
      }
      continue
    }
    if (char === quote) {
      out[i] = ' '
      state = 'code'
      continue
    }
    if (char !== '\n') out[i] = ' '
  }

  return out.join('')
}

/**
 * `<type> [visibility] immutable <name>` with `immutable` as a whole word, so
 * `immutableOwner` and prose mentioning the word do not match. Anchored at the
 * start of a statement; the caller splits a line into statements first.
 *
 * The optional `payable` is not decoration: `address payable public immutable
 * POLYMER_FEE_RECEIVER` is a real declaration in `src/`, and a single-token type
 * pattern reads straight past it — an immutable the registry would never be
 * asked to account for.
 *
 * The name must not be a modifier keyword. Solidity accepts `immutable` before
 * the visibility, and accepts `override` on a public state variable, so on a
 * declaration that wraps after such a keyword the pattern would otherwise
 * capture the keyword as the name. That is worse than failing to parse: the
 * phantom declaration makes the parsed count match the mention count, so the
 * reporter falls silent and the real immutable on the next line is accounted
 * for nowhere.
 *
 * The keyword is rejected only when the whole identifier is the keyword, and
 * that test cannot be a word boundary: `$` is legal in a Solidity identifier
 * but is not a regex word character, so `\b` reads `public$FEE` as the bare
 * keyword and turns the gate red on code that compiles.
 *
 * `constant` and `immutable` cannot reach this position — solc rejects either as
 * a repeated mutability — so they are defensive entries, unlike `public`,
 * `private`, `internal` and `override`, which all compile there.
 *
 * `transient` is deliberately not excluded. Solc rejects it as a data location
 * on an immutable, so it can never be the modifier this exclusion guards
 * against, while `uint256 public immutable transient` compiles. Excluding it
 * would only make a legal declaration unreadable, which fails the gate in both
 * modes.
 */
const RESERVED_AFTER_IMMUTABLE =
  'public|private|internal|override|constant|immutable'

const DECLARATION_RE = new RegExp(
  String.raw`^\s*([A-Za-z_$][\w$.]*(?:\[\d*\])*(?:\s+payable)?)\s+(?:(public|private|internal)\s+)?immutable\s+(?!(?:${RESERVED_AFTER_IMMUTABLE})(?![\w$]))([A-Za-z_$][\w$]*)\s*(?:=|$)`,
  'u'
)

/**
 * Splits one masked line into the statements a declaration could start.
 *
 * Solidity permits two declarations on one line and permits one to sit directly
 * after `{`. Splitting on statement and block boundaries lets the anchored
 * pattern see each declaration as the start of its own statement, so a second
 * declaration is parsed rather than left for the reporter to flag.
 */
const statementsOf = (maskedLine: string): string[] =>
  maskedLine.split(/[;{}]/u)

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

  maskCommentsAndStrings(source)
    .split('\n')
    .forEach((maskedLine, index) => {
      for (const statement of statementsOf(maskedLine)) {
        const match = DECLARATION_RE.exec(statement)
        if (!match) continue

        const [, type, visibility, name] = match
        if (!type || !name) continue

        found.push({
          file,
          line: index + 1,
          type,
          ...(visibility
            ? { visibility: visibility as IImmutableDeclaration['visibility'] }
            : {}),
          name,
        })
      }
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
 * Counts rather than a line-level "did this line parse?" test, so that the
 * second declaration on a line is reported instead of reading as covered by the
 * first.
 *
 * @param source - The file's contents.
 * @param file - Repo-relative path, carried onto each result.
 * @returns One entry per unreadable line, in source order, carrying the line as
 * written so the operator sees the shape rather than the masked text.
 */
export const findUnreadableImmutableLines = (
  source: string,
  file: string
): { file: string; line: number; text: string }[] => {
  const parsedPerLine = new Map<number, number>()
  for (const declaration of parseImmutableDeclarations(source, file))
    parsedPerLine.set(
      declaration.line,
      (parsedPerLine.get(declaration.line) ?? 0) + 1
    )

  const asWritten = source.split('\n')

  return maskCommentsAndStrings(source)
    .split('\n')
    .flatMap((maskedLine, index) => {
      const line = index + 1
      // Same identifier rule the name capture uses, and for the same reason: a
      // word boundary treats the `immutable` inside a name like `immutable$I`
      // as a second mention, so one declaration would be counted twice and the
      // line reported as hiding something.
      const mentions = (
        maskedLine.match(/(?<![\w$])immutable(?![\w$])/gu) ?? []
      ).length
      if (mentions <= (parsedPerLine.get(line) ?? 0)) return []
      return [{ file, line, text: (asWritten[index] ?? '').trim() }]
    })
}
