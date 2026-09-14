/**
 * THE CALLDATA DOES — the decoded payload, as lines.
 *
 * The zone-1 counterpart to `safe-decode-utils`, which writes the same decode
 * straight to the console. This one returns lines, so the caller places them
 * inside its own block at its own column, and it renders under zone 1's rule:
 * it states what the payload holds and never grades it. A short delay, an
 * unnamed target, a `diamondCut` action outside 0–2 are values here; the gates
 * in zone 2 are what judge them. The two exceptions are this section reporting
 * on its own output — that it could not decode something, and that on a
 * delegatecall the decode describes a call that will not happen (the caller
 * prints the second, above these lines).
 *
 * Every value comes off a MongoDB proposal row and is rendered through
 * `printable-field` rather than interpolated into the colour codes raw, for the
 * reasons `safe-tx-detail-display` sets out at length. Two rules are specific to
 * this module:
 *
 * - **The summarising sentence is syntax this module owns.** A verb comes from
 *   a closed set keyed by a decoded value; the decoded value itself is quoted
 *   and left ungraded. Composing the sentence out of the payload instead would
 *   let a proposer write the line — a `diamondCut` carrying `action: 7` reads
 *   as `action "7" on 2 functions`, never as a verb of the proposer's choosing.
 * - **Every collapsed element is counted, never silently dropped.** An array
 *   length is encoded in the calldata, so a payload can scroll the claim off
 *   the screen without any single field being long; each bound says how many
 *   it is holding back.
 */

import { formatAddressForNetworkCliDisplay } from '@lifi/tron-devkit'
import type { Address, Hex } from 'viem'
import { decodeFunctionData, parseAbi } from 'viem'

import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'
import { buildExplorerContractPageUrl } from '../../utils/viemScriptHelpers'

import {
  asPrintable,
  color,
  colorAroundNotices,
  concatPrintable,
  MAX_FIELD_CHARS,
  type Printable,
  trustedMarkup,
} from './printable-field'
import {
  formatDecodedArg,
  getAbiForKnownFunction,
  getDiamondAbiItemForSelector,
  getRoleName,
  getTargetName,
} from './safe-decode-utils'
import {
  createSelectorMap,
  getContractNameFromNetworkDeployments,
  getContractNameFromSelectorsInOut,
  normalizeDiamondCutSelector,
} from './safe-utils'
import {
  getLocalSelectorInfo,
  resolveSelectorsViaFourByte,
} from './selector-registry'

const GREEN = '[32m'
const RED = '[31m'
const YELLOW = '[33m'
const BLUE = '[94m'
const CYAN = '[36m'
const GREY = '[90m'
const BOLD = '[1m'

const EMPTY = trustedMarkup('')

/** The signer view's width. Held by value to keep this module standalone. */
const VIEW_WIDTH = 140

const ANSI_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')

const visibleWidth = (text: string): number =>
  text.replace(ANSI_CODES, '').length

/** Selectors listed under one facet cut before the rest are counted instead. */
const MAX_SELECTORS_SHOWN = 24
/** Calls listed under one batch before the rest are counted instead. */
const MAX_CALLS_SHOWN = 16
/** Arguments listed under one unrecognised call before the rest are counted. */
const MAX_ARGS_SHOWN = 16
/** Contract/selector pairs listed before the rest are counted instead. */
const MAX_WHITELIST_ROWS_SHOWN = 24
/** Code points of the raw calldata shown when nothing decoded it. */
const RAW_PREVIEW_CHARS = 66

/**
 * The verbs for a `diamondCut` action, keyed by the decoded `uint8`.
 *
 * Closed by construction: a key outside this map does not produce a verb at
 * all, it produces the quoted value. See the module note.
 */
const DIAMOND_CUT_VERBS: Readonly<Record<number, string>> = {
  0: 'Add',
  1: 'Replace',
  2: 'Remove',
}

/**
 * The colour each verb is painted in, keyed off the same closed map.
 *
 * Off the map, never off the payload: an action this module cannot name gets
 * no colour either, so a proposal cannot choose how loudly it is drawn. Bold,
 * because the verb is the one word on the line a signer scans for and it sits
 * among the greys and blues the surrounding fields use.
 */
