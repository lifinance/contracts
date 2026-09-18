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
  type ICodehashComparison,
  type ILineageScope,
  type IObservedCode,
} from './attested-set'
import { classifyCut, type IFacetCutEntry } from './cut-classification'
import type { ImmutablePricing } from './immutable-expectations'
import {
  gradeAssumedImmutables,
  gradeInlinedImmutables,
  immutablesUnreadable,
  noImmutables,
  type IImmutableVerdict,
  type IOffCodeImmutables,
} from './immutable-verdict'

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
   * Zero does not mean the converse: a chain holding immutables outside the
   * runtime code excludes nothing and has checked nothing.
   */
  excludedByteCount: number
  /**
   * Bytes layer 2 compared against a declared expectation and found to hold it.
   *
   * Carried separately from the verdict because zero is three different facts —
   * a contract with no immutables, one whose immutables were checked, and one
   * holding them where this layer cannot read them — and a signer reading a
   * clean MATCH is owed the difference. Only the first two reach a MATCH.
   */
  pricedByteCount: number
  /**
   * Gate L's answer for this address: what its immutables were found to hold.
   *
   * Beside the verdict rather than folded into it. The bytecode claim is
   * answerable on every chain and the value claim is not, so a chain that
   * cannot answer the second must not thereby lose the first.
   */
  immutables: IImmutableVerdict
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

/**
 * What an attestation lookup answered, set and reason together.
 *
 * An empty set is two different facts — nothing is recorded about the address,
 * or a record names a contract but no commit to rebuild it from — and a signer
 * reading "no attested build is available" cannot tell which, though the two
 * have different remedies. The reason travels with the set rather than through
 * a second call, because a second read of a mutable source is how the set
 * judged and the sentence explaining it come apart.
 */
export interface IAttestationLookup {
  builds: IAttestedBuild[]
  /**
   * Why `builds` is empty, as a clause the row prints after the verdict word.
   * The address is not part of it: the row states that separately, and a
   * sentence that repeats it spends the line the signer reads twice.
   */
  absence?: string
}

