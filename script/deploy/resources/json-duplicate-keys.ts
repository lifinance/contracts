/**
 * Finds keys an object declares more than once.
 *
 * `JSON.parse` keeps the last of them and `jsonlint` accepts them, so a
 * duplicated key silently voids what its earlier copies said while the file
 * reads as valid at every other gate. Scanning the text is the only way to see
 * them: by the time a parser has run, they are gone.
 */

export interface IDuplicateKey {
  /** Dotted path of the object that declares it twice; `$` is the document root. */
  path: string
  key: string
  /** 1-based line of the repeat, not of the first occurrence. */
  line: number
}

interface IFrame {
  isObject: boolean
  path: string
  seen: Set<string>
  /** The key the next `{`/`[` belongs to, for a child frame's path. */
  keyForNext: string | null
  arrayIndex: number
}

interface IStringToken {
  /** The source slice including both quotes, so `JSON.parse` can decode it. */
  raw: string
  line: number
}

const childPath = (parent: IFrame | undefined): string => {
  if (!parent) return '$'
  return parent.isObject
    ? `${parent.path}.${parent.keyForNext ?? '?'}`
    : `${parent.path}[${parent.arrayIndex}]`
}

/**
 * Reads one JSON string starting at an opening quote.
 *
 * @param text - The whole document.
 * @param start - Index of the opening quote.
 * @returns The token, and the index just past its closing quote.
 */
const readString = (
  text: string,
  start: number
): { raw: string; next: number; newlines: number } => {
  let index = start + 1
  let newlines = 0

  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      index++
      break
    }
    // An unescaped newline is malformed JSON, but counting it keeps every later
    // line number honest instead of reporting the rest of the file one line off.
    if (char === '\n') newlines++
    index++
  }

  return { raw: text.slice(start, index), next: index, newlines }
}

/**
 * Scans a JSON document for repeated keys within the same object.
 *
 * Decodes each key before comparing, so `"a"` and `"a"` count as the same
 * key — they are one key to every parser that will read the file.
 *
 * @param text - The JSON document as it sits on disk.
 * @returns One entry per repeat, in the order the repeats appear.
 */
export const findDuplicateKeys = (text: string): IDuplicateKey[] => {
  const duplicates: IDuplicateKey[] = []
  const stack: IFrame[] = []
  let index = 0
  let line = 1
  let pending: IStringToken | null = null

  while (index < text.length) {
    const char = text[index]

    if (char === '\n') {
      line++
      index++
      continue
    }

    if (char === '"') {
      const { raw, next, newlines } = readString(text, index)
      pending = { raw, line }
      line += newlines
      index = next
      continue
    }

    const frame = stack[stack.length - 1]

    switch (char) {
      case '{':
      case '[':
        stack.push({
          isObject: char === '{',
          path: childPath(frame),
          seen: new Set<string>(),
          keyForNext: null,
          arrayIndex: 0,
        })
        pending = null
        break
      case '}':
      case ']':
        stack.pop()
        pending = null
        break
      case ',':
        if (frame && !frame.isObject) frame.arrayIndex++
        pending = null
        break
      case ':':
        // A string is a key exactly when a colon follows it, so the decision is
        // made here rather than by looking ahead from the string itself.
        if (frame?.isObject && pending) {
          const key = JSON.parse(pending.raw) as string
          if (frame.seen.has(key))
            duplicates.push({ path: frame.path, key, line: pending.line })
          else frame.seen.add(key)
          frame.keyForNext = key
        }
        pending = null
        break
      default:
        break
    }

    index++
  }

  return duplicates
}

/**
 * Renders one finding as a line a reviewer can act on.
 *
 * @param file - Path of the file the finding came from.
 * @param duplicate - The finding.
 * @returns The message.
 */
export const formatDuplicateKey = (
  file: string,
  duplicate: IDuplicateKey
): string =>
  `${file}:${duplicate.line} declares '${duplicate.key}' again under ${duplicate.path}. Every parser keeps only the last one, so the earlier copy is silently dropped.`