const DIAMOND_CUT_VERB_COLOURS: Readonly<Record<string, string>> = {
  Add: `${BOLD}${GREEN}`,
  Replace: `${BOLD}${YELLOW}`,
  Remove: `${BOLD}${RED}`,
}

/** Renders a stored value inside `code`, with its notice outside the colour. */
const storedField = (
  value: unknown,
  code: string,
  maxChars: number = MAX_FIELD_CHARS
): Printable => {
  const { text, notice } = asPrintable(value, maxChars)
  return concatPrintable(color(code, text), trustedMarkup(notice))
}

/** One value quoted for a sentence this module composes. */
const quoted = (value: unknown, code: string): Printable =>
  concatPrintable(
    trustedMarkup('"'),
    storedField(value, code),
    trustedMarkup('"')
  )

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * What the block says about elements it is not printing.
 *
 * Never omitted when something was held back: a payload whose extra elements
 * simply stop appearing renders identically to one that had none.
 */
const withheldLine = (
  pre: string,
  hidden: number,
  stored: number,
  noun: string
): string[] =>
  hidden > 0
    ? [
        `${pre}${color(
          YELLOW,
          trustedMarkup(
            `⚠ ${plural(
              hidden,
              `further ${noun}`
            )} not shown (${stored} in the calldata)`
          )
        )}`,
      ]
    : []

/**
 * An address as this network displays it, with its name and explorer link.
 *
 * A name and a link are resolved only for text that still identifies what was
 * stored and that this network would accept as an address. Sanitising a corrupt
 * address can produce a valid one — a zero-width space between two hex digits
 * simply disappears — and naming that would present a corrupt row as a contract
 * this repository deployed.
 */
interface IRenderedAddress {
  /** The address with any notice about it, never separated from the value. */
  readonly shown: Printable
  /** The deployment record's name for it, or undefined. */
  readonly name: Printable | undefined
  /** The explorer link, or undefined. */
  readonly url: Printable | undefined
}

async function renderAddress(
  network: string,
  stored: unknown
): Promise<IRenderedAddress> {
  const { text, identityPreserved, notice } = asPrintable(stored)
  let normalised: string | undefined
  try {
    normalised = normalizeAddressForNetwork(network, text.trim())
  } catch {
    normalised = undefined
  }
  if (normalised === undefined || !identityPreserved)
    return {
      shown: concatPrintable(
        color(BLUE, text),
        trustedMarkup(notice),
        color(
          YELLOW,
          trustedMarkup(
            normalised === undefined
              ? ` ⚠ not a valid address for ${network} — shown as stored, and no explorer link`
              : ' ⚠ name and link withheld — the stored value is not what is shown'
          )
        )
      ),
      name: undefined,
      url: undefined,
    }

  const display = formatAddressForNetworkCliDisplay(network, normalised)
  const name = await getTargetName(normalised as Address, network)
  const url = buildExplorerContractPageUrl(network, display)
  return {
    shown: concatPrintable(
      color(BLUE, asPrintable(display).text),
      trustedMarkup(notice)
    ),
    name: name ? color(YELLOW, asPrintable(name).text) : undefined,
    url: url ? color(CYAN, asPrintable(url).text) : undefined,
  }
}

/**
 * Lays a rendered address out from `opening`, folding only between fragments.
 *
 * A fold inside an address or a URL is the one fold this block must never make,
 * so a fragment that will not fit goes on its own line whole.
 */
function addressLines(
  pre: string,
  opening: Printable,
  address: IRenderedAddress,
  { withLink = true }: { withLink?: boolean } = {}
): string[] {
  const lines = [`${pre}${opening}${address.shown}`]
  const continuation = `${pre}  `
  for (const part of [address.name, withLink ? address.url : undefined]) {
    if (part === undefined) continue
    const last = lines[lines.length - 1] as string
    if (visibleWidth(last) + 1 + visibleWidth(part) <= VIEW_WIDTH)
      lines[lines.length - 1] = `${last} ${part}`
    else lines.push(`${continuation}${part}`)
  }
  return lines
}

