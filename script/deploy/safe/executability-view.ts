/**
 * The executability verdict as a panel: one section per call, and a headline a
 * signer can read without reading anything under it.
 *
 * Built after the same rehearsal that produced `signer-view.ts`. The verdict's
 * own `reason` is one string holding every blocking finding joined with
 * semicolons, and each `eth_call` finding carries the node's error verbatim —
 * which for viem means the reason, the whole calldata echoed back, and a version
 * banner. Printed as a check's `observed` value it arrived as a wall of hex with
 * no boundary between one call and the next, so which call had failed, and how
 * many had, could not be read off the screen at all.
 *
 * The wall was a formatting problem, not a data problem: nothing here decides
 * anything, and every line it draws comes from a field {@link
 * evaluateExecutability} already set.
 */

import {
  ExecutabilityFindingEnum,
  type IExecutabilityCall,
  type IExecutabilityFinding,
  type IExecutabilityVerdict,
} from './executability-simulation'
import { VIEW_WIDTH } from './signer-view'

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const RED = `${ESC}[31m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`

/** Columns a check block is indented by before its values begin. */
export const CHECK_BLOCK_INDENT = 8

/**
 * Columns the panel draws to.
 *
 * Derived from the view's own width rather than written down, because the two
 * only have to agree when the panel is printed inside a check block — and a
 * copied constant agrees until someone widens the view, at which point the
 * panel silently stops filling it and nothing fails.
 */
export const PANEL_WIDTH = VIEW_WIDTH - CHECK_BLOCK_INDENT

/** Longest a single token may be before its middle is elided. */
const TOKEN_BUDGET = 24

/**
 * Where a node's error stops saying what happened and starts repeating itself.
 *
 * Anchored on any whitespace rather than on a newline, because by the time a
 * message reaches here the line breaks may already be gone: the collector's
 * `summariseRpcError` drops the echoed request and the version banner and
 * joins what is left onto one line, which leaves viem's `Details:` — a verbatim
 * restatement of the reason already in the first sentence — sitting mid-line
 * where a newline anchor cannot see it.
 */
const ECHO_SECTIONS =
  /\s(?:Raw Call Arguments|Request Arguments|Details|Version|Docs|URL)\s*:/iu

/**
 * A node's error message, reduced to the part that says what happened.
 *
 * Deliberately still correct on a raw viem error as well as on a collector
 * summary. The two overlap — `summariseRpcError` also drops the echoed request
 * — and that is not waste: a message reaching the panel from a path that did
 * not go through the collector must not put a calldata dump on the screen, and
 * the overlap is a few characters of regex rather than a second mechanism.
 *
 * Kept, never rewritten: the reason itself is passed through as the node wrote
 * it.
 *
 * @param message - The node's error text, from the collector or raw.
 * @returns The reason, without the echoed request, banners or restatement.
 */
export const condenseNodeMessage = (message: string): string => {
  const [head = ''] = message.split(ECHO_SECTIONS)

  return head
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) =>
      token.length > TOKEN_BUDGET
        ? `${token.slice(0, TOKEN_BUDGET - 8)}…${token.slice(-4)}`
        : token
    )
    .join(' ')
    .trim()
}

/** An address as it reads in a heading: enough to recognise, not to retype. */
const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address

/**
 * Wraps to the panel width, eliding the middle of any token too long to fit.
 *
 * An address and a selector both fit whole, which is what matters: a signer
 * comparing one against an out-of-band message needs every character of it. A
 * token longer than a whole line is not one of those — the values reaching here
 * come off calldata a proposer wrote, so it is either malformed or shaped to
 * break the view, and neither may be allowed to push the rows underneath out of
 * alignment.
 */
const wrap = (text: string, indent: string, hang: string): string[] => {
  const budget = Math.max(20, PANEL_WIDTH - hang.length)
  const out: string[] = []
  let line = ''

  const words = text
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) =>
      word.length > budget
        ? `${word.slice(0, budget - 9)}…${word.slice(-4)}`
        : word
    )

  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > budget && line) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)

  return out.map((value, position) =>
    position === 0 ? `${indent}${value}` : `${hang}${value}`
  )
}

