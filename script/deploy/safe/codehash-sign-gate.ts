/**
 * The sign-time codehash gate as the Safe confirmation flow consumes it.
 *
 * Three things are settled here and must stay settled.
 *
 * **One decode of one value.** The cut is recovered from the calldata of the
 * transaction that gets hashed and signed, through the same `ABI_DIAMOND_CUT`
 * the display path uses. Two pure decodes of one immutable value cannot
 * disagree; two reads of a mutable source can, which is how the bytes vouched
 * for and the bytes signed come apart. The display decodes the same bytes,
 * because the normalised transaction copies them across verbatim — but the
 * signed struct is the anchor, so a later normalisation cannot silently make
 * the checked bytes and the approved bytes two different things.
 *
 * **The verdict is computed before the prompt and refused inside the signer.**
 * The action list stays whatever it was, because removing an option hides the
 * reason a proposal is refused; the refusal happens in the one function every
 * sign path funnels through, so a fourth sign path cannot miss it.
 *
 * **Nothing fails open.** An evaluation that could not be performed blocks, and
 * `unevaluatedCodehashSignGate` is the state a caller starts each proposal in
 * for exactly that reason.
 */

import type { Hex } from 'viem'

import {
  verifyCutTargets,
  type ITargetVerdict,
  type IVerifyCutDeps,
} from '../codehash/verify-cut-targets'

import { collectDiamondCutTargets } from './safe-decode-utils'
import { isSignedStruct, type ISignedSafeTransaction } from './safe-utils'

export interface ICodehashSignGate {
  /**
   * The calldata this verdict is about.
   *
   * A verdict is only ever a statement about specific bytes. Without this, a
   * gate evaluated for one pending proposal authorised the signature of any
   * other — every row on the network carries a struct the identity check
   * accepts, so grading proposal 0 and signing proposal N passed.
   */
  gradedData?: Hex
  /** True when a signature must be refused. Render the verdicts, never this. */
  blocksSigning: boolean
  /** True when the proposal carried `diamondCut` calldata that was judged. */
  evaluated: boolean
  /** Reasons the proposal is refused outright, independent of any codehash. */
  refusals: string[]
  /** One entry per gated address, in first-seen order across every cut. */
  targets: ITargetVerdict[]
  /** The whole outcome as a signer should read it. */
  summary: string
  /**
   * True when the gate reached no verdict about anything — no cut was found and
   * nothing was refused. It is NOT a pass: an envelope this decoder cannot open
   * lands here, and rendering it green claimed the bytes had been read.
   */
  madeNoClaim?: boolean
}

/**
 * The state every proposal starts in, and the one a failed evaluation stays in.
 *
 * `blocksSigning` is false and `evaluated` is false together: a proposal that
 * installs no facet code is the common case and must remain signable. A caller
 * that needs "we never got as far as looking" to block spreads this and sets
 * `blocksSigning`, which is what the confirmation flow does per proposal.
 */
export const unevaluatedCodehashSignGate = (): ICodehashSignGate => ({
  blocksSigning: false,
  evaluated: false,
  refusals: [],
  targets: [],
  summary: '',
})

/**
 * The state a caller starts each proposal in.
 *
 * Blocking and unevaluated: it is only ever read when the evaluation did not
 * run to completion, and a signature taken in that state would be taken on the
 * previous proposal's answer.
 */
export const blockingUnevaluatedGate = (): ICodehashSignGate => ({
  ...unevaluatedCodehashSignGate(),
  blocksSigning: true,
  summary:
    'the codehash gate did not run for this proposal, so what this cut installs was never checked',
})

/**
 * The only shape this gate accepts a proposal in.
 *
 * The field is typed `ISignedSafeTransaction`, but the type is only the hint —
 * `isSignedStruct` is the guarantee. A type-level brand cannot express object
 * identity, and identity is the question: `{ ...tx, safeTransaction: { ...tx.
 * safeTransaction, data: tx.safeTx.data } }` keeps the brand and swaps the
 * bytes, cast-free, and compiles. So `gateInputFor` checks the object itself.
 */
