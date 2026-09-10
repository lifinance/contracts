/**
 * Runs the merged gates over the real fleet corpus in shadow mode (WP-8.4).
 *
 * Report-only, and structurally so: this module constructs no Safe client, no
 * Mongo connection, no RPC transport and no signer. It reaches nothing that
 * could propose, sign, broadcast or write. What it does is call the same gate
 * functions the signing path calls, on real production rows, and count what
 * they refuse.
 *
 * The corpus is real and none of it is synthetic:
 *
 * - `script/deploy/resources/reproducibilityAttestations.json` — the 742
 *   production slots WP-7.1 rebuilt and proved byte-identical (#2289). Every
 *   row is an honest input by construction: the code at that address provably
 *   IS a build of this repository at the recorded commit and profile.
 * - `deployments/<network>.json` and `deployments/<network>.diamond.json` —
 *   the real deployment and diamond logs.
 * - `config/networks.json` and `foundry.toml` — the config the gates read.
 *
 * G2 drives layer 1 — {@link compareToAttestedSet} — and not the sign-time
 * `judge` in `verify-cut-targets.ts`, which additionally downgrades a layer-1
 * MATCH to UNVERIFIABLE whenever any byte was excluded as an immutable. The
 * WP-7.1 corpus recorded no masked-byte counts, so that downgrade cannot be
 * modelled from this data at all: every G2 refusal rate here is a LOWER bound
 * on what the real gate refuses, never an upper one. G2's coverage note carries
 * this.
 *
 * One thing is modelled rather than re-executed, and the report says so: the
 * bytecode comparison itself. Re-fetching 742 addresses and re-running several
 * hundred forge builds is what WP-7.1 already did, and its result is the input
 * here. So {@link compareToAttestedSet} is driven with hashes keyed on build
 * identity — two builds agree exactly when their (contract, version, commit,
 * solc, evm) agree — which is precisely what the sweep measured. What is
 * measured here is therefore whether the gate's derived set of legitimate
 * builds CONTAINS the build that provably reproduces the deployed code. When
 * it does not, MISMATCH is not avoidable by any bytecode the address holds.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem'

import { DIAMOND_CUT_ABI } from '../shared/constants'
import {
  assertFunnelDeployGate,
  indexDeploymentsByAddress,
  type IFunnelGateDeps,
} from '../shared/funnel-deploy-gate'

import { compareToAttestedSet, type IAttestedBuild } from './attested-set'
import { ensureCommitAvailable } from './commit-availability'
import { classifyCut, FacetCutActionEnum } from './cut-classification'
import {
  summariseGate,
  type IGateBudget,
  type IShadowObservation,
} from './false-refusal-budget'
import {
  deriveToolchainScope,
  parseBuildProfiles,
  type IBuildProfile,
} from './lineage-scope'

/** One attested production slot, as the sweep recorded it. */
export interface ICorpusSlot {
  network: string
  address: string
  contractName: string
  version: string
  commit: string
  solcVersion: string
  evmVersion: string
  optimizerRuns: string
}

/**
 * Everything the run reads, injectable so a test can plant a defect in the
 * corpus or the config and watch the report change.
 */
export interface ICorpusDeps {
  slots: readonly ICorpusSlot[]
  networks: Record<string, { targetEvmVersion: string; isZkEVM: boolean }>
  foundryToml: string
  /** Reads a deployment or diamond log, or undefined when there is none. */
  readLog: (relativePath: string) => Record<string, unknown> | undefined
  /** Whether `src/Facets/<name>.sol` exists on this checkout. */
  facetSourceExists: (name: string) => boolean
  /** True when this checkout can already read the commit. */
  hasCommit: (sha: string) => boolean
  /** Networks excluded from the funnel-gate corpus, with the reason. */
  funnelExclusions: ReadonlyMap<string, string>
  /** Contracts deprecated from `src/`, so installing one is not honest input. */
  deprecatedContracts: ReadonlySet<string>
}

const slotId = (slot: ICorpusSlot): string =>
  `${slot.network}/${slot.contractName}@${slot.version}`

const profileKey = (solcVersion: string, evmVersion: string): string =>
  `${solcVersion}/${evmVersion}`.toLowerCase()