interface IOutcomeStyle {
  glyph: string
  colour: string
}

const OUTCOME_STYLE: ReadonlyMap<IExecutabilityCall['outcome'], IOutcomeStyle> =
  new Map([
    ['would-execute', { glyph: '✓', colour: GREEN }],
    ['would-revert', { glyph: '⛔', colour: RED }],
    ['unknown', { glyph: '?', colour: YELLOW }],
  ])

/** What `eth_call` said, in the signer's terms rather than the node's. */
const SIMULATION_PHRASE: ReadonlyMap<IExecutabilityCall['simulation'], string> =
  new Map([
    ['succeeded', 'eth_call succeeded'],
    ['reverted', 'eth_call reverted'],
    ['errored', 'eth_call could not be made'],
    ['none', 'not simulated with eth_call'],
  ])

/**
 * A finding already stated by the call's own simulation line.
 *
 * `StaticCallReverted` is the `eth_call` outcome wearing a finding's clothes:
 * printing both puts the same revert on the screen twice, and the second copy
 * carries the node's message unabridged.
 */
const isSimulationEcho = (finding: IExecutabilityFinding): boolean =>
  finding.code === ExecutabilityFindingEnum.StaticCallReverted

/** The tail of a finding's path, relative to the call it sits in. */
const relativePath = (finding: IExecutabilityFinding, path: string): string =>
  finding.path.startsWith(`${path}.`)
    ? finding.path.slice(path.length + 1)
    : finding.path

/**
 * A finding's detail with the leading path removed.
 *
 * Every detail opens with the absolute path of what it is about, because the
 * verdict's own one-line `reason` joins them into a list where nothing else
 * says which element each one names. Under a heading that already carries the
 * call and beside the element's relative path, that prefix is the same location
 * stated three times, and it pushes the sentence off the first line.
 */
const withoutPathPrefix = (detail: string, path: string): string =>
  detail.startsWith(`${path}`) ? detail.slice(path.length).trimStart() : detail

/** Colours the first line only; a continuation carries no reset of its own. */
const paint = (lines: readonly string[], colour: string): string[] =>
  lines.map((line, position) =>
    position === 0 ? `${colour}${line}${RESET}` : line
  )

const renderCall = (call: IExecutabilityCall): string[] => {
  const style = OUTCOME_STYLE.get(call.outcome) ?? {
    glyph: '?',
    colour: YELLOW,
  }
  const out: string[] = ['']

  out.push(
    `${style.colour}${style.glyph}${RESET} ${BOLD}${call.path}${RESET}  ` +
      `${call.description} → ${shortAddress(call.target)}`
  )

  const sender = call.caller
    ? `sent by ${shortAddress(call.caller)}`
    : 'sender not recorded'
  out.push(
    ...paint(
      wrap(
        `${sender}${
          call.modelled
            ? ''
            : ' · no revert model, judged on its eth_call alone'
        }`,
        '    ',
        '    '
      ),
      DIM
    )
  )

  const phrase = SIMULATION_PHRASE.get(call.simulation) ?? call.simulation
  const detail = call.simulationDetail
    ? `: ${condenseNodeMessage(call.simulationDetail)}`
    : ''
  const simulationColour =
    call.simulation === 'succeeded'
      ? GREEN
      : call.simulation === 'reverted'
      ? RED
      : YELLOW
  out.push(
    ...paint(wrap(`${phrase}${detail}`, '    ', '      '), simulationColour)
  )

  for (const finding of call.findings.filter((f) => !isSimulationEcho(f))) {
    const marker = finding.blocking ? '⛔' : '⚠'
    const where = relativePath(finding, call.path)
    out.push(
      ...paint(
        wrap(
          `${marker} ${where} — ${withoutPathPrefix(
            finding.detail,
            finding.path
          )} (${finding.certainty})`,
          '    ',
          '       '
        ),
        finding.blocking ? RED : YELLOW
      )
    )
  }

  return out
}