export interface ISignableProposal {
  safeTransaction: ISignedSafeTransaction
}

declare const gateInputBrand: unique symbol

/**
 * What `evaluateCodehashSignGate` accepts, constructible only by `gateInputFor`.
 *
 * The brand is an unexported `unique symbol`, so no other module can write the
 * property and no literal satisfies the type. That is what makes the selector
 * the only door: an earlier version guarded the selector and left the judging
 * function taking a plain `{ data, network }`, so a second call site skipped it
 * entirely and judged the stored document with nothing to stop it.
 */
export interface ICodehashGateInput {
  readonly [gateInputBrand]: true
  /**
   * The struct itself, by reference — never a copy of its calldata.
   *
   * Returning `{ data, network }` was how attempt 5 was defeated: the identity
   * check ran, the struct was then discarded, and the detached bytes were both
   * mutable (`input.data = row.safeTx.data.data`) and spreadable
   * (`{ ...gateInputFor(tx, key), data: row.safeTx.data.data }`) — the same
   * spread that beat attempt 4, one level further out. Holding the reference
   * means swapping the bytes requires mutating the struct Safe will sign, which
   * is the correct semantics rather than a bypass.
   */
  readonly struct: ISignedSafeTransaction
  readonly network: string
}

export const gateInputFor = (
  proposal: ISignableProposal,
  networkKey: string
): ICodehashGateInput => {
  // The identity check, not the type check. Refuses rather than judges: a caller
  // holding something other than the struct Safe will hash is not a proposal to
  // grade, it is a mistake to stop.
  if (!isSignedStruct(proposal.safeTransaction))
    throw new Error(
      'Refusing to judge this proposal: the struct handed to the codehash gate is not the one Safe will hash and sign. Only the value `initializeSafeTransaction` returned is, and a copy or a spread of it is a different object carrying possibly different calldata. Nothing has been signed.'
    )

  return {
    struct: proposal.safeTransaction,
    network: networkKey,
  } as unknown as ICodehashGateInput
}

/**
 * Judges the cut a proposal would perform, before it is signed.
 *
 * Pass `data` by value off the struct that will be signed, not a re-read of
 * whatever produced it: the caller's job is to hand this function the bytes the
 * signature will cover.
 *
 * @param input.struct - the struct whose signature this would authorise
 * @param input.network - a `config/networks.json` key in any casing; it is
 *   lowercased here, because every lookup it reaches throws on other spellings
 * @param deps - a thunk, not the dependencies: building them reads
 *   `foundry.toml` and creates a checkout root, and the caller turns a throw
 *   into a refusal, so they must not exist for a proposal carrying no cut.
 *   Thunk-only rather than either/or, so the eager form cannot compile.
 * @returns The gate a caller displays and then refuses on
 */
