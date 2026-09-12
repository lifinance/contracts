/**
 * Feeds `signer-view.ts` from the verdicts a confirmation run actually holds.
 *
 * `signer-view.ts` knows how the three zones are drawn and nothing about which
 * checks exist; the modules that produce verdicts know their own subject and
 * nothing about the view. The translation is here so neither has to grow a
 * dependency on the other, and so a check added to the run reaches the view by
 * appearing in `results` rather than by editing a renderer.
 */

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import { rollUpChecks } from './check-ledger'
import { TARGET_STATE_CHECK } from './confirm-check-registry'
import {
  CHECK_SIGNATURES,
  CHECK_TIMELOCK_DELAY,
  INTEGRITY_CHECK_DEFINITIONS,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import type { IBucketedResult, ITodo } from './signer-view'

/**
 * Titles the signer view uses instead of the definition's own.
 *
 * Overridden here rather than renamed at the definition, because the other
 * readers of these checks — the run-level ledger, the refusal messages — name
 * the thing that was asserted, while a signer skimming a grouped list needs the
 * subject. A count ("0 stored signatures") is the worst of both: it is what the
 * row observed, printed where the row's name belongs.
 */
const VIEW_TITLES: ReadonlyMap<string, string> = new Map([
  [CHECK_SIGNATURES, 'Signatures recover to current owners'],
  ['executability', 'Calldata simulation'],
])

/** Every definition the signer view can name, by check id. */
export const viewDefinitions = (
  extra: readonly ICheckDefinition[] = []
): ReadonlyMap<string, ICheckDefinition> => {
  const all = [
    ...Object.values(INTEGRITY_CHECK_DEFINITIONS),
    TARGET_STATE_CHECK,
    ...extra,
  ]
  return new Map(
    all.map((definition) => [
      definition.checkId,
      {
        ...definition,
        title: VIEW_TITLES.get(definition.checkId) ?? definition.title,
      },
    ])
  )
}

/** A run that never produced a verdict, as the one row that says so. */
const UNEVALUATED: ICheckResult = {
  checkId: 'proposal-integrity',
  network: '',
  status: 'error',
  expected: 'every integrity assertion answered for this proposal',
  actual: 'the assertions produced no verdict at all',
  anchor: 'A-UNRESOLVED',
  detail:
    'nothing here permits signing this proposal — investigate why the assertions could not run',
}

/** What the integrity run contributes to zone 2, graded as the ledger grades it. */
export const integrityResults = (
  run: IIntegrityAssertRun | undefined
): {
  results: ICheckResult[]
  notApplicable: Map<string, string>
} => {
  const notApplicable = new Map<string, string>()
  if (!run) return { results: [UNEVALUATED], notApplicable }

  // Rolled up rather than read off `ledger.results`: the roll-up is where a
  // status the grading rules would downgrade is downgraded, so the raw log can
  // still show a pass the ledger does not accept.
  const results: ICheckResult[] = []
  for (const check of rollUpChecks(run.ledger))
    if (check.results.length === 0)
      results.push({
        checkId: check.checkId,
        network: '',
        status: 'error',
        expected: 'a verdict from a check this proposal registered',
        actual: 'the check was registered and produced no result',
        anchor: 'A-UNRESOLVED',
      })
    else results.push(...check.results)

  for (const definition of Object.values(INTEGRITY_CHECK_DEFINITIONS))
    if (!run.registered.includes(definition.checkId))
      notApplicable.set(
        definition.checkId,
        definition.checkId === CHECK_TIMELOCK_DELAY
          ? 'this proposal is not a timelock schedule, so there is no delay to check'
          : 'this proposal gave the check nothing to answer for'
      )

  return { results, notApplicable }
}

/**
 * Zone 2's rows, in the order the results were produced.
 *
 * `notApplicable` is carried alongside the results rather than encoded in one,
 * because a check with nothing to answer for produced no result to encode it
 * in — and a fabricated row would have to claim a status, which is the
 * conflation `bucketOf` exists to prevent.
 */
export const signerChecks = (input: {
  results: readonly ICheckResult[]
  notApplicable?: ReadonlyMap<string, string>
  definitions: ReadonlyMap<string, ICheckDefinition>
}): IBucketedResult[] => {
  const rows: IBucketedResult[] = input.results.map((result) => ({
    result,
    definition: input.definitions.get(result.checkId),
  }))

  // A check that answered is not a check with nothing to answer for, whatever
  // it answered. A caller can legitimately supply both — the registry grades an
  // unregistered delay check as a pass on what it read, while the run that
  // registered nothing knows why — and printing both puts one check in two
  // buckets, which is precisely the reading the grouping exists to prevent.
  const answered = new Set(input.results.map((result) => result.checkId))

  for (const [checkId, reason] of input.notApplicable ?? [])
    if (!answered.has(checkId))
      rows.push({
        definition: input.definitions.get(checkId),
        notApplicable: reason,
        result: {
          checkId,
          network: '',
          status: 'pass',
          expected: '',
          actual: '',
          anchor: 'A-LOCAL',
        },
      })

  return rows
}

export interface ISignerTodoInput {
  /** The hash the Safe contract computes, when it could be computed. */
  deviceHash?: string
  /** How the stored hash compares, when there is a computed hash to compare to. */
  storedHash?: 'agrees' | 'unreadable' | 'disagrees'
  /** The device screens, already drawn. */
  devicePanel?: readonly string[]
  /** A note printed under the panel, such as the wrapping caveat. */
  devicePanelNote?: string
}

const HASH_AUTHORITY = [
  'The authority is the hash in the out-of-band message from the proposer —',
  'not the hash stored on the proposal row, which the proposer controls',
  'alongside the calldata.',
  'Compare 16 characters, 8 from each end: four-and-four is grindable by',
  'whoever wrote the payload.',
]

/**
 * Zone 3, in the order the steps are performed.
 *
 * The hash comparison comes first because it is the only step that can still
 * refuse the transaction; the device panel is there to be compared against once
 * the signer already knows which hash is the right one.
 */
export const signerTodos = (input: ISignerTodoInput): ITodo[] => {
  const hashLines = input.deviceHash
    ? [
        `Your device will show  [36m${input.deviceHash}[0m`,
        ...(input.storedHash === 'disagrees'
          ? [
              '[33m⚠ the hash stored on this proposal is not the hash the Safe computes from it[0m',
            ]
          : []),
        ...(input.storedHash === 'unreadable'
          ? ['[33m⚠ this proposal carries no readable stored hash[0m']
          : []),
        ...HASH_AUTHORITY,
      ]
    : [
        '[33m⚠ the hash could not be computed here, so it is not previewed[0m',
        'Compare the screen on your device directly against the out-of-band message.',
        ...HASH_AUTHORITY,
      ]

  const todos: ITodo[] = [
    {
      text: "Compare the hash against the proposer's out-of-band message",
      lines: hashLines,
    },
  ]

  if (input.devicePanel?.length)
    todos.push({
      text: 'Check every screen your device shows against these',
      lines: [
        ...input.devicePanel,
        ...(input.devicePanelNote ? [input.devicePanelNote] : []),
      ],
    })

  return todos
}