/**
 * The verdict as lines.
 *
 * The headline states the answer on its own, because it is the line a signer
 * reads before deciding whether to read the rest: `SUCCESSFUL` only when every
 * call was decided and none of them reverts, and `INCONCLUSIVE` — never a
 * silence, and never a pass — when a question went unanswered.
 *
 * @param verdict - What `evaluateExecutability` decided.
 * @returns The panel, ready to be indented into a check block.
 */
export const executabilityPanel = (
  verdict: IExecutabilityVerdict
): string[] => {
  const total = verdict.calls.length
  const reverting = verdict.calls.filter(
    (call) => call.outcome === 'would-revert'
  ).length
  const undecided = verdict.calls.filter(
    (call) => call.outcome === 'unknown'
  ).length
  const noun = total === 1 ? 'call' : 'calls'

  // A proposal with no payload at all has nothing to have succeeded, and
  // "0 of 0 calls would execute" beside a green SUCCESSFUL is how an empty run
  // reads as a verified one.
  const headline =
    total === 0
      ? `${YELLOW}${BOLD}Simulation: INCONCLUSIVE${RESET} — no call was simulated`
      : verdict.refuses
      ? `${RED}${BOLD}Simulation: FAILED${RESET} — ${reverting} of ${total} ${noun} would revert`
      : verdict.error
      ? // A run can be undecided without any single call being undecided — a
        // selector nobody looked up leaves the payload it sits in unproven
        // while its own `eth_call` still answered. "0 of 1 call could not be
        // decided" then reads as nothing being wrong, beside a word that says
        // something is.
        `${YELLOW}${BOLD}Simulation: INCONCLUSIVE${RESET} — ${
          undecided > 0
            ? `${undecided} of ${total} ${noun} could not be decided`
            : 'a question about this proposal went unanswered'
        }`
      : `${GREEN}${BOLD}Simulation: SUCCESSFUL${RESET} — ${total} of ${total} ${noun} would execute`

  const out: string[] = [headline]

  for (const call of verdict.calls) out.push(...renderCall(call))

  // Nonce and funding are properties of the transaction, not of any one call in
  // it, so they have nowhere to sit in the sections above — and dropping them
  // here is how a nonce collision stops reaching the screen.
  const inCalls = new Set(
    verdict.calls.flatMap((call) => call.findings.map((f) => f.detail))
  )
  const loose = verdict.findings.filter(
    (finding) => !inCalls.has(finding.detail)
  )

  if (loose.length > 0) {
    out.push('')
    out.push(`${BOLD}this proposal as a whole${RESET}`)
    for (const finding of loose)
      out.push(
        ...paint(
          wrap(
            `${finding.blocking ? '⛔' : '⚠'} ${finding.detail}`,
            '    ',
            '       '
          ),
          finding.blocking ? RED : YELLOW
        )
      )
  }

  if (verdict.errors.length > 0) {
    out.push('')
    out.push(`${YELLOW}${BOLD}why this run could not decide${RESET}`)
    // Wrapped, not condensed: these are the simulation's own sentences, and
    // the condenser is sized for a node's error — it would elide the middle of
    // the payload path and the diamond address each one is naming, which are
    // the two things an operator reads the line for.
    for (const message of verdict.errors)
      out.push(...wrap(`? ${message}`, '    ', '      '))
  }

  return out
}

/**
 * The panel as a `signerChecks` note, indented into the check block.
 *
 * A note rather than a new field on the row, because `renderCheckGroups` prints
 * notes exactly as it is handed them — so the panel keeps its own structure and
 * colour, and `signer-view.ts` needs to know nothing about executability. It is
 * also the one channel that survives the check landing in the collapsed PASSED
 * run, which is where a signer sees `Simulation: SUCCESSFUL`.
 *
 * @param verdict - What `evaluateExecutability` decided.
 * @returns Lines for the `notes` map, keyed by the executability check id.
 */
export const executabilityNotes = (
  verdict: IExecutabilityVerdict
): readonly string[] =>
  executabilityPanel(verdict).map((line) =>
    line ? `${' '.repeat(CHECK_BLOCK_INDENT)}${line}` : ''
  )
