/**
 * The sign-time codehash gate as the Safe confirmation flow consumes it.
 *
 * Three things are settled here and must stay settled.
 *
 * **One decode of one value.** The cut is recovered from the same in-memory
 * calldata the display path was handed, through the same `ABI_DIAMOND_CUT`. Two
 * pure decodes of one immutable value cannot disagree; two reads of a mutable
 * source can, which is how the bytes vouched for and the bytes signed come
 * apart.
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

export interface ICodehashSignGate {
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
 * Judges the cut a proposal would perform, before it is signed.
 *
 * Pass `data` by value from the transaction being displayed — the same variable,
 * not a re-read of whatever produced it.
 *
 * @param input.data - the proposal's calldata as the signer was shown it
 * @param input.network - which network the proposal is for
 * @param deps - scope, chain read and attestation lookup
 * @returns The gate a caller displays and then refuses on
 */
export const evaluateCodehashSignGate = async (
  input: { data: Hex | undefined; network: string },
  deps: IVerifyCutDeps
): Promise<ICodehashSignGate> => {
  if (!input.data || input.data === '0x') return unevaluatedCodehashSignGate()

  const collected = collectDiamondCutTargets(input.data)

  const refusals: string[] = [...collected.refusals]
  const targets: ITargetVerdict[] = []
  const summaries: string[] = []

  // Every cut is judged even when a frame was already refused: a batch pairing
  // one readable cut with one unreadable frame must show both, or the readable
  // half renders green beside a hole.
  for (const call of collected.calls)
    try {
      const report = await verifyCutTargets(
        { cuts: call.cuts, init: call.init, network: input.network },
        deps
      )
      refusals.push(...report.refusals)
      targets.push(...report.targets)
      summaries.push(report.summary)
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
      blocksSigning: false,
      evaluated: true,
      refusals: [],
      targets: [],
      summary:
        'This proposal performs no diamondCut, so there is no facet bytecode to vouch for.',
    }

  return {
    blocksSigning:
      refusals.length > 0 || targets.some((t) => t.verdict !== 'MATCH'),
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

  if (!gate.evaluated)
    lines.push(`        \u001b[31m✗ REFUSED\u001b[0m ${gate.summary}`)

  for (const refusal of gate.refusals)
    lines.push(`        \u001b[31m✗ REFUSED\u001b[0m ${refusal}`)

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

  if (gate.evaluated && gate.targets.length === 0 && gate.refusals.length === 0)
    lines.push(`        \u001b[32m✓ MATCH\u001b[0m ${gate.summary}`)

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
  gate: ICodehashSignGate
): void => {
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
}): ((...args: Args) => Promise<T>) => {
  return async (...args: Args): Promise<T> => {
    assertCodehashSignGateAllowsSigning(deps.gate())
    return deps.sign(...args)
  }
}

/**
 * @param error - whatever was thrown
 */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
