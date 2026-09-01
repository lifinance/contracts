/**
 * Reads CLI flags straight from `argv`, refusing any form whose meaning is not
 * unambiguous. Import it in a citty command that reads a signing flag: citty
 * cannot distinguish `--ledgerLive=no` from a bare `--ledgerLive`, discards a
 * space-separated value, and keeps one occurrence of a repeated flag, and none
 * of that is recoverable once the command body runs.
 */

export interface IFlagName {
  /** The spelling registered with the parser, e.g. `ledgerLive`. */
  camel: string
  /** The dashed spelling an operator may type instead, e.g. `ledger-live`. */
  kebab: string
}

interface IOccurrence {
  /** The `=value`, or undefined for a bare flag. */
  assigned?: string
  /** The next argv entry, when it is not itself a flag. */
  following?: string
  /** True for the `--no-<flag>` spelling. */
  negated: boolean
}

const uniqueOccurrence = (
  argv: string[],
  name: IFlagName
): IOccurrence | undefined => {
  // Everything after a bare `--` is the callee's, not ours.
  const terminator = argv.indexOf('--')
  const scanned = terminator === -1 ? argv : argv.slice(0, terminator)

  const spellings = [name.camel, name.kebab]
  const prefixes = spellings.flatMap((s) => [`--${s}`, `--no-${s}`])

  const found: IOccurrence[] = []
  scanned.forEach((entry, index) => {
    // Matched whole, never by prefix: `--ledgerLiveExtra` is a different flag,
    // and a value that merely contains the flag name is not an occurrence.
    const match = prefixes.find(
      (prefix) => entry === prefix || entry.startsWith(`${prefix}=`)
    )
    if (!match) return

    const next = scanned[index + 1]
    found.push({
      negated: match.startsWith('--no-'),
      ...(entry.includes('=')
        ? { assigned: entry.slice(entry.indexOf('=') + 1) }
        : {}),
      ...(next !== undefined && !next.startsWith('-')
        ? { following: next }
        : {}),
    })
  })

  if (found.length > 1)
    throw new Error(
      `--${name.camel} was given more than once (${found.length}×). Which one wins is not something this script should decide quietly — pass it once.`
    )

  return found[0]
}

export interface IBooleanFlagOptions {
  /** What absence means. Some flags default ON, e.g. `--ledger` when signing. */
  whenAbsent?: boolean
}

/**
 * Reads a boolean flag, refusing any form that is not unambiguous.
 *
 * @param argv - Raw arguments, normally `process.argv`.
 * @param name - Both spellings of the flag.
 * @param options - What absence means, when it is not `false`.
 * @returns Whether the flag is on.
 * @throws If the flag appears more than once, or carries a value other than
 * `true` or `false`.
 */
export const readBooleanFlag = (
  argv: string[],
  name: IFlagName,
  options: IBooleanFlagOptions = {}
): boolean => {
  const occurrence = uniqueOccurrence(argv, name)
  if (!occurrence) return options.whenAbsent ?? false

  const value = occurrence.assigned ?? occurrence.following

  // `--no-flag=false` is a double negative with no obvious reading, and it
  // resolved to ON. Refused rather than resolved either way.
  if (occurrence.negated && value !== undefined)
    throw new Error(
      `--no-${name.camel} takes no value; got '${value}'. Pass --no-${name.camel} on its own, or --${name.camel}=${value}.`
    )

  if (value === undefined) return !occurrence.negated
  if (value === 'true') return !occurrence.negated
  if (value === 'false') return occurrence.negated

  throw new Error(
    `--${name.camel} accepts no value, 'true' or 'false'; got '${value}'. Pass --${name.camel} on its own to enable it.`
  )
}

/**
 * Reads a flag that carries a value, as the raw string the operator typed.
 *
 * Deliberately does not convert: `Number('')` is 0, so coercing here would turn
 * `--accountIndex "$UNSET_VAR"` into account 0 before any validator can refuse
 * it. An empty assignment is returned as `''` rather than as absence, for the
 * same reason.
 *
 * @param argv - Raw arguments, normally `process.argv`.
 * @param name - Both spellings of the flag.
 * @returns What was passed, or undefined when the flag is absent.
 * @throws If the flag appears more than once, or appears with no value at all.
 */
export const readValueFlag = (
  argv: string[],
  name: IFlagName
): string | undefined => {
  const occurrence = uniqueOccurrence(argv, name)
  if (!occurrence) return undefined

  const value = occurrence.assigned ?? occurrence.following
  if (value === undefined)
    throw new Error(
      `--${name.camel} needs a value, e.g. --${name.camel} <value>.`
    )

  return value
}