/**
 * A stand-in for the normalised runtime hash of one build.
 *
 * Keyed on build identity, because that is the equality WP-7.1 measured: two
 * of these agree exactly when the sweep found the rebuilds byte-identical.
 * @param parts - contract, version, commit and compiler pair
 */
const buildFingerprint = (parts: {
  contractName: string
  version: string
  commit: string
  solcVersion: string
  evmVersion: string
}): string =>
  keccak256(
    toHex(
      [
        parts.contractName,
        parts.version,
        parts.commit,
        profileKey(parts.solcVersion, parts.evmVersion),
      ].join('|')
    )
  )

/**
 * A stand-in for the deployed byte length of one build.
 *
 * Length is compared alongside the hash by {@link compareToAttestedSet}, and a
 * differing compiler produces a differing length — that is the `length-mismatch`
 * signature all fourteen wrong-compiler slots in the WP-7.1 sweep carried.
 * @param fingerprint - the build's fingerprint
 */
const buildLength = (fingerprint: string): number =>
  1024 + (Number.parseInt(fingerprint.slice(2, 8), 16) % 8192)

/**
 * Which named accepted-false-red rule explains a scope-driven refusal.
 *
 * Evidence-based rather than exhaustive, and that is the point: a refusal
 * whose reproducing build the gate WAS offered has no explanation in D19's
 * enumeration, so it returns undefined and lands in the budget. Classifying
 * every refusal by falling through to a last named class would make the
 * unexplained count structurally unreachable, which is the decorative-gate
 * shape G4 forbids.
 *
 * @param slot - the honest row that was refused
 * @param pinnedPairs - every non-zk compiler pair foundry.toml pins today
 * @param offeredPairs - the pairs the gate actually graded this slot against
 * @returns The rule id, or undefined when nothing named covers it
 */
export const explainScopeRefusal = (
  slot: ICorpusSlot,
  pinnedPairs: ReadonlySet<string>,
  offeredPairs: ReadonlySet<string>
): string | undefined => {
  const pair = profileKey(slot.solcVersion, slot.evmVersion)
  if (offeredPairs.has(pair)) return undefined
  if (!pinnedPairs.has(pair)) return 'AFR-1-retired-pin'
  return 'AFR-2-cross-profile-network'
}

/**
 * G1 — can the network's legitimate builds be enumerated at all?
 * @param deps - the corpus
 */
export const gradeToolchainScope = (deps: ICorpusDeps): IGateBudget => {
  const profiles = parseBuildProfiles(deps.foundryToml)
  const observations: IShadowObservation[] = deps.slots.map((slot) => {
    try {
      deriveToolchainScope(slot.network, { networks: deps.networks, profiles })
      return {
        slot: slotId(slot),
        refused: false,
        reason: '',
      }
    } catch (error) {
      return {
        slot: slotId(slot),
        refused: true,
        reason: error instanceof Error ? error.message : String(error),
        ruleId: 'AFR-3-unresolvable-network',
      }
    }
  })

  return summariseGate({
    gate: 'G1-toolchain-scope',
    corpus: 'attested production slots (WP-7.1 / #2289)',
    denominator: deps.slots.length,
    coverageNote:
      'Covers every network carrying an attested slot. The three zkEVM networks and localanvil carry none, so their scope paths are measured on 0.',
    observations,
  })
}

/**
 * G2 — does the gate's legitimate set contain the build that reproduces the
 * deployed code?
 * @param deps - the corpus
 */