export const evaluateCodehashSignGate = async (
  input: ICodehashGateInput,
  deps: () => IVerifyCutDeps
): Promise<ICodehashSignGate> => {
  // Re-checked here rather than trusted from `gateInputFor`: this is the
  // function that judges, and a caller that reached it another way has not
  // passed anything.
  if (!isSignedStruct(input.struct))
    throw new Error(
      'Refusing to judge this proposal: the struct handed to the codehash gate is not one Safe will hash and sign. Nothing has been signed.'
    )

  // Read at judge time, off the struct, so nothing between here and the
  // identity check can have substituted the bytes.
  const data = input.struct.data.data as Hex | undefined

  if (!data || data === '0x')
    return { ...unevaluatedCodehashSignGate(), gradedData: data }

  const collected = collectDiamondCutTargets(data)

  // Normalised here rather than trusted from the caller. `config/networks.json`
  // is keyed lowercase and every lookup below throws on any other spelling, so
  // a caller passing what an operator typed would be refused instead of judged.
  // Lowercasing cannot refuse honest work; rejecting the spelling could.
  const network = input.network.toLowerCase()

  // Resolved only once a cut is actually present. Building these reads
  // `foundry.toml` and creates a checkout root, either of which can throw, and
  // the caller's catch turns a throw into a refusal — so an eagerly-built
  // dependency refuses proposals this gate makes no claim about at all.
  // Memoised: `resolveDeps` is called per cut, and a caller whose thunk is not
  // itself memoised would otherwise get one checkout root and one connection per
  // cut in a batch, against a single `close()`.
  let resolved: IVerifyCutDeps | undefined
  const resolveDeps = (): IVerifyCutDeps => (resolved ??= deps())

  const refusals: string[] = [...collected.refusals]
  const targets: ITargetVerdict[] = []
  const summaries: string[] = []
  // Whether a cut blocks is `verifyCutTargets`' decision, carried up rather than
  // re-derived.
  let anyCutBlocks = false

  // Every cut is judged even when a frame was already refused: a batch pairing
  // one readable cut with one unreadable frame must show both, or the readable
  // half renders green beside a hole.
  for (const call of collected.calls)
    try {
      const report = await verifyCutTargets(
        { cuts: call.cuts, init: call.init, network },
        resolveDeps()
      )
      refusals.push(...report.refusals)
      targets.push(...report.targets)
      summaries.push(report.summary)
      anyCutBlocks = anyCutBlocks || report.blocksSigning
    } catch (error) {
      // Reached when a dependency throws outside the per-address try/catch the
      // gate does its own catching in — a network whose toolchain scope cannot
      // be resolved is the real case. It blocks: "we could not check" is the
      // one thing that must never render as a pass.
      refusals.push(
        `The codehash gate could not be evaluated for this cut: ${message(
          error
        )}`
      )
      summaries.push(
        `This cut will not be signed: the codehash gate could not be evaluated — ${message(
          error
        )}`
      )
    }

  if (collected.calls.length === 0 && refusals.length === 0)
    return {
      gradedData: data,
      blocksSigning: false,
      evaluated: true,
      refusals: [],
      targets: [],
      madeNoClaim: true,
      summary:
        collected.unopened.length > 0
          ? `No diamondCut was decoded, but this decoder could not open ${collected.unopened.join(
              ', '
            )} — so it cannot state whether a cut is present. Nothing here has been verified.`
          : 'No diamondCut was decoded from this calldata, so there is no facet bytecode to vouch for. This gate makes no claim about the rest of the proposal.',
    }

  return {
    gradedData: data,
    // The target scan is not a second derivation of the line above; it is this
    // layer's own invariant, that nothing rendered as non-MATCH is ever
    // signable. Keeping both means a regression in either place still blocks,
    // and the module's promise that nothing fails open does not rest on one
    // expression. Unreachable today, so deliberately untested — there is no
    // input that makes a report block while all its targets match.
    blocksSigning:
      refusals.length > 0 ||
      anyCutBlocks ||
      targets.some((t) => t.verdict !== 'MATCH'),
    evaluated: true,
    refusals,
    targets,
    summary: summaries.length > 0 ? summaries.join(' ') : refusals.join(' '),
  }
}

/** Glyph, colour and word are all different per bucket, on purpose. */
const BUCKETS = {
  MATCH: { glyph: '✓', colour: '32' },
  MISMATCH: { glyph: '✗', colour: '31' },
  UNVERIFIABLE: { glyph: '⚠', colour: '33' },
} as const

/**
 * Renders the gate beside the transaction details.
 *
 * MATCH, MISMATCH and UNVERIFIABLE get a different word, a different glyph and
 * a different colour. A grey that looks like a red teaches a signer to click
 * through both, so no two buckets may be distinguishable by only one of the
 * three.
 *
 * @param gate - the evaluated gate
 * @returns Lines to print, or none when there was no cut to judge
 */
