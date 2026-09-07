/**
 * The sign-time codehash gate: classify a decoded cut, then judge every address
 * it would install.
 *
 * Two invariants shape this. **Three buckets stay three** — MISMATCH and
 * UNVERIFIABLE both stop a signature but are different facts, and collapsing
 * them is what teaches a signer to click through grey. And **nothing fails
 * open**: an address whose code or attestations cannot be read is reported
 * UNVERIFIABLE, never skipped, because "we could not check" and "we checked and
 * it is fine" are the two things a gate exists to keep apart.
 */

import {
  compareToAttestedSet,
  type CodehashVerdict,
  type IAttestedBuild,
  type ILineageScope,
  type IObservedCode,
} from './attested-set'
import { classifyCut, type IFacetCutEntry } from './cut-classification'

export interface ITargetVerdict {
  /** Checksummed. */
  address: string
  verdict: CodehashVerdict
  /** One line a signer can act on. */
  reason: string
  /** Attested lineages whose bytes reach this code, if any. */
  matchedLineages: string[]
  /**
   * Bytes excluded as immutables. Nonzero means a MATCH is incomplete until
   * layer 2 has checked their values, so it must not render as plain green.
   */
  excludedByteCount: number
}

export interface IGateReport {
  /** True when anything is not a confirmed MATCH, or the cut is malformed. */
  blocksSigning: boolean
  /** Malformed-cut reasons, which are not codehash questions. */
  refusals: string[]
  /** One entry per gated address, in first-seen order. Empty when refused. */
  targets: ITargetVerdict[]
  /** The whole outcome as a signer should read it. */
  summary: string
}

export interface IVerifyCutDeps {
  /**
   * Which toolchains this network's code may legitimately have been built with.
   * Derived from repo config, never from the deployed bytecode.
   */
  scope: (network: string) => ILineageScope
  /** Reads and normalises what is actually deployed at an address. */
  observe: (address: string, network: string) => Promise<IObservedCode>
  /** Every attested build of `main` for whatever is meant to be at an address. */
  attestationsFor: (
    address: string,
    network: string
  ) => Promise<IAttestedBuild[]>
}

/**
 * Judges a decoded `diamondCut` before it is signed.
 *
 * Takes the decoded cut rather than calldata: the gate must judge the structure
 * the signer is shown, and a second decode is how the bytes vouched for and the
 * bytes signed come apart.
 * @param input.cuts - the decoded `FacetCut[]`
 * @param input.init - the cut's `_init` target
 * @param input.network - which network the proposal is for
 * @param deps - scope, chain read and attestation lookup
 * @returns Per-address verdicts and whether the signature may proceed
 */
export const verifyCutTargets = async (
  input: {
    cuts: readonly IFacetCutEntry[]
    init: string
    network: string
  },
  deps: IVerifyCutDeps
): Promise<IGateReport> => {
  const classified = classifyCut({ cuts: input.cuts, init: input.init })
  if (classified.refusals.length > 0)
    return {
      blocksSigning: true,
      refusals: classified.refusals,
      targets: [],
      summary: `This cut will not be signed: ${classified.refusals.join(' ')}`,
    }

  const scope = deps.scope(input.network)
  const targets: ITargetVerdict[] = []

  // Every target is judged even after one has failed: a signer shown one
  // problem at a time cannot see that two addresses are wrong.
  for (const address of classified.gated)
    targets.push(await judge(address, input.network, scope, deps))

  return {
    blocksSigning: targets.some((t) => t.verdict !== 'MATCH'),
    refusals: [],
    targets,
    summary: summarise(targets, classified.gated.length === 0),
  }
}

/**
 * @param address - the target to judge
 * @param network - the proposal's network
 * @param scope - how complete the attested set is for this network
 * @param deps - chain read and attestation lookup
 */
const judge = async (
  address: string,
  network: string,
  scope: ILineageScope,
  deps: IVerifyCutDeps
): Promise<ITargetVerdict> => {
  let attested: IAttestedBuild[]
  try {
    attested = await deps.attestationsFor(address, network)
  } catch (error) {
    // Distinguished from "no attested build": that is a missing rebuild, this is
    // an infrastructure failure that could be hiding either answer.
    return unreadable(
      address,
      `its attested builds could not be read, so whether it matches main is unknown: ${message(
        error
      )}`
    )
  }

  let code: IObservedCode
  try {
    code = await deps.observe(address, network)
  } catch (error) {
    return unreadable(
      address,
      `its deployed code could not be read, so there is nothing to compare: ${message(
        error
      )}`
    )
  }

  const comparison = compareToAttestedSet(code, attested, scope)

  // `attested-set` states this as a rendering instruction — a MATCH says nothing
  // about masked bytes, so a caller that has not run layer 2 "must not render an
  // unqualified green". Rendering is not a gate, and two fail-opens rode on the
  // difference: masking refs come from compiling the record's commit, D3 has the
  // verifier assert commit presence rather than ancestry, and `findFault` bounds
  // each range without bounding the masked fraction — so refs from a referenced
  // commit can exclude the whole body and a comparison that compared nothing
  // reported MATCH.
  //
  // No threshold is invented, because any excluded byte is an uncompared byte.
  // This grades grey rather than red: nothing was found wrong, it was not looked
  // at. Layer 2 supplies the missing check and lifts this.
  if (comparison.verdict === 'MATCH' && comparison.excludedByteCount > 0)
    return {
      address,
      verdict: 'UNVERIFIABLE',
      reason: `${address}: the code outside its immutables matches an attested build, but ${comparison.excludedByteCount} bytes holding immutables were not compared and no immutable check has run, so this is not yet a match of the deployed code.`,
      matchedLineages: comparison.matchedLineages,
      excludedByteCount: comparison.excludedByteCount,
    }

  return {
    address,
    verdict: comparison.verdict,
    reason: comparison.reason,
    matchedLineages: comparison.matchedLineages,
    excludedByteCount: comparison.excludedByteCount,
  }
}

/**
 * @param address - the target that could not be judged
 * @param why - what could not be read
 */
const unreadable = (address: string, why: string): ITargetVerdict => ({
  address,
  verdict: 'UNVERIFIABLE',
  reason: `${address}: ${why}`,
  matchedLineages: [],
  excludedByteCount: 0,
})

/**
 * @param error - whatever was thrown
 */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * @param targets - the per-address verdicts
 * @param installsNothing - true when the cut gated no address at all
 */
const summarise = (
  targets: ITargetVerdict[],
  installsNothing: boolean
): string => {
  if (installsNothing)
    return 'This cut installs no facet code, so there is no bytecode to vouch for.'

  const bad = targets.filter((t) => t.verdict !== 'MATCH')
  if (bad.length === 0) {
    const masked = targets.reduce((n, t) => n + t.excludedByteCount, 0)
    const caveat =
      masked > 0
        ? ` ${masked} bytes were excluded as immutables and are not covered by this result — their values still need checking.`
        : ''
    return `Every address this cut installs matches an attested build of main.${caveat}`
  }

  // The verdict word is carried per address rather than summed, so a MISMATCH
  // and an UNVERIFIABLE in one cut do not average into a single colour.
  return `This cut will not be signed. ${bad
    .map((t) => `${t.address} is ${t.verdict}: ${t.reason}`)
    .join(' ')}`
}