export const gradeAttestedSet = (deps: ICorpusDeps): IGateBudget => {
  const profiles = parseBuildProfiles(deps.foundryToml)
  // zksolc-pinned profiles are left out for the same reason deriveToolchainScope
  // filters them: no EVM network is ever offered one, so counting its pair as
  // "pinned today" would file a retired EVM build under AFR-2 instead of AFR-1.
  const pinnedPairs = new Set(
    Object.values(profiles)
      .filter((p: IBuildProfile) => p.zksolcVersion === undefined)
      .map((p: IBuildProfile) => profileKey(p.solcVersion, p.evmVersion))
  )

  const observations: IShadowObservation[] = []
  for (const slot of deps.slots) {
    let scopeProfiles: IBuildProfile[]
    try {
      scopeProfiles = deriveToolchainScope(slot.network, {
        networks: deps.networks,
        profiles,
      }).profiles
    } catch {
      // Counted by G1; grading it twice would double-count one refusal.
      continue
    }

    const offeredPairs = new Set(
      scopeProfiles.map((p) => profileKey(p.solcVersion, p.evmVersion))
    )
    const observedFingerprint = buildFingerprint(slot)
    const attested: IAttestedBuild[] = scopeProfiles.map((profile) => {
      const fingerprint = buildFingerprint({ ...slot, ...profile })
      return {
        lineage: `${profile.profile} ${profile.solcVersion}/${profile.evmVersion}`,
        solcVersion: profile.solcVersion,
        maskedHash: fingerprint,
        rawByteLength: buildLength(fingerprint),
        rawHash: undefined,
      }
    })

    const comparison = compareToAttestedSet(
      {
        maskedHash: observedFingerprint,
        rawByteLength: buildLength(observedFingerprint),
        rawHash: observedFingerprint,
        maskedByteCount: 0,
        solcVersion: slot.solcVersion,
      },
      attested,
      { isClosedSet: true }
    )

    observations.push({
      slot: slotId(slot),
      refused: comparison.blocksSigning,
      reason: comparison.blocksSigning
        ? `${comparison.verdict}: ${
            comparison.reason
          } (reproduces at ${profileKey(
            slot.solcVersion,
            slot.evmVersion
          )}; the gate offers ${[...offeredPairs].join(', ')})`
        : '',
      ...(comparison.blocksSigning
        ? { ruleId: explainScopeRefusal(slot, pinnedPairs, offeredPairs) }
        : {}),
    })
  }

  return summariseGate({
    gate: 'G2-attested-set',
    corpus: 'attested production slots (WP-7.1 / #2289)',
    denominator: observations.length,
    coverageNote: `EVM only. The sweep excluded 6 zkEVM slots because it did not record which zksolc version produced the match, so the zk normalisation path is measured on 0. Bytecode equality is taken from the sweep rather than re-fetched, and layer 1 is graded without the sign-time MATCH-to-UNVERIFIABLE downgrade for uncompared immutable bytes, which the corpus records nothing about — so this rate is a lower bound on what the real gate refuses. See this module's header. ${
      deps.slots.length - observations.length
    } of ${
      deps.slots.length
    } attested slots left this denominator because G1 could not derive their scope.`,
    observations,
  })
}

/**
 * G3 — is every record\'s commit readable before anything is concluded from it?
 *
 * The injected git runner reads locally and refuses to fetch, so the run stays
 * offline. Every commit in the corpus is already readable, so the fetch path is
 * measured on 0 and the coverage note says so.
 * @param deps - the corpus
 */
export const gradeCommitAvailability = (deps: ICorpusDeps): IGateBudget => {
  const git = (args: string[]): string => {
    if (args[0] === 'cat-file') {
      const sha = (args[2] ?? '').replace('^{commit}', '')
      if (deps.hasCommit(sha)) return ''
      throw new Error(`not a commit: ${sha}`)
    }
    throw new Error(
      'the shadow runner does not fetch: this run is offline by construction'
    )
  }

  const observations: IShadowObservation[] = deps.slots.map((slot) => {
    const availability = ensureCommitAvailable(slot.commit, { git })
    return {
      slot: slotId(slot),
      refused: !availability.ok,
      reason: availability.ok ? '' : availability.reason,
    }
  })

  const distinct = new Set(deps.slots.map((slot) => slot.commit)).size
  return summariseGate({
    gate: 'G3-commit-availability',
    corpus: 'attested production slots (WP-7.1 / #2289)',
    denominator: deps.slots.length,
    coverageNote: `${distinct} distinct commits, all readable in this checkout, so the three-attempt fetch path is measured on 0.`,
    observations,
  })
}

/** Selector used for the synthesised cut; the gates never call it. */
const PROBE_SELECTOR = '0x12345678'

/**
 * Encodes the cut a Replace of one live facet would carry.
 * @param address - the facet address being reinstalled
 */
