/**
 * Reconstructs a deployment's immutables by re-running its constructor against
 * a local EVM, so all of its runtime bytes can be compared instead of the bytes
 * outside the immutables.
 *
 * Import this in front of `compareToAttestedSet`. When it answers `decided:
 * false` the caller runs the masking path unchanged, so this layer only ever
 * turns a qualified verdict into an unqualified one, or a pass into a block —
 * never the other way round.
 *
 * The expected args must come from `deriveExpectedConstructorArgs`, which reads
 * only this repo's registry and `config/`. Handing this function args taken
 * from the chain or an explorer reproduces the trap in `forge verify-bytecode`:
 * the replay then bakes in whatever the proposer chose and every immutable
 * verifies against itself.
 */
import type { IAttestedBuild, ICodehashComparison } from './attested-set'
import { stripMetadataTrailer } from './bytecode-trailer'
import type { ExpectedArgs } from './expected-constructor-args'
import { frameFault, normalizeHash, strip0x } from './hex'
import type { ImmutableReferences } from './immutable-offsets'
import { normalizeRuntimeCode } from './rebuild-attestations'

export interface IReplayRequest {
  /** Creation code from our own build of the attested commit, `0x`-prefixed. */
  creationCode: string
  /** ABI-encoded constructor tail, without `0x`. Empty for a nullary constructor. */
  encodedArgs: string
  /**
   * The chain the deployment being graded lives on. A constructor may bake
   * `block.chainid` into an immutable — `SupersetFacet` derives `IS_HUB` from
   * it — so a replay under any other chain id reconstructs different code.
   */
  chainId: number
}

export interface IReplayedCode {
  ok: true
  /** Runtime code the constructor returned, `0x`-prefixed. */
  runtimeCode: string
}

export interface IReplayFailed {
  ok: false
  reason: string
}

export type ReplayOutcome = IReplayedCode | IReplayFailed

/**
 * The local EVM. Injected so this module holds no process or network.
 *
 * Successive calls must deploy at distinct addresses: a second replay is what
 * separates a tampered immutable from a constructor that bakes its own
 * deployment context in, and two replays landing at one address cannot.
 */
export interface IConstructorReplayDeps {
  replay: (request: IReplayRequest) => Promise<ReplayOutcome>
}

/**
 * This layer reached no verdict, so WP-2.1's masking path still has to run and
 * its qualified MATCH is what the signer sees.
 *
 * Carries no `ICodehashComparison`: a refusal used to be reported as one with
 * `blocksSigning` set, which is only safe to read alongside a second field, and
 * a caller reading it alone blocks the signer on every refusal.
 */
export interface IReplayUndecided {
  decided: false
  reason: string
}

export interface IReplayDecided {
  decided: true
  /**
   * This layer's own verdict. MATCH only when every runtime byte outside the
   * metadata trailer was compared, so its `excludedByteCount` is always 0.
   */
  comparison: ICodehashComparison
}

export type ReplayVerification = IReplayUndecided | IReplayDecided

export interface IReplayInput {
  /** Runtime code found at the address, `0x`-prefixed. */
  observedRuntimeCode: string
  /** Creation code from our own build of the attested commit, `0x`-prefixed. */
  creationCode: string
  /** Chain the deployment lives on, reproduced as `block.chainid` by the replay. */
  chainId: number
  /**
   * Every build this repo vouches for. The replayed code has to normalise to
   * one of them before any verdict is reached, and the lineage a MATCH reports
   * is that build's. A caller cannot assert a lineage, because a MATCH here
   * tells it to skip masking: creation code from an unattested build would
   * otherwise pass with layer 1 never running.
   */
  attestedBuilds: readonly IAttestedBuild[]
  /** Foundry's `immutableReferences` for the artifact, or undefined when it has none. */
  immutableReferences: ImmutableReferences | undefined
  expectedArgs: ExpectedArgs
}

const undecided = (reason: string): ReplayVerification => ({
  decided: false,
  reason,
})

const decided = (comparison: ICodehashComparison): ReplayVerification => ({
  decided: true,
  comparison,
})

const mismatch = (reason: string): ReplayVerification =>
  decided({
    verdict: 'MISMATCH',
    matchedLineages: [],
    reason,
    excludedByteCount: 0,
    blocksSigning: true,
  })

const byteLength = (hex: string): number => strip0x(hex).length / 2

/**
 * The attested lineages whose build the replayed code reproduces.
 *
 * A MATCH here tells the caller to skip masking, so the code it matched has to
 * be code this repo attested — otherwise the layer would vouch for whatever
 * creation code it was handed. Normalisation goes through the same
 * `normalizeRuntimeCode` both sides of layer 1 use; a second implementation of
 * strip-then-mask is how two sides come to normalise differently.
 *
 * EVM semantics are assumed: zksolc keeps its immutables in `ImmutableSimulator`
 * rather than in the runtime code, and its creation code does not execute on the
 * local EVM at all, so a zk artifact never reaches here.
 *
 * @param replayedRuntimeCode - What the constructor returned, `0x`-prefixed.
 * @param input - The attested set and the artifact's immutable ranges.
 * @returns The matching lineages, or why the replay vouches for nothing.
 */
const attestedLineages = (
  replayedRuntimeCode: string,
  input: IReplayInput
): { ok: true; lineages: string[] } | { ok: false; reason: string } => {
  const normalized = normalizeRuntimeCode(
    replayedRuntimeCode,
    input.immutableReferences,
    { isZk: false }
  )
  if (!normalized.ok)
    return {
      ok: false,
      reason: `the replayed code could not be normalised against the attested set: ${normalized.reason}`,
    }

  const lineages = input.attestedBuilds
    .filter(
      (build) =>
        normalizeHash(build.maskedHash) ===
          normalizeHash(normalized.maskedHash) &&
        build.rawByteLength === normalized.rawByteLength
    )
    .map((build) => build.lineage)

  if (lineages.length === 0)
    return {
      ok: false,
      reason:
        'the creation code that was replayed normalises to no attested build, so matching the deployment against it would vouch for the creation code rather than for anything this repo attested',
    }

  return { ok: true, lineages }
}