export const renderCodehashSignGate = (gate: ICodehashSignGate): string[] => {
  // Silence is reserved for "there was nothing to judge". A gate that blocks
  // must say so even when it never got as far as a per-address verdict, or the
  // refusal a signer then hits has no explanation on screen.
  if (!gate.evaluated && !gate.blocksSigning) return []

  const lines = ['    Codehash gate:']

  // A different glyph from MISMATCH's, or the rule this file states — that no
  // two buckets differ by only one of word, glyph and colour — is broken by its
  // own renderer. Both are blocking red, so this is legibility, not safety.
  if (!gate.evaluated)
    lines.push(`        \u001b[31m⛔ REFUSED\u001b[0m ${gate.summary}`)

  for (const refusal of gate.refusals)
    lines.push(`        \u001b[31m⛔ REFUSED\u001b[0m ${refusal}`)

  for (const target of gate.targets) {
    const bucket = BUCKETS[target.verdict]
    lines.push(
      `        \u001b[${bucket.colour}m${bucket.glyph} ${target.verdict}\u001b[0m ${target.address}`
    )
    lines.push(`            ${target.reason}`)
    if (target.excludedByteCount > 0)
      lines.push(
        `            \u001b[33m${target.excludedByteCount} bytes were excluded as immutables and are not covered by this verdict — their values still need checking.\u001b[0m`
      )
  }

  // Deliberately neither green nor MATCH. "We found no cut" and "we checked the
  // cut and it is clean" are different facts, and a signer skimming glyphs
  // cannot tell them apart if both are a green tick — which is how an envelope
  // this decoder could not open was rendered as an affirmative pass.
  if (gate.evaluated && gate.targets.length === 0 && gate.refusals.length === 0)
    lines.push(`        \u001b[36m· NO CLAIM\u001b[0m ${gate.summary}`)

  return lines
}

/**
 * Refuses a signature the gate does not permit.
 *
 * Call this as the first statement of the function every sign path goes
 * through, before the signing client is touched. It throws rather than
 * returning a flag so a caller cannot forget to read the answer.
 *
 * @param gate - the gate evaluated for the proposal about to be signed
 * @throws When the gate blocks signing
 */
export const assertCodehashSignGateAllowsSigning = (
  gate: ICodehashSignGate,
  payload?: Hex
): void => {
  // The verdict has to be about the bytes being signed. Checked before the
  // blocksSigning short-circuit, so a passing verdict on other calldata is a
  // refusal rather than a pass.
  if (payload !== undefined && gate.gradedData !== payload)
    throw new Error(
      `Codehash gate: this transaction will not be signed. The gate's verdict is about different calldata than the transaction now being signed — it graded ${
        gate.gradedData ?? '(nothing)'
      } and this carries ${payload}. A verdict is only ever a statement about specific bytes, so this one says nothing about these.`
    )

  if (!gate.blocksSigning) return

  const detail = gate.targets
    .filter((target) => target.verdict !== 'MATCH')
    .map((target) => `${target.address} is ${target.verdict}: ${target.reason}`)

  throw new Error(
    [
      'Codehash gate: this transaction will not be signed.',
      ...gate.refusals,
      ...detail,
      gate.summary,
    ]
      .filter((part) => part.length > 0)
      .join(' ')
  )
}

/**
 * Wraps a signing call so the gate is checked before it can be reached.
 *
 * The gate is read through a callback rather than captured, because the caller
 * evaluates a fresh one per proposal and a captured value would be the previous
 * proposal's answer.
 *
 * @param deps.gate - reads the gate for the proposal being signed
 * @param deps.sign - performs the signature
 * @returns A signer that refuses before signing whenever the gate blocks
 */
export const createGatedSigner = <Args extends unknown[], T>(deps: {
  gate: () => ICodehashSignGate
  sign: (...args: Args) => Promise<T>
  /**
   * The calldata this signature will cover, from the same arguments `sign`
   * receives. Required, not optional: the verdict is compared against it, and a
   * signer that could omit it would be a signer with the old bug.
   */
  payloadOf: (...args: Args) => Hex | undefined
}): ((...args: Args) => Promise<T>) => {
  return async (...args: Args): Promise<T> => {
    assertCodehashSignGateAllowsSigning(deps.gate(), deps.payloadOf(...args))
    return deps.sign(...args)
  }
}

/**
 * @param error - whatever was thrown
 */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