const replaceCutCalldata = (address: string): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [
        {
          facetAddress: address as Hex,
          action: FacetCutActionEnum.Replace,
          functionSelectors: [PROBE_SELECTOR as Hex],
        },
      ],
      '0x0000000000000000000000000000000000000000',
      '0x',
    ],
  })

/**
 * What `registeredFacetSlots` drops before either gate grades a row, so a
 * shrunken denominator is never silent on the gate that shrank it.
 * @param deps - the corpus
 */
const exclusionNote = (deps: ICorpusDeps): string =>
  `Excluded: ${[...deps.funnelExclusions.entries()]
    .map(([network, why]) => `${network} (${why})`)
    .join('; ')}; and ${[...deps.deprecatedContracts].join(
    ', '
  )}, deprecated from src/ so a cut installing one is not an honest input.`

/** Slots whose address is registered as a facet in the network's diamond log. */
const registeredFacetSlots = (deps: ICorpusDeps): ICorpusSlot[] =>
  deps.slots.filter((slot) => {
    if (deps.funnelExclusions.has(slot.network)) return false
    if (deps.deprecatedContracts.has(slot.contractName)) return false
    const diamond = deps.readLog(`deployments/${slot.network}.diamond.json`)
    const facets = (
      diamond?.['LiFiDiamond'] as
        | { Facets?: Record<string, unknown> }
        | undefined
    )?.Facets
    if (!facets) return false
    return Object.keys(facets).some(
      (key) => key.toLowerCase() === slot.address.toLowerCase()
    )
  })

/**
 * G4 — does the cut classifier refuse a plain Replace of a live facet?
 * @param deps - the corpus
 */
export const gradeCutClassification = (deps: ICorpusDeps): IGateBudget => {
  const slots = registeredFacetSlots(deps)
  const observations: IShadowObservation[] = slots.map((slot) => {
    const verdict = classifyCut({
      cuts: [
        { facetAddress: slot.address, action: FacetCutActionEnum.Replace },
      ],
      init: '0x0000000000000000000000000000000000000000',
    })
    return {
      slot: slotId(slot),
      refused: verdict.refusals.length > 0,
      reason: verdict.refusals.join(' '),
    }
  })

  return summariseGate({
    gate: 'G4-cut-classification',
    corpus: 'live registered facets, as a Replace cut',
    denominator: slots.length,
    coverageNote: `The classifier also judges Remove-with-init and unknown actions; neither shape occurs in the corpus, so both are measured on 0. ${exclusionNote(
      deps
    )}`,
    observations,
  })
}

/**
 * G5 — can the funnel deploy gate attribute a live facet to a source file?
 *
 * Drives the real {@link assertFunnelDeployGate} through its own dependency
 * seam. Only `runGate` is stubbed: it is the GitHub main-equivalence call, and
 * this run makes no network requests. The coverage note carries that.
 * @param deps - the corpus
 */
export const gradeFunnelDeployGate = async (
  deps: ICorpusDeps
): Promise<IGateBudget> => {
  const slots = registeredFacetSlots(deps)
  const observations: IShadowObservation[] = []

  const gateDeps: IFunnelGateDeps = {
    // Every corpus row is a production mainnet slot, so the testnet exemption
    // must not be what makes the measurement come back clean.
    isTestnet: () => false,
    currentBranch: () => 'main',
    // The production inverter itself rather than a copy: a re-implementation
    // would measure the copy's attribution instead of the gate's.
    deployedNames: async (network: string): Promise<Map<string, string>> =>
      indexDeploymentsByAddress(
        deps.readLog(`deployments/${network}.json`) ?? {}
      ),
    facetSourceExists: deps.facetSourceExists,
    runGate: async () => [],
  }

  for (const slot of slots)
    try {
      await assertFunnelDeployGate(
        {
          network: slot.network,
          calldatas: [replaceCutCalldata(slot.address)],
        },
        gateDeps
      )
      observations.push({
        slot: slotId(slot),
        refused: false,
        reason: '',
      })
    } catch (error) {
      observations.push({
        slot: slotId(slot),
        refused: true,
        reason: error instanceof Error ? error.message : String(error),
      })
    }

  return summariseGate({
    gate: 'G5-funnel-deploy-gate',
    corpus: 'live registered facets, as a Replace cut',
    denominator: slots.length,
    coverageNote: `The GitHub main-equivalence call (\`runGate\`) is stubbed to no failures, so what is measured is address attribution and cut decoding, not approval state. ${exclusionNote(
      deps
    )}`,
    observations,
  })
}