/**
 * Renders an address without its explorer link.
 *
 * Used for a call's *target*, which the envelope line under this block already
 * links and which the deployment records have named anyway. A facet address
 * keeps its link: it is the contract being introduced, and the one a signer has
 * a reason to open.
 */
const NO_LINK = { withLink: false } as const

/** Names a value the section could not read, in the section's own voice. */
const cannotRead = (pre: string, what: string): string =>
  `${pre}${color(`${RED}`, trustedMarkup(what))}`

/**
 * The stored calldata as a bounded preview, for when nothing decoded it.
 */
const rawPreview = (data: unknown): Printable =>
  storedField(data, GREY, RAW_PREVIEW_CHARS)

export interface ICalldataEffectContext {
  /** Active `networks.json` key; decides address shape and explorer links. */
  readonly network: string
  /** Column the block's body is drawn at. */
  readonly indent: string
  /** The address this calldata is sent to, as stored. */
  readonly target: unknown
}

/**
 * What the payload does, as the lines of THE CALLDATA DOES.
 *
 * Never throws: the caller has no per-network catch, so an escape here would
 * cost the operator every network left in the run.
 * @param data - The calldata as stored
 * @param context - The network, the column to draw at, and the call's target
 * @returns The lines to print, in order
 */
export async function buildCalldataEffectLines(
  data: unknown,
  context: ICalldataEffectContext
): Promise<string[]> {
  try {
    return await effectLines(data, context, context.indent)
  } catch (error) {
    const { text, notice } = asPrintable(
      error instanceof Error ? error.message : error
    )
    return [
      `${context.indent}${color(
        RED,
        trustedMarkup('THE CALLDATA COULD NOT BE RENDERED: ')
      )}${color(RED, text)}${notice}`,
    ]
  }
}

async function effectLines(
  data: unknown,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  const { text: dataText } = asPrintable(data, Number.POSITIVE_INFINITY)
  if (dataText === '' || dataText === '0x')
    return [`${pre}${color(GREY, trustedMarkup('no calldata'))}`]
  if (!/^0x[0-9a-fA-F]*$/u.test(dataText))
    return [
      cannotRead(pre, 'CALLDATA COULD NOT BE DECODED — it is not hex:'),
      `${pre}  ${rawPreview(data)}`,
    ]

  const hex = dataText as Hex
  const decoded = await decodeCall(hex)
  if (!decoded)
    return [
      cannotRead(pre, 'CALLDATA COULD NOT BE DECODED — no ABI matches it:'),
      `${pre}  ${rawPreview(data)}`,
    ]

  const { functionName, args } = decoded
  const called = calledFunction(functionName, hex)
  if (args === undefined)
    return [
      `${pre}${called}`,
      cannotRead(pre, '  ARGUMENTS COULD NOT BE DECODED'),
      `${pre}  ${rawPreview(data)}`,
    ]

  switch (bareName(functionName)) {
    case 'scheduleBatch':
      return scheduleBatchLines(args, called, context, pre)
    case 'schedule':
      return scheduleLines(args, called, context, pre)
    case 'diamondCut':
      return diamondCutLines(args, called, context, pre)
    case 'batchSetContractSelectorWhitelist':
      return whitelistLines(args, called, context, pre)
    case 'registerPeripheryContract':
      return registerPeripheryLines(args, called, context, pre)
    case 'grantRole':
    case 'revokeRole':
    case 'renounceRole':
      return roleChangeLines(functionName, args, called, context, pre)
    default:
      return genericCallLines(functionName, args, hex, context, pre)
  }
}

/**
 * The function this calldata invokes, named and with its selector.
 *
 * Every summarising line opens with this. The name is what the signer is
 * looking for and the selector is the part of the payload that chose it, so a
 * name resolved from a registry can be checked against the four bytes it claims
 * to decode rather than taken on trust. The name is sanitised: it can come from
 * a third-party 4byte lookup keyed on a selector the proposer wrote.
 */
const calledFunction = (functionName: string, data: Hex): Printable =>
  concatPrintable(
    color(BLUE, asPrintable(bareName(functionName)).text),
    color(GREY, trustedMarkup(` [${asPrintable(data.slice(0, 10)).text}]`))
  )