export interface IVerifyCutDeps {
  /**
   * Which toolchains this network's code may legitimately have been built with.
   * Derived from repo config, never from the deployed bytecode.
   */
  scope: (network: string) => ILineageScope
  /** Reads and normalises what is actually deployed at an address. */
  observe: (address: string, network: string) => Promise<IObservedCode>
  /** Every attested build for whatever is meant to be at an address. */
  attestationsFor: (
    address: string,
    network: string
  ) => Promise<IAttestationLookup>
  /**
   * Layer 2: what the bytes this comparison had to mask actually hold.
   *
   * Consulted only for an address that already matched an attested build, so it
   * can complete a verdict and can never create one. A refusal leaves layer 1's
   * masked verdict exactly as it was.
   */
  price: (
    address: string,
    network: string,
    runtimeCode: string
  ) => Promise<ImmutablePricing>
  /**
   * Gate L on a chain that keeps immutables out of the runtime code: the values
   * the simulator holds, graded against config, and the slot each was read
   * from.
   *
   * Only reached for an address that already matched an attested build, for the
   * same reason `price` is: a value read out of code nobody vouched for says
   * nothing about the deployment this repo describes.
   */
  readOffCodeImmutables: (
    address: string,
    network: string
  ) => Promise<IOffCodeImmutables>
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
 * @param input.registrations - addresses `registerPeripheryContract` installs
 * @param deps - scope, chain read and attestation lookup
 * @returns Per-address verdicts and whether the signature may proceed
 */
export const verifyCutTargets = async (
  input: {
    cuts: readonly IFacetCutEntry[]
    init: string
    network: string
    registrations?: readonly string[]
  },
  deps: IVerifyCutDeps
): Promise<IGateReport> => {
  const classified = classifyCut({
    cuts: input.cuts,
    init: input.init,
    registrations: input.registrations,
  })
  if (classified.refusals.length > 0)
    return {
      blocksSigning: true,
      refusals: classified.refusals,
      targets: [],
      summary: `This call will not be signed: ${classified.refusals.join(' ')}`,
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
  let attested: IAttestationLookup
  try {
    attested = await deps.attestationsFor(address, network)
  } catch (error) {
    // Distinguished from "no attested build": that is a missing rebuild, this is
    // an infrastructure failure that could be hiding either answer.
    return unreadable(
      address,
      `its attested builds could not be read, so whether it matches one is unknown: ${message(
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

  const comparison = compareToAttestedSet(
    code,
    attested.builds,
    scope,
    attested.absence
  )

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
  //
  // Both branches below answer that instruction. The masked count decides it
  // only where immutables are inlined; a chain holding them elsewhere reaches a
  // MATCH with nothing masked and nothing checked, so it is asked first.
  if (comparison.verdict === 'MATCH' && scope.holdsImmutablesOffCode)
    return offCode(address, network, comparison, deps)

  if (comparison.verdict === 'MATCH' && comparison.excludedByteCount > 0)
    return complete(address, network, comparison, deps, code.runtimeCode)

  if (comparison.verdict === 'MATCH')
    return {
      address,
      verdict: comparison.verdict,
      reason: comparison.reason,
      matchedLineages: comparison.matchedLineages,
      excludedByteCount: comparison.excludedByteCount,
      pricedByteCount: 0,
      // Nothing was masked on a chain that inlines them, so there was nothing
      // to mask: the build carries no immutables.
      immutables: noImmutables(address),
    }

  return {
    address,
    verdict: comparison.verdict,
    reason: comparison.reason,
    matchedLineages: comparison.matchedLineages,
    excludedByteCount: comparison.excludedByteCount,
    pricedByteCount: 0,
    immutables: await immutablesBesideABlockedVerdict(
      address,
      network,
      comparison.verdict,
      scope,
      deps
    ),
  }
}

/**
 * What gate L can still say once layer 1 has blocked.
 *
 * Whether a contract declares immutables is a fact about the contract, not
 * about whether the deployed code matched, so a layer-1 block must not take the
 * value question down with it: a contract that declares none has no values to
 * establish whatever layer 1 concluded.
 *
 * Only whether it declares any is taken from the reader. Any pricing computed
 * alongside is discarded — those values were read off a deployment layer 1 has
 * just refused to vouch for, so reporting them as checked would answer gate L
 * about a contract that may not be ours.
 *
 * Inlined lineages keep the unestablished answer. There the count comes from the
 * masking refs, which are absent — indistinguishable from zero — whenever the
 * record or its commit could not be read, so a zero is not evidence that the
 * contract declares none.
 *
 * @param address - the target layer 1 blocked
 * @param network - the proposal's network
 * @param verdict - layer 1's verdict, for the sentence a signer reads
 * @param scope - decides whether the declaration read can be trusted here
 * @param deps - carries the declaration read
 */
const immutablesBesideABlockedVerdict = async (
  address: string,
  network: string,
  verdict: CodehashVerdict,
  scope: ILineageScope,
  deps: IVerifyCutDeps
): Promise<IImmutableVerdict> => {
  const unestablished = immutablesUnreadable(
    address,
    `its code is ${verdict} against the attested set, so there is no deployment of ours whose values could be compared`
  )
  if (!scope.holdsImmutablesOffCode) return unestablished

  try {
    const read = await deps.readOffCodeImmutables(address, network)
    return read.declared === 'none' ? noImmutables(address) : unestablished
  } catch {
    return unestablished
  }
}

/**
 * Completes a MATCH on a chain that keeps its immutables out of the code.
 *
 * The comparison masked nothing and was right not to: on EraVM the excluded
 * bytes of an EVM build are real codegen, and the values live in
 * `ImmutableSimulator` instead. So the bytecode claim stands as layer 1 made it
 * — this is our build — and the value claim is gate L's, answered here and
 * carried beside the verdict rather than inside it.
 *
 * @param address - the target being judged
 * @param network - the proposal's network
 * @param comparison - layer 1's verdict, already known to be a MATCH
 * @param deps - carries the simulator read
 */
const offCode = async (
  address: string,
  network: string,
  comparison: ICodehashComparison,
  deps: IVerifyCutDeps
): Promise<ITargetVerdict> => {
  let read: IOffCodeImmutables
  try {
    read = await deps.readOffCodeImmutables(address, network)
  } catch (error) {
    return {
      address,
      verdict: comparison.verdict,
      reason: comparison.reason,
      matchedLineages: comparison.matchedLineages,
      excludedByteCount: comparison.excludedByteCount,
      pricedByteCount: 0,
      immutables: immutablesUnreadable(address, message(error)),
    }
  }

  const immutables = gradeAssumedImmutables(address, network, read)
  return {
    address,
    verdict: comparison.verdict,
    reason: comparison.reason,
    matchedLineages: comparison.matchedLineages,
    excludedByteCount: comparison.excludedByteCount,
    // Layer 1 masked nothing here, so there is nothing for a byte count to
    // retire — and the count is what gate K's summary qualifies itself with,
    // which must not read as a confirmation of an assumed mapping.
    pricedByteCount: 0,
    immutables,
  }
}

/**
 * Finishes a MATCH whose masked bytes layer 2 can account for.
 *
 * A MATCH over the unmasked bytes says the code is a build of ours; it says
 * nothing about the values spliced into it, which is the half a tampered
 * deployment lives in. So this upgrades only when every masked byte was priced
 * against an expectation this repo declares — `unpricedByteCount` at zero with
 * no disagreement — and reports what is missing otherwise.
 *
 * A disagreeing slot is a MISMATCH and not an UNVERIFIABLE: the value was read,
 * compared, and found to be something other than what `config/` declares. That
 * is a finding, and grading it grey would file it with the things nobody could
 * check.
 *
 * A layer-2 refusal is not a downgrade either. It leaves the verdict exactly
 * where layer 1 put it, which is where every immutable-carrying contract sat
 * before this layer had a call site.
 *
 * @param address - the target being judged
 * @param network - the proposal's network
 * @param comparison - layer 1's verdict, already known to be a masked MATCH
 * @param deps - carries the layer-2 read
 * @param runtimeCode - the bytes layer 1 hashed. Layer 2 must price these and
 *   not a second read of the address: the masked bytes are the half layer 1
 *   makes no claim about, so a reading that disagreed with this one would put
 *   the only check of them on evidence the comparison never saw.
 */
const complete = async (
  address: string,
  network: string,
  comparison: ICodehashComparison,
  deps: IVerifyCutDeps,
  runtimeCode: string | undefined
): Promise<ITargetVerdict> => {
  const masked = `${address}: the code outside its immutables matches an attested build, but ${comparison.excludedByteCount} bytes holding immutables`
  const stillMasked = (
    why: string,
    immutables: IImmutableVerdict
  ): ITargetVerdict => ({
    address,
    verdict: 'UNVERIFIABLE',
    reason: `${masked} ${why}, so this is not yet a match of the deployed code.`,
    matchedLineages: comparison.matchedLineages,
    excludedByteCount: comparison.excludedByteCount,
    pricedByteCount: 0,
    immutables,
  })

  if (runtimeCode === undefined)
    return stillMasked(
      'were not checked: this observation did not carry the bytes it was built from, and pricing a second read of the address would check bytes the comparison never saw',
      immutablesUnreadable(
        address,
        'the observation carried no bytes to read them out of'
      )
    )

  let pricing: ImmutablePricing
  try {
    pricing = await deps.price(address, network, runtimeCode)
  } catch (error) {
    // An infrastructure failure in layer 2 must not read as a clean masked
    // verdict, and must not read as a finding either.
    return stillMasked(
      `could not be checked: ${message(error)}`,
      immutablesUnreadable(address, message(error))
    )
  }

  if (!pricing.decided)
    return stillMasked(
      `were not checked: ${pricing.reason}`,
      immutablesUnreadable(address, pricing.reason)
    )

  if (pricing.disagreements.length > 0)
    return {
      address,
      verdict: 'MISMATCH',
      reason: `${address}: the code matches an attested build, but ${
        pricing.disagreements.length
      } of its immutables hold a value this repo does not declare for ${network} — ${pricing.disagreements
        .map(
          (one) =>
            `${one.name} holds ${one.observed}, ${
              one.origin ?? 'config'
            } declares ${one.expected ?? 'another value'}`
        )
        .join('; ')}.`,
      matchedLineages: comparison.matchedLineages,
      excludedByteCount: comparison.excludedByteCount,
      pricedByteCount: pricing.pricedByteCount,
      immutables: gradeInlinedImmutables(address, network, pricing),
    }

  if (pricing.unpricedByteCount > 0)
    return stillMasked(
      `include ${
        pricing.unpricedByteCount
      } with no declared expectation to compare against (${pricing.slots
        .filter((one) => one.status !== 'verified')
        .map((one) => `${one.name}: ${one.detail ?? one.status}`)
        .join('; ')})`,
      gradeInlinedImmutables(address, network, pricing)
    )

  return {
    address,
    verdict: 'MATCH',
    reason: `${address}: matches an attested build, and all ${comparison.excludedByteCount} bytes holding immutables hold the values this repo declares for ${network}.`,
    matchedLineages: comparison.matchedLineages,
    // Nothing was left uncompared, so a renderer has no qualifier to add.
    excludedByteCount: 0,
    pricedByteCount: pricing.pricedByteCount,
    immutables: gradeInlinedImmutables(address, network, pricing),
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
  pricedByteCount: 0,
  immutables: immutablesUnreadable(address, why),
})

/**
 * @param error - whatever was thrown
 */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * @param targets - the per-address verdicts
 * @param installsNothing - true when nothing judged here gated an address
 */
const summarise = (
  targets: ITargetVerdict[],
  installsNothing: boolean
): string => {
  if (installsNothing)
    return 'This call installs no contract code, so there is no bytecode to vouch for.'

  const bad = targets.filter((t) => t.verdict !== 'MATCH')
  if (bad.length === 0) {
    const masked = targets.reduce((n, t) => n + t.excludedByteCount, 0)
    const priced = targets.reduce((n, t) => n + t.pricedByteCount, 0)
    // Silence would collapse "this code holds no immutables" into "its
    // immutables were checked", which are the two ways to reach a clean MATCH.
    const caveat =
      masked > 0
        ? ` ${masked} bytes were excluded as immutables and are not covered by this result — their values still need checking.`
        : priced > 0
        ? ` ${priced} bytes holding immutables were compared against the values this repo declares for them.`
        : ''
    // Not "matches main": the rebuild is at the commit each deployment record
    // names, and D3 has the verifier assert that commit's presence rather than
    // its ancestry. Saying main would promise the signer a check nobody runs.
    return `Every address this call installs matches a rebuild at the commit its deployment record names. Whether that commit is on main is not checked.${caveat}`
  }

  // The verdict word is carried per address rather than summed, so a MISMATCH
  // and an UNVERIFIABLE in one cut do not average into a single colour.
  return `This call will not be signed. ${bad
    .map((t) => `${t.address} is ${t.verdict}: ${t.reason}`)
    .join(' ')}`
}