/**
 * The corpus as it exists in this checkout.
 * @param repoRoot - repository root
 */
export const loadRepoCorpus = (repoRoot: string): ICorpusDeps => {
  // Memoised because the gates ask per slot rather than per network: without it
  // the run re-reads and re-parses the same ~170 logs some 1,900 times.
  const cache = new Map<string, Record<string, unknown> | undefined>()
  const read = (relativePath: string): Record<string, unknown> | undefined => {
    if (cache.has(relativePath)) return cache.get(relativePath)
    const path = join(repoRoot, relativePath)
    const parsed = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : undefined
    cache.set(relativePath, parsed)
    return parsed
  }

  const attestations = read(
    'script/deploy/resources/reproducibilityAttestations.json'
  )
  if (!attestations)
    throw new Error(
      'the fleet attestation corpus is missing; there is nothing to measure against and a run without it would report a rate on no data'
    )

  const slots = attestations['attestations']
  if (!Array.isArray(slots) || slots.length === 0)
    throw new Error(
      'the fleet attestation corpus carries no non-empty "attestations" array; there is nothing to measure'
    )

  // Fails closed rather than deriving scope against an absent config: every
  // slot would then throw inside deriveToolchainScope, land in the grey
  // AFR-3 class, and leave every gate promotable on a corpus that measured
  // nothing — the exact false GREEN evaluatePromotion exists to refuse.
  const networks = read('config/networks.json')
  if (!networks)
    throw new Error(
      "config/networks.json is missing, so no network's legitimate builds can be enumerated. Every refusal would be reported as the grey AFR-3-unresolvable-network class and every gate would come back promotable on a corpus that graded nothing."
    )

  return {
    slots: slots as ICorpusSlot[],
    networks: networks as ICorpusDeps['networks'],
    foundryToml: readFileSync(join(repoRoot, 'foundry.toml'), 'utf8'),
    readLog: read,
    facetSourceExists: (name: string) =>
      existsSync(join(repoRoot, 'src', 'Facets', `${name}.sol`)),
    hasCommit: (sha: string) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
          cwd: repoRoot,
          stdio: 'ignore',
        })
        return true
      } catch {
        return false
      }
    },
    funnelExclusions: new Map([
      [
        'tron',
        'the tron deployment log stores base58, and the tron funnel supplies a reader built from a live TronWeb instance, which this offline run does not construct',
      ],
    ]),
    deprecatedContracts: new Set(['GenericSwapFacet']),
  }
}

/**
 * Every gate, over the whole corpus.
 * @param deps - the corpus
 */
export const runShadowBudget = async (
  deps: ICorpusDeps
): Promise<IGateBudget[]> => [
  gradeToolchainScope(deps),
  gradeAttestedSet(deps),
  gradeCommitAvailability(deps),
  gradeCutClassification(deps),
  await gradeFunnelDeployGate(deps),
  ...unreachedGates(),
]

/**
 * The gates no corpus in this checkout can reach.
 *
 * Reported rather than omitted: a gate missing from the table reads as a gate
 * with nothing to report, and `evaluatePromotion` must see a denominator of 0
 * so it refuses to promote them.
 */
export const unreachedGates = (): IGateBudget[] =>
  [
    {
      gate: 'G6-delegatecall-gate',
      note: 'grades `operation` off a signed Safe struct. The historical proposal records are in MongoDB behind the SC tunnel, which this offline run does not open.',
    },
    {
      gate: 'G7-ticket-gate',
      note: 'grades the `--ticket` link on a proposal. Same MongoDB corpus, same reason.',
    },
    {
      gate: 'G8-tron-fee-limit-preflight',
      note: 'exercised only by the EXSC-920 regression fixture in the test file, which is one row and not a fleet corpus. Tron carries 2 attested slots in total.',
    },
  ].map((entry) =>
    summariseGate({
      gate: entry.gate,
      corpus: 'not reached by this run',
      denominator: 0,
      coverageNote: entry.note,
      observations: [],
    })
  )