/** The function name without its argument list. */
const bareName = (functionName: string): string =>
  functionName.split('(')[0]?.trim() ?? functionName

/**
 * Resolves and decodes one call, without printing how it was resolved.
 *
 * `args` is undefined when the selector resolved but nothing could decode the
 * arguments — the one case zone 1 reports on itself.
 */
async function decodeCall(
  data: Hex
): Promise<{ functionName: string; args?: readonly unknown[] } | undefined> {
  const selector = data.slice(0, 10)
  const local = getLocalSelectorInfo(selector)
  const functionName =
    local?.source === 'diamond.json'
      ? local.name
      : local?.signature ??
        (await resolveSelectorsViaFourByte([selector])).get(selector)

  const candidates = []
  if (functionName) {
    const known = getAbiForKnownFunction(functionName)
    if (known) candidates.push(known)
    try {
      candidates.push(parseAbi([`function ${functionName}`] as [string]))
    } catch {
      // A 4byte signature is third-party text; `parseAbi` throws on a shape it
      // does not recognise, which leaves the other candidates to try.
    }
  }
  const abiItem = getDiamondAbiItemForSelector(selector)
  if (abiItem?.type === 'function') candidates.push([abiItem])

  for (const abi of candidates)
    try {
      const decoded = decodeFunctionData({ abi, data })
      return { functionName: decoded.functionName, args: decoded.args }
    } catch {
      continue
    }

  return functionName === undefined ? undefined : { functionName }
}

const isZeroWord = (value: unknown): boolean =>
  /^0x0{1,64}$/u.test(String(value ?? ''))

/**
 * The timelock header a scheduled call sits under.
 *
 * `salt` never reaches a line: it is per-proposal entropy that makes the
 * operation id unique, and a signer has nothing to compare it to. `predecessor`
 * earns a line of its own exactly when it is non-zero, which is when this
 * operation is ordered behind another one — the zero case is the whole of what
 * it has to say, and saying it costs a line on every honest proposal.
 */
const timelockHeader = (pre: string, called: Printable): string =>
  `${pre}${called}`

const predecessorLines = (pre: string, predecessor: unknown): string[] =>
  isZeroWord(predecessor)
    ? []
    : [
        `${pre}${color(
          GREY,
          trustedMarkup('ordered behind operation ')
        )}${storedField(predecessor, GREEN)}`,
      ]

const valueLine = (pre: string, value: unknown): string[] =>
  isZeroValue(value)
    ? []
    : [
        `${pre}${color(GREY, trustedMarkup('value '))}${storedField(
          value,
          GREEN
        )}`,
      ]

async function scheduleBatchLines(
  args: readonly unknown[],
  called: Printable,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  if (args.length < 6)
    return [cannotRead(pre, 'SCHEDULEBATCH ARGUMENTS COULD NOT BE READ')]
  const [targets, values, payloads, predecessor] = args
  if (
    !Array.isArray(targets) ||
    !Array.isArray(values) ||
    !Array.isArray(payloads)
  )
    return [
      cannotRead(
        pre,
        'SCHEDULEBATCH ARGUMENTS COULD NOT BE READ — targets, values and payloads are not all arrays'
      ),
    ]

  const count = Math.max(targets.length, values.length, payloads.length)
  const lines = [timelockHeader(pre, called)]
  if (targets.length !== values.length || values.length !== payloads.length)
    lines.push(
      cannotRead(
        pre,
        `the three arrays disagree on length — targets ${targets.length}, values ${values.length}, payloads ${payloads.length}`
      )
    )
  lines.push(...predecessorLines(`${pre}  `, predecessor))

  const shown = Math.min(count, MAX_CALLS_SHOWN)
  for (let i = 0; i < shown; i++) {
    const label = count === 1 ? '' : `[${String(i).padStart(2, '0')}] `
    const callPre = `${pre}  ${' '.repeat(label.length)}`
    const call = await effectLines(
      payloads[i],
      { ...context, target: targets[i] },
      callPre
    )
    // The index replaces the first line's own indent rather than being prefixed
    // to it, so the lines under it stay in one column.
    lines.push(
      ...call.map((line, index) =>
        index === 0 && label !== ''
          ? `${pre}  ${color(GREY, trustedMarkup(label))}${line.slice(
              callPre.length
            )}`
          : line
      )
    )
    lines.push(...valueLine(`${callPre}  `, values[i]))
  }
  lines.push(...withheldLine(`${pre}  `, count - shown, count, 'call'))
  return lines
}