/**
 * Why a second replay does not reproduce the first, when it does not.
 *
 * A constructor is free to read something a replay cannot reproduce and store
 * it: `EmergencyPauseFacet` keeps `address(this)`, which no local deployment
 * lands on. Code built that way differs between two replays, and its difference
 * from the deployment is indistinguishable from a tampered immutable — so it
 * refuses rather than block a signer on a deployment that may be honest.
 *
 * @param deps - The local EVM.
 * @param request - The same request the first replay was given.
 * @param firstRuntimeCode - What that replay returned, lowercase and without `0x`.
 * @returns Why the two replays cannot be compared, or undefined when they agree.
 */
const contextFault = async (
  deps: IConstructorReplayDeps,
  request: IReplayRequest,
  firstRuntimeCode: string
): Promise<string | undefined> => {
  const again = await deps.replay(request)
  if (!again.ok)
    return `the constructor ran once locally but not a second time, so whether it bakes its deployment context into the runtime code is unknown: ${again.reason}`

  const fault = frameFault(again.runtimeCode, 'replayed code')
  if (fault) return fault

  if (strip0x(again.runtimeCode).toLowerCase() !== firstRuntimeCode)
    return 'two local replays of this constructor differ from each other, so it stores something about where it was deployed and a local replay cannot reconstruct this deployment'

  return undefined
}

/**
 * Grades deployed code against a local replay of its own constructor.
 *
 * The only normalisation is the metadata trailer strip, and a match additionally
 * pins the deployed length: the trailer's length word decides how much comes
 * off, so without the pin an appended payload plus a covering length word
 * normalises to whatever prefix the appender likes. Every other byte, the
 * immutables included, is compared exactly.
 *
 * Strictly narrower than the masking path it fronts. Masking required the code
 * outside the immutables to match; this requires that and the immutable bytes,
 * so nothing that failed there can pass here.
 *
 * Costs one local deployment, and a second only where the first would block: a
 * verdict against a constructor that stores where it landed has to be withheld
 * rather than reached, and two replays disagreeing is what identifies one.
 *
 * @param input - Observed code, our creation code, the chain, and the config-derived args.
 * @param deps - The local EVM to run the constructor on.
 * @returns The verdict, and whether the masking path still has to run.
 */
export const verifyByConstructorReplay = async (
  input: IReplayInput,
  deps: IConstructorReplayDeps
): Promise<ReplayVerification> => {
  const { expectedArgs } = input
  if (!expectedArgs.ok)
    return undecided(
      `the constructor args cannot be derived from our own record and config, so the immutables cannot be reconstructed: ${expectedArgs.reason}`
    )

  const observedFault = frameFault(input.observedRuntimeCode, 'deployed code')
  if (observedFault) return undecided(observedFault)

  const creationFault = frameFault(input.creationCode, 'creation code')
  if (creationFault) return undecided(creationFault)

  const request: IReplayRequest = {
    creationCode: input.creationCode,
    encodedArgs: expectedArgs.encoded,
    chainId: input.chainId,
  }

  const outcome = await deps.replay(request)
  if (!outcome.ok)
    return undecided(
      `the constructor could not be replayed locally, so the immutables were not reconstructed: ${outcome.reason}`
    )

  const replayedFault = frameFault(outcome.runtimeCode, 'replayed code')
  if (replayedFault) return undecided(replayedFault)

  const attested = attestedLineages(outcome.runtimeCode, input)
  if (!attested.ok) return undecided(attested.reason)

  const observedRaw = strip0x(input.observedRuntimeCode).toLowerCase()
  const replayedRaw = strip0x(outcome.runtimeCode).toLowerCase()

  if (observedRaw === replayedRaw)
    return decided({
      verdict: 'MATCH',
      matchedLineages: attested.lineages,
      reason: `every one of the ${byteLength(
        observedRaw
      )} deployed bytes matches a local replay of the constructor with the args config declares, so the immutables hold the expected values`,
      excludedByteCount: 0,
      blocksSigning: false,
    })

  const observedStripped = strip0x(stripMetadataTrailer(observedRaw).code)
  const replayedStripped = strip0x(stripMetadataTrailer(replayedRaw).code)

  if (
    observedStripped !== replayedStripped ||
    observedRaw.length !== replayedRaw.length
  ) {
    const contextReason = await contextFault(deps, request, replayedRaw)
    if (contextReason) return undecided(contextReason)

    return mismatch(
      observedStripped !== replayedStripped
        ? `the deployed code differs from a local replay of the constructor with the args config declares, outside the metadata trailer, so either the code or an immutable is not what this repo built`
        : `the deployed code and a local replay of its constructor agree outside the metadata trailer but are ${byteLength(
            observedRaw
          )} and ${byteLength(replayedRaw)} bytes, so ${Math.abs(
            byteLength(observedRaw) - byteLength(replayedRaw)
          )} bytes of the deployment are not accounted for`
    )
  }

  return decided({
    verdict: 'MATCH',
    matchedLineages: attested.lineages,
    reason: `the deployed code matches a local replay of the constructor with the args config declares in all ${byteLength(
      observedStripped
    )} bytes outside its metadata trailer, immutables included, and is the same ${byteLength(
      observedRaw
    )} bytes long`,
    excludedByteCount: 0,
    blocksSigning: false,
  })
}