async function scheduleLines(
  args: readonly unknown[],
  called: Printable,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  if (args.length < 6)
    return [cannotRead(pre, 'SCHEDULE ARGUMENTS COULD NOT BE READ')]
  const [target, value, payload, predecessor] = args
  const lines = [timelockHeader(pre, called)]
  lines.push(...predecessorLines(`${pre}  `, predecessor))
  lines.push(
    ...(await effectLines(payload, { ...context, target }, `${pre}  `))
  )
  lines.push(...valueLine(`${pre}    `, value))
  return lines
}

const isZeroValue = (value: unknown): boolean => {
  if (typeof value === 'bigint') return value === 0n
  if (typeof value === 'number') return value === 0
  const text = String(value ?? '').trim()
  return text === '' || /^0x?0*$/u.test(text) || /^0+$/u.test(text)
}

async function diamondCutLines(
  args: readonly unknown[],
  called: Printable,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  const modifications = args[0]
  if (!Array.isArray(modifications))
    return [
      `${pre}${called}`,
      cannotRead(
        pre,
        '  DIAMONDCUT ARGUMENTS COULD NOT BE READ — the cut list is not an array'
      ),
    ]

  const target = await renderAddress(context.network, context.target)
  const selectorMap = await createSelectorMap()

  // One batched, disk-cached lookup for every selector neither diamond.json nor
  // the local registry knows, so rendering below stays synchronous per row.
  const unknown: string[] = []
  for (const modification of modifications) {
    const selectors = Array.isArray(modification) ? modification[2] : undefined
    if (!Array.isArray(selectors)) continue
    for (const selector of selectors) {
      const normalised = normalizeDiamondCutSelector(selector)
      if (!selectorMap?.get(normalised) && !getLocalSelectorInfo(normalised))
        unknown.push(normalised)
    }
  }
  const fourByte =
    unknown.length > 0
      ? await resolveSelectorsViaFourByte(unknown)
      : new Map<string, string>()

  const lines = addressLines(
    pre,
    concatPrintable(called, trustedMarkup(' on ')),
    target,
    NO_LINK
  )
  const cutPre = `${pre}  `
  for (const modification of modifications) {
    if (!Array.isArray(modification)) {
      lines.push(
        cannotRead(cutPre, 'a cut entry could not be read — it is not a triple')
      )
      continue
    }
    const [facetAddress, actionValue, selectors] = modification
    const action =
      typeof actionValue === 'bigint' ? Number(actionValue) : actionValue
    const verb =
      typeof action === 'number' ? DIAMOND_CUT_VERBS[action] : undefined
    const count = Array.isArray(selectors) ? selectors.length : 0
    const functions = Array.isArray(selectors)
      ? plural(count, 'function')
      : 'an unreadable selector list'

    if (verb === 'Remove') {
      lines.push(
        `${cutPre}${color(
          DIAMOND_CUT_VERB_COLOURS['Remove'] as string,
          trustedMarkup('Remove')
        )} ${color(BLUE, trustedMarkup(functions))}`
      )
    } else {
      const facet = await renderAddress(context.network, facetAddress)
      const name = facetContractName(
        context.network,
        facetAddress,
        selectors,
        action
      )
      const opening =
        verb === undefined
          ? // The action is proposer-controlled, so it is quoted into a sentence
            // this module owns rather than read out as the verb.
            concatPrintable(
              trustedMarkup('action '),
              quoted(actionValue, GREEN),
              trustedMarkup(` on ${functions} → `)
            )
          : concatPrintable(
              color(
                DIAMOND_CUT_VERB_COLOURS[verb] ?? BLUE,
                trustedMarkup(verb)
              ),
              color(BLUE, trustedMarkup(` ${functions}`)),
              trustedMarkup(' → ')
            )
      lines.push(
        ...addressLines(
          cutPre,
          concatPrintable(
            opening,
            name
              ? concatPrintable(color(BLUE, name), trustedMarkup(' @ '))
              : EMPTY
          ),
          facet
        )
      )
    }

    if (!Array.isArray(selectors)) continue
    const selectorPre = `${cutPre}  `
    const shown = selectors.slice(0, MAX_SELECTORS_SHOWN)
    for (const selector of shown) {
      const normalised = normalizeDiamondCutSelector(selector)
      const info =
        selectorMap?.get(normalised) ?? getLocalSelectorInfo(normalised)
      // The name, not the canonical signature: an argument list of nested
      // tuples runs past the view's width and is clipped into a notice, which
      // buries the two-word answer to what this selector is. 4byte supplies
      // only a signature, so that arm still renders one.
      const named = info?.name ?? fourByte.get(normalised)
      lines.push(
        `${selectorPre}${color(CYAN, asPrintable(normalised).text)}  ${
          named
            ? storedField(named, BLUE)
            : color(GREY, trustedMarkup('no name for this selector'))
        }`
      )
    }
    lines.push(
      ...withheldLine(
        selectorPre,
        selectors.length - shown.length,
        selectors.length,
        'selector'
      )
    )
  }

  const initAddress = args[1]
  const initCalldata = args[2]
  if (
    initAddress !== undefined &&
    !isZeroWord(initAddress) &&
    String(initAddress ?? '') !== '' &&
    !isEmptyCalldata(initCalldata)
  ) {
    const init = await renderAddress(context.network, initAddress)
    lines.push(
      ...addressLines(cutPre, trustedMarkup('then calls '), init, NO_LINK)
    )
    lines.push(
      ...(await effectLines(
        initCalldata,
        { ...context, target: initAddress },
        `${pre}  `
      ))
    )
  }

  return lines
}

const isEmptyCalldata = (value: unknown): boolean => {
  const text = String(value ?? '')
  return text === '' || text === '0x' || text.length < 10
}

/**
 * The repository's name for a facet address, or undefined.
 *
 * A `Remove` never reaches here: its facet address is the zero address, and its
 * selector list may be a partial subset, so matching an artifact by selectors
 * would name a contract the cut is not pointing at.
 */
function facetContractName(
  network: string,
  facetAddress: unknown,
  selectors: unknown,
  action: unknown
): Printable | undefined {
  let name = getContractNameFromNetworkDeployments(
    network,
    String(facetAddress ?? '')
  )
  if (
    name.toLowerCase() === 'unknown' &&
    action !== 2 &&
    Array.isArray(selectors)
  )
    name = getContractNameFromSelectorsInOut(selectors)
  if (!name || name.toLowerCase() === 'unknown') return undefined
  return asPrintable(name).text
}

async function whitelistLines(
  args: readonly unknown[],
  called: Printable,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  const [contracts, selectors, whitelisted] = args
  if (!Array.isArray(contracts) || !Array.isArray(selectors))
    return [
      `${pre}${called}`,
      cannotRead(
        pre,
        '  WHITELIST ARGUMENTS COULD NOT BE READ — contracts and selectors are not both arrays'
      ),
    ]

  const lines: string[] = []
  if (contracts.length !== selectors.length)
    lines.push(
      cannotRead(
        pre,
        `the two arrays disagree on length — contracts ${contracts.length}, selectors ${selectors.length}`
      )
    )

  // The verb is keyed by a decoded `bool`, so both arms are this module's own
  // words; a value that is neither is quoted rather than read out.
  const verb =
    whitelisted === true
      ? trustedMarkup('Whitelist ')
      : whitelisted === false
      ? trustedMarkup('Un-whitelist ')
      : concatPrintable(
          trustedMarkup('set whitelisted='),
          quoted(whitelisted, GREEN),
          trustedMarkup(' on ')
        )
  const count = Math.max(contracts.length, selectors.length)
  lines.unshift(
    `${pre}${called}${color(GREY, trustedMarkup(' · '))}${verb}${color(
      BLUE,
      trustedMarkup(plural(count, 'contract/selector pair'))
    )}`
  )

  const shown = Math.min(count, MAX_WHITELIST_ROWS_SHOWN)
  for (let i = 0; i < shown; i++) {
    const contract = await renderAddress(context.network, contracts[i])
    lines.push(...addressLines(`${pre}  `, EMPTY, contract))
    lines.push(
      `${pre}    ${color(CYAN, asPrintable(String(selectors[i] ?? '')).text)}`
    )
  }
  lines.push(...withheldLine(`${pre}  `, count - shown, count, 'pair'))
  return lines
}

async function registerPeripheryLines(
  args: readonly unknown[],
  called: Printable,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  if (args.length < 2)
    return [
      `${pre}${called}`,
      cannotRead(
        pre,
        '  REGISTERPERIPHERYCONTRACT ARGUMENTS COULD NOT BE READ'
      ),
    ]
  const address = await renderAddress(context.network, args[1])
  return addressLines(
    pre,
    concatPrintable(
      called,
      color(GREY, trustedMarkup(' · register periphery ')),
      quoted(args[0], GREEN),
      trustedMarkup(' → ')
    ),
    address
  )
}

/** The verbs for a role change, keyed by the function this repository decoded. */
const ROLE_VERBS: Readonly<Record<string, string>> = {
  grantRole: 'grant',
  revokeRole: 'revoke',
  renounceRole: 'renounce',
}

async function roleChangeLines(
  functionName: string,
  args: readonly unknown[],
  called: Printable,
  context: ICalldataEffectContext,
  pre: string
): Promise<string[]> {
  if (args.length < 2)
    return [
      `${pre}${called}`,
      cannotRead(pre, '  ROLE CHANGE ARGUMENTS COULD NOT BE READ'),
    ]
  const verb = ROLE_VERBS[bareName(functionName)] ?? 'change'
  const roleHash = String(args[0] ?? '')
  const roleName = getRoleName(roleHash)
  // The hash when this repository does not know the role: naming it would be
  // this section vouching for a value it could not resolve.
  const role = roleName
    ? color(YELLOW, asPrintable(roleName).text)
    : storedField(roleHash, GREEN)
  const account = await renderAddress(context.network, args[1])
  const lines = addressLines(
    pre,
    concatPrintable(trustedMarkup(`${verb} role `), role, trustedMarkup(' → ')),
    account
  )
  lines.push(
    ...addressLines(
      `${pre}  `,
      trustedMarkup('on '),
      await renderAddress(context.network, context.target)
    )
  )
  return lines
}

function genericCallLines(
  functionName: string,
  args: readonly unknown[],
  data: Hex,
  context: ICalldataEffectContext,
  pre: string
): string[] {
  const lines = [`${pre}${calledFunction(functionName, data)}`]
  if (args.length === 0) {
    lines.push(`${pre}  ${color(GREY, trustedMarkup('no arguments'))}`)
    return lines
  }

  const abiItem = getDiamondAbiItemForSelector(data.slice(0, 10))
  const inputs =
    abiItem?.type === 'function' &&
    'inputs' in abiItem &&
    Array.isArray(abiItem.inputs)
      ? abiItem.inputs
      : []
  const shown = args.slice(0, MAX_ARGS_SHOWN)
  shown.forEach((arg, index) => {
    const input = inputs[index]
    const label =
      input && typeof input === 'object' && 'name' in input
        ? String((input as { name: string }).name)
        : `[${index}]`
    // `colorAroundNotices`, not a plain colour: `formatDecodedArg` has already
    // sanitised the value and may have put a notice inside the string, and a
    // reader cannot tell a warning from the value it is about when one colour
    // runs across both.
    lines.push(
      `${pre}  ${color(GREY, asPrintable(label).text)}: ${colorAroundNotices(
        '34',
        formatDecodedArg(arg, context.network)
      )}`
    )
  })
  lines.push(
    ...withheldLine(
      `${pre}  `,
      args.length - shown.length,
      args.length,
      'argument'
    )
  )
  return lines
}
