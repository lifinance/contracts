import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { consola } from 'consola'

import { DIAMOND_CUT_FEE_LIMIT_SUN } from '../tron/send-guarded-facet-registration'
import { applyTronSafetyMargin } from '../tron/tron-energy-estimate'
import { assertTronBroadcastAffordable } from '../tron/tron-energy-preflight'

import { compareToAttestedSet } from './attested-set'
import { evaluatePromotion } from './false-refusal-budget'
import {
  explainScopeRefusal,
  gradeAttestedSet,
  gradeCommitAvailability,
  gradeCutClassification,
  gradeFunnelDeployGate,
  gradeToolchainScope,
  HARNESS_PROVENANCE,
  loadRepoCorpus,
  unreachedGates,
  type ICorpusDeps,
  type ICorpusSlot,
} from './false-refusal-budget-run'
import { deriveToolchainScope, parseBuildProfiles } from './lineage-scope'

/**
 * Two profiles, matching the shape `foundry.toml` pins: one cancun, one london.
 * Written out rather than read from disk so a plant can move one of them.
 */
const TOML = [
  '[profile.default]',
  "solc_version = '0.8.29'",
  "evm_version = 'cancun'",
  '',
  '[profile.solc_floor]',
  "solc_version = '0.8.17'",
  "evm_version = 'london'",
].join('\n')

const slot = (overrides: Partial<ICorpusSlot> = {}): ICorpusSlot => ({
  network: 'somechain',
  address: '0x1111111111111111111111111111111111111111',
  contractName: 'SomeFacet',
  version: '1.0.0',
  commit: 'a'.repeat(40),
  solcVersion: '0.8.29',
  evmVersion: 'cancun',
  optimizerRuns: '1000000',
  ...overrides,
})

const corpus = (overrides: Partial<ICorpusDeps> = {}): ICorpusDeps => ({
  slots: [slot()],
  networks: {
    somechain: { targetEvmVersion: 'cancun', isZkEVM: false },
    oldchain: { targetEvmVersion: 'london', isZkEVM: false },
  },
  foundryToml: TOML,
  readLog: () => undefined,
  facetSourceExists: () => true,
  hasCommit: () => true,
  funnelExclusions: new Map(),
  deprecatedContracts: new Set(),
  zkEvmSlotsExcluded: 6,
  ...overrides,
})

describe('the shadow runner over the real repository corpus', () => {
  // One load, reused: it carries the memoised reader the gates hit per slot.
  const repo = loadRepoCorpus(process.cwd())

  // consola.level is module-global, so a test that quiets it must put it back
  // or every later test in the process silently loses output.
  const level = consola.level
  afterEach(() => {
    consola.level = level
  })

  it('grades a corpus of real production slots, not a handful of fixtures', () => {
    expect(repo.slots.length).toBeGreaterThan(700)
    expect(new Set(repo.slots.map((s) => s.network)).size).toBeGreaterThan(50)
  })

  // The loader's row guard requires every field a gate dereferences, and the
  // real corpus is the only thing that says which those can be. Some rows carry
  // an empty version because their deployment record had none, so a guard that
  // required it would refuse the whole fleet — which is how it was first
  // written. Pinned here so tightening it fails a test rather than a run.
  it('tolerates the empty versions the real corpus carries', () => {
    expect(repo.slots.some((s) => s.version === '')).toBe(true)
    for (const slot of repo.slots)
      expect({
        network: slot.network !== '',
        address: slot.address !== '',
        contractName: slot.contractName !== '',
        commit: slot.commit !== '',
        solcVersion: slot.solcVersion !== '',
        evmVersion: slot.evmVersion !== '',
      }).toEqual({
        network: true,
        address: true,
        contractName: true,
        commit: true,
        solcVersion: true,
        evmVersion: true,
      })
  })

  // G3 is deliberately not in this list. Its count is a property of the clone
  // rather than of the fleet — a full clone reads every corpus commit and a
  // depth-1 checkout, which is what actions/checkout gives by default, reads
  // none and drives it to one unexplained refusal per row. Asserting 0 here
  // would be asserting that whoever runs the suite cloned deeply. The row
  // below grades it against what the checkout can actually read.
  it('leaves nothing unexplained on any gate it could reach', async () => {
    consola.level = 1
    const budgets = [
      gradeToolchainScope(repo),
      gradeAttestedSet(repo),
      gradeCutClassification(repo),
      await gradeFunnelDeployGate(repo),
    ]
    for (const budget of budgets) {
      expect(budget.denominator).toBeGreaterThan(0)
      expect({
        gate: budget.gate,
        unexplained: budget.adjudications
          .filter((a) => a.adjudication === 'unexplained')
          .map((a) => `${a.slot}: ${a.reason}`),
      }).toEqual({ gate: budget.gate, unexplained: [] })
    }
  }, 60_000)

  // The paired present for the row above. "Zero unexplained" is worth nothing
  // unless something was actually refused, and the attested-set gate is where
  // the fleet's real false reds are.
  it('does refuse a large share of provably honest slots on the attested-set gate', () => {
    const budget = gradeAttestedSet(repo)
    expect(budget.refusals).toBeGreaterThan(400)
    expect(budget.acceptedFalseReds).toBe(budget.refusals)
    expect(evaluatePromotion(budget).mayEnforce).toBe(false)
  })

  // Both ends are honest, and which one holds is decided by the clone. The
  // refusal set is pinned against readability determined here rather than
  // against a constant, so a gate that stopped refusing would fail this row in
  // a depth-limited checkout — where it would otherwise report "0 of them
  // unreadable" about a checkout that could read none of them. In a full clone
  // the gate genuinely cannot refuse, so nothing over the real corpus can catch
  // that mutation there; the injected-reader plant further down is what does.
  it('grades commit availability against what this checkout can read', () => {
    const budget = gradeCommitAvailability(repo)
    const unreadable = repo.slots
      .filter((s) => !repo.hasCommit(s.commit))
      .map((s) => `${s.network}/${s.contractName}@${s.version}`)

    expect(budget.denominator).toBe(repo.slots.length)
    expect(budget.adjudications.map((a) => a.slot).sort()).toEqual(
      unreadable.sort()
    )
    expect(budget.unexplained).toBe(unreadable.length)
    expect(budget.coverageNote).toContain(
      unreadable.length === 0
        ? '0 of them unreadable'
        : 'measure this checkout, not the gate'
    )
  })

  it('reports the gates no corpus reached as measured on 0, not as clean', () => {
    for (const budget of unreachedGates(repo)) {
      expect(budget.falseRefusalRate).toBeUndefined()
      expect(evaluatePromotion(budget).mayEnforce).toBe(false)
    }
  })
})

describe('loadRepoCorpus fails closed on an unmeasurable corpus', () => {
  // A corpus per test rather than per block, so no row can be handed state an
  // earlier row happened to leave behind. What makes each row self-sufficient
  // is the file it writes in its own body; this pair only stops the dir from
  // outliving the row and keeps the temp dirs from accumulating, neither of
  // which the suite can observe — check $TMPDIR, not a green run.
  let scratch: string
  const CORPUS = 'script/deploy/resources/reproducibilityAttestations.json'

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'frb-corpus-'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const write = (relativePath: string, body: unknown): void => {
    const target = join(scratch, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(body))
  }

  it('refuses an absent attestation file', () => {
    write('config/networks.json', { somechain: {} })
    expect(() => loadRepoCorpus(scratch)).toThrow(
      /the fleet attestation corpus is missing/
    )
  })

  it('refuses an attestation file with no non-empty attestations array', () => {
    write(CORPUS, {})
    write('config/networks.json', { somechain: {} })
    expect(() => loadRepoCorpus(scratch)).toThrow(/nothing to measure/)

    write(CORPUS, {
      attestations: [],
    })
    expect(() => loadRepoCorpus(scratch)).toThrow(/nothing to measure/)
  })

  // The reason this one matters: without it every slot throws inside
  // deriveToolchainScope, is filed under the grey AFR-3 class, and every gate
  // comes back promotable having graded nothing.
  it('refuses a missing networks config rather than grading everything grey', () => {
    write(CORPUS, { attestations: [slot()] })
    // Written and then removed rather than simply never written: that proves
    // the loader refuses an absent file, not merely a scratch dir it could not
    // find anything in.
    write('config/networks.json', { somechain: {} })
    rmSync(join(scratch, 'config/networks.json'))
    expect(() => loadRepoCorpus(scratch)).toThrow(
      /config\/networks.json is missing/
    )
  })

  // A row naming no compiler pair reproduces nothing, so filing its refusal
  // under AFR-1 or AFR-2 would report it as explained by a rule whose text
  // does not describe it. A row missing a field the gates merely dereference
  // fails for a blunter reason: without this it dies mid-run in a TypeError
  // that names neither the row nor the gate.
  it('refuses a row missing any field the gates read', () => {
    write('config/networks.json', { somechain: {} })
    for (const field of [
      'solcVersion',
      'evmVersion',
      'network',
      'address',
      'contractName',
      'commit',
    ]) {
      const { [field]: _omitted, ...incomplete } = slot() as unknown as Record<
        string,
        unknown
      >
      write(CORPUS, {
        attestations: [slot(), incomplete],
      })
      expect(() => loadRepoCorpus(scratch)).toThrow(
        /1 of 2 attestation rows are missing one of/
      )
    }
  })

  // The paired present: with both inputs in place the loader returns a corpus,
  // and carries the sweep's own zk-exclusion count rather than a written-down
  // one that no input can move.
  it('loads when both inputs are present', () => {
    write(CORPUS, {
      attestations: [slot()],
      zkEvmSlotsExcluded: 9,
    })
    write('config/networks.json', { somechain: {} })
    writeFileSync(join(scratch, 'foundry.toml'), TOML)
    const loaded = loadRepoCorpus(scratch)
    expect(loaded.slots).toHaveLength(1)
    expect(loaded.zkEvmSlotsExcluded).toBe(9)
    expect(existsSync(join(scratch, CORPUS))).toBe(true)
  })
})

describe('a shrunken denominator is never silent', () => {
  // G1's refusals leave G2's denominator, so the number that says how many is
  // the only thing standing between a rate over 742 rows and a rate over
  // however many happened to be gradable. Pinned at both ends, or it is a
  // constant rather than a count.
  it('reports on G2 how many rows G1 could not resolve', () => {
    const resolvable = gradeAttestedSet(
      corpus({ slots: [slot(), slot({ contractName: 'OtherFacet' })] })
    )
    expect(resolvable.denominator).toBe(2)
    expect(resolvable.coverageNote).toContain('0 of 2 attested slots left')

    const dropped = gradeAttestedSet(
      corpus({
        slots: [slot(), slot({ network: 'notinconfig' })],
      })
    )
    expect(dropped.denominator).toBe(1)
    expect(dropped.coverageNote).toContain('1 of 2 attested slots left')
  })

  // Both gates share registeredFacetSlots, so both denominators shrink by the
  // same exclusions, and both coverage notes have to name them.
  it('names the exclusions on both gates that apply them', async () => {
    const deps = corpus({
      funnelExclusions: new Map([['tron', 'no offline TronWeb reader']]),
      deprecatedContracts: new Set(['GenericSwapFacet']),
    })
    for (const note of [
      gradeCutClassification(deps).coverageNote,
      (await gradeFunnelDeployGate(deps)).coverageNote,
    ]) {
      expect(note).toContain('no offline TronWeb reader')
      expect(note).toContain('GenericSwapFacet')
    }
  })
})

describe('the corpus grades against a closed set, per D19', () => {
  // Not a detail of the harness. `isClosedSet` is what decides whether these
  // refusals read MISMATCH ("this is not our code") or UNVERIFIABLE ("we
  // cannot tell") — and the promotion criterion turns on red versus grey. D19
  // rules the set closed and derived from config, because an open set falls
  // back to the compiler version the deployed bytecode reports about itself,
  // which the proposer writes. So the greying has to come from widening the
  // attested set, never from opening the scope.
  it('reports every attested-set refusal as MISMATCH, not as UNVERIFIABLE', () => {
    const budget = gradeAttestedSet(
      corpus({ slots: [slot({ solcVersion: '0.8.17', evmVersion: 'london' })] })
    )
    expect(budget.refusals).toBe(1)
    expect(budget.adjudications[0]?.reason).toStartWith('MISMATCH:')
    expect(budget.adjudications[0]?.reason).not.toContain('UNVERIFIABLE')
  })

  it('is the closed set that makes it so — an open one would grade it grey', () => {
    const open = compareToAttestedSet(
      {
        maskedHash: '0x01',
        rawByteLength: 100,
        rawHash: '0x01',
        maskedByteCount: 0,
        solcVersion: '0.8.17',
      },
      [
        {
          lineage: 'default 0.8.29/cancun',
          provenance: 'A-LOCAL',
          solcVersion: '0.8.29',
          maskedHash: '0x02',
          rawByteLength: 200,
          rawHash: undefined,
        },
      ],
      { isClosedSet: false }
    )
    expect(open.verdict).toBe('UNVERIFIABLE')
  })
})

describe('explainScopeRefusal — the classifier has no fallthrough class', () => {
  const pinned = new Set(['0.8.29/cancun', '0.8.17/london'])

  // The decision that keeps the unexplained count reachable. Today the
  // comparison cannot refuse a slot whose reproducing profile it was offered,
  // so nothing in the corpus exercises this branch — which is exactly why it
  // needs a test naming it rather than coverage that happens to pass over it.
  it('names no class when the gate was offered the reproducing profile', () => {
    expect(
      explainScopeRefusal(
        slot({ solcVersion: '0.8.29', evmVersion: 'cancun' }),
        pinned,
        new Set(['0.8.29/cancun'])
      )
    ).toBeUndefined()
  })

  it('names the retired-pin class when no profile pins the pair', () => {
    expect(
      explainScopeRefusal(
        slot({ solcVersion: '0.8.26', evmVersion: 'cancun' }),
        pinned,
        new Set(['0.8.29/cancun'])
      )
    ).toBe('AFR-1-retired-pin')
  })

  it('names the cross-profile class when the pair is pinned but not offered', () => {
    expect(
      explainScopeRefusal(
        slot({ solcVersion: '0.8.17', evmVersion: 'london' }),
        pinned,
        new Set(['0.8.29/cancun'])
      )
    ).toBe('AFR-2-cross-profile-network')
  })

  // The gate-level consequence, and the paired absence for the G5 plant that
  // DOES produce an unexplained refusal. Keyed on build identity, the
  // comparison refuses exactly when the reproducing pair is not offered, which
  // is exactly when the classifier names a class — so the refusal count moves
  // with the input while the unexplained count cannot. G2's coverage note says
  // so. This pins the observable half — a refusal the classifier fails to name
  // fails this row; a classifier that names the wrong class does not, which is
  // what the three rows above are for.
  it('moves G2 refusals with the input while its unexplained count cannot move', () => {
    const cases = [
      { solcVersion: '0.8.29', evmVersion: 'cancun', refusals: 0 },
      { solcVersion: '0.8.17', evmVersion: 'london', refusals: 1 },
      { solcVersion: '0.8.26', evmVersion: 'cancun', refusals: 1 },
      { solcVersion: '0.8.28', evmVersion: 'london', refusals: 1 },
    ]
    for (const { refusals, ...pair } of cases) {
      const budget = gradeAttestedSet(corpus({ slots: [slot(pair)] }))
      expect({
        ...pair,
        refusals: budget.refusals,
        unexplained: budget.unexplained,
      }).toEqual({ ...pair, refusals, unexplained: 0 })
    }
  })
})

describe('what the report discloses is derived, not asserted', () => {
  // Every row in today's corpus is already lower case, so only a test
  // exercises the normalisation an unnormalised corpus would need.
  it('resolves a network whose corpus row is not lower case', () => {
    const shouting = gradeToolchainScope(
      corpus({ slots: [slot({ network: 'SomeChain' })] })
    )
    expect({
      refusals: shouting.refusals,
      byRule: shouting.byRule,
    }).toEqual({ refusals: 0, byRule: [] })

    // The second call site, which the refusal count cannot see: the
    // uncovered-network list normalises too, or it names a network as
    // uncovered that a corpus row does cover.
    expect(shouting.coverageNote).toContain('1 of 2 configured networks')
    expect(shouting.coverageNote).not.toContain('somechain')

    // The present that pairs with it: a network no config row names still
    // refuses, so the normalisation did not make G1 unable to refuse at all.
    const absent = gradeToolchainScope(
      corpus({ slots: [slot({ network: 'NoSuchChain' })] })
    )
    expect(absent.refusals).toBe(1)
  })

  it('names every configured network no attested slot covers', () => {
    const note = gradeToolchainScope(
      corpus({ slots: [slot({ network: 'somechain' })] })
    ).coverageNote
    expect(note).toContain('1 of 2 configured networks carry none')
    expect(note).toContain('oldchain')
    expect(note).not.toContain('somechain')
  })

  // The zk exclusion is the sweep's own count, not a number written into the
  // note. A corpus that records a different one has to move it, and a corpus
  // that records none must not have one invented on its behalf.
  it('reports the zk exclusion the corpus records, and says so when it records none', () => {
    expect(
      gradeAttestedSet(corpus({ zkEvmSlotsExcluded: 9 })).coverageNote
    ).toContain('excluded 9 zkEVM slots')

    expect(
      gradeAttestedSet(corpus({ zkEvmSlotsExcluded: undefined })).coverageNote
    ).toContain('excluded an unrecorded number of zkEVM slots')
  })

  // Two decisions no refusal count moves with, so only a test can hold them.
  // The provenance is one G2's note reasons from, and the re-admitted
  // denominator is a number the note used to state as a constant.
  it('mints the provenance production mints, and derives the re-admitted count', async () => {
    expect(HARNESS_PROVENANCE).toBe('A-LOCAL')

    const registered = slot({ network: 'somechain' })
    const logs = {
      readLog: (path: string) =>
        path.endsWith('.diamond.json')
          ? {
              LiFiDiamond: { Facets: { [registered.address]: { Name: 'X' } } },
            }
          : { X: registered.address },
    }
    const deprecated = slot({ contractName: 'Gone', version: '2.0.0' })

    // One graded row, one held out as deprecated: the note has to say 2 where
    // the denominator says 1, or it is not deriving anything.
    const note = (
      await gradeFunnelDeployGate(
        corpus({
          ...logs,
          slots: [registered, deprecated],
          deprecatedContracts: new Set(['Gone']),
        })
      )
    ).coverageNote
    expect(note).toContain('this gate grades 2 rows instead')

    const none = (
      await gradeFunnelDeployGate(
        corpus({ ...logs, slots: [registered], deprecatedContracts: new Set() })
      )
    ).coverageNote
    expect(none).toContain('this gate grades 1 rows instead')
  })

  it('says whether commits were unreadable rather than asserting they were not', () => {
    const clean = gradeCommitAvailability(corpus())
    expect(clean.coverageNote).toContain('0 of them unreadable')
    expect(clean.coverageNote).toContain('measured on 0')

    const truncated = gradeCommitAvailability(
      corpus({ hasCommit: () => false })
    )
    expect(truncated.coverageNote).toContain('1 of them unreadable')
    expect(truncated.coverageNote).toContain(
      'measure this checkout, not the gate'
    )
  })
})

describe('a zksolc-only pin is not a pin any EVM network is offered', () => {
  // Inert today because [profile.zksync] happens to pin the same pair as
  // [profile.default]. It stops being inert the moment they diverge, and then
  // the class a retired EVM build is filed under turns on this filter.
  const ZK_DIVERGED = [
    TOML,
    '',
    '[profile.zksync]',
    "solc_version = '0.8.26'",
    "evm_version = 'cancun'",
    '',
    '[external.zksync]',
    'zksolc = "1.5.15"',
  ].join('\n')

  it('files a retired EVM build under AFR-1, not AFR-2, when only the zk profile pins its pair', () => {
    const profiles = parseBuildProfiles(ZK_DIVERGED)
    expect(profiles['zksync']?.zksolcVersion).toBe('1.5.15')
    expect(profiles['zksync']?.solcVersion).toBe('0.8.26')

    const budget = gradeAttestedSet(
      corpus({
        foundryToml: ZK_DIVERGED,
        slots: [slot({ solcVersion: '0.8.26', evmVersion: 'cancun' })],
      })
    )
    expect(budget.refusals).toBe(1)
    expect(budget.byRule).toEqual([['AFR-1-retired-pin', 1]])
  })
})

describe('falsification demo — the runner can report a defect', () => {
  it('reports nothing when every slot reproduces at the profile the gate offers', () => {
    const budget = gradeAttestedSet(
      corpus({ slots: [slot(), slot({ contractName: 'OtherFacet' })] })
    )
    expect(budget.refusals).toBe(0)
  })

  // Plant 1: a slot whose reproducing compiler is one no profile pins.
  it('surfaces a retired-pin slot, and stops surfacing it once removed', () => {
    const planted = slot({ solcVersion: '0.8.26', evmVersion: 'cancun' })
    const withPlant = gradeAttestedSet(corpus({ slots: [slot(), planted] }))
    expect(withPlant.refusals).toBe(1)
    expect(withPlant.byRule).toEqual([['AFR-1-retired-pin', 1]])

    const withoutPlant = gradeAttestedSet(corpus({ slots: [slot()] }))
    expect(withoutPlant.refusals).toBe(0)
    expect(withoutPlant.byRule).toEqual([])
  })

  // Plant 2: a slot built at the other pinned profile, on a network whose
  // config selects only one of them. This is the MayanFacet shape.
  it('surfaces a cross-profile slot, and stops surfacing it once removed', () => {
    const planted = slot({ solcVersion: '0.8.17', evmVersion: 'london' })
    const withPlant = gradeAttestedSet(corpus({ slots: [planted] }))
    expect(withPlant.refusals).toBe(1)
    expect(withPlant.byRule).toEqual([['AFR-2-cross-profile-network', 1]])

    // Removed by moving the same slot to the network whose config names its
    // lineage, rather than by deleting the row — a plant that only disappears
    // when the row does proves nothing about the gate.
    const moved = gradeAttestedSet(
      corpus({ slots: [slot({ ...planted, network: 'oldchain' })] })
    )
    expect(moved.refusals).toBe(0)
  })

  // Plant 3: a config row whose two flags contradict each other. This one is
  // the grey class, so it must surface AND stay promotable.
  it('surfaces an unresolvable network, and grades it grey', () => {
    const budget = gradeToolchainScope(
      corpus({
        networks: {
          somechain: { targetEvmVersion: 'n/a', isZkEVM: false },
        },
      })
    )
    expect(budget.refusals).toBe(1)
    expect(budget.byRule).toEqual([['AFR-3-unresolvable-network', 1]])
    expect(evaluatePromotion(budget).mayEnforce).toBe(true)
  })

  // The budget counts gate verdicts. An address this runner cannot encode is
  // the runner failing to build an input, so it has to abort rather than
  // arrive as a refusal wearing the gate's name — that is how a tron row would
  // otherwise spend the unexplained budget on a viem error.
  it('aborts rather than charging the gate for calldata it could not encode', async () => {
    const base58 = slot({
      network: 'somechain',
      address: 'TViNVAJsVwfsL96yS8RqYMzg6uB9JmAYWn',
    })
    const logs = (s: ICorpusSlot): Partial<ICorpusDeps> => ({
      slots: [s],
      readLog: (path) =>
        path.endsWith('.diamond.json')
          ? { LiFiDiamond: { Facets: { [s.address]: { Name: 'SomeFacet' } } } }
          : { SomeFacet: s.address },
    })

    // Bun's `.rejects` is not a real Promise; see 402-typescript-tests
    // [CONV:TEST-ASSERT-REJECTS].
    let thrown: unknown
    try {
      await gradeFunnelDeployGate(corpus(logs(base58)))
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error ? thrown.message : thrown).toMatch(
      /is invalid/
    )

    // The paired present: an address it can encode is graded, not thrown.
    const encodable = await gradeFunnelDeployGate(
      corpus(logs(slot({ network: 'somechain' })))
    )
    expect({
      denominator: encodable.denominator,
      refusals: encodable.refusals,
    }).toEqual({ denominator: 1, refusals: 0 })
  })

  // Plant 4: the one that matters most, driven end to end through the real
  // funnel gate. A refusal no named class covers has to reach the budget as
  // unexplained; if it were swept into the nearest named class the count would
  // be structurally unreachable and the whole report decoration.
  it('counts a refusal the enumeration does not cover as unexplained', async () => {
    const registered = slot({ network: 'somechain' })
    const diamondLog = {
      LiFiDiamond: { Facets: { [registered.address]: { Name: 'SomeFacet' } } },
    }
    const deploymentLog = { SomeFacet: registered.address }
    const withPlant = await gradeFunnelDeployGate(
      corpus({
        slots: [registered],
        readLog: (path) =>
          path.endsWith('.diamond.json') ? diamondLog : deploymentLog,
        // The plant: the live facet's source is not on this checkout.
        facetSourceExists: () => false,
      })
    )
    expect(withPlant.denominator).toBe(1)
    expect(withPlant.refusals).toBe(1)
    expect(withPlant.unexplained).toBe(1)
    expect(withPlant.adjudications[0]?.reason).toContain(
      'has no facet source at src/Facets/SomeFacet.sol'
    )
    expect(evaluatePromotion(withPlant).mayEnforce).toBe(false)

    // Removed: the same slot, the same gate, the source present.
    const withoutPlant = await gradeFunnelDeployGate(
      corpus({
        slots: [registered],
        readLog: (path) =>
          path.endsWith('.diamond.json') ? diamondLog : deploymentLog,
        facetSourceExists: () => true,
      })
    )
    expect(withoutPlant.denominator).toBe(1)
    expect(withoutPlant.refusals).toBe(0)
    expect(evaluatePromotion(withoutPlant).mayEnforce).toBe(true)
  })

  // Plant 5: the false-GREEN direction. A runner whose numerator does not move
  // with the input reports a constant, not a measurement.
  it('reports 100% when no slot reproduces at an offered profile', () => {
    const budget = gradeAttestedSet(
      corpus({
        slots: [
          slot({ solcVersion: '0.8.26' }),
          slot({ solcVersion: '0.8.28' }),
          slot({ solcVersion: '0.8.17', evmVersion: 'london' }),
        ],
      })
    )
    expect(budget.falseRefusalRate).toBe(1)
  })

  it('surfaces an unreadable commit on the commit-availability gate', () => {
    const withPlant = gradeCommitAvailability(
      corpus({ hasCommit: () => false })
    )
    expect(withPlant.refusals).toBe(1)
    expect(withPlant.unexplained).toBe(1)
    expect(evaluatePromotion(withPlant).mayEnforce).toBe(false)

    const withoutPlant = gradeCommitAvailability(corpus())
    expect(withoutPlant.refusals).toBe(0)
    expect(evaluatePromotion(withoutPlant).mayEnforce).toBe(true)
  })
})

describe('regression fixture — EXSC-920, the 10x-inflated fee-limit comparison', () => {
  let originalAllow: string | undefined

  beforeEach(() => {
    // Set rather than deleted: `delete` makes bun hand back whatever `.env`
    // holds, and this escape hatch downgrades every refusal below to a warning,
    // which would make the fixture pass while observing nothing.
    originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = ''
  })

  afterEach(() => {
    if (originalAllow === undefined)
      delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
  })

  /** 6,000,000 raw energy — the cut the guard refused — at 100 SUN per unit. */
  const RAW_ENERGY = 6_000_000
  const SUN_PER_ENERGY = 100n

  it('does not refuse a 720 TRX cut against the 5,000 TRX limit', async () => {
    const estimated = applyTronSafetyMargin(RAW_ENERGY)
    expect(estimated).toBe(7_200_000n)

    const result = await assertTronBroadcastAffordable(
      async () => ({
        estimatedResource: estimated,
        resourceLabel: 'energy',
        estimateFailed: false,
      }),
      {
        networkName: 'tron',
        operation: 'diamondCut registering 3 facets',
        feeLimitSun: DIAMOND_CUT_FEE_LIMIT_SUN,
        costInSun: async (energy) => energy * SUN_PER_ENERGY,
      }
    )

    expect(result.costSun).toBe(720_000_000n)
    expect(result.costSun).toBeLessThan(BigInt(DIAMOND_CUT_FEE_LIMIT_SUN))
  })

  // The paired absence: the figure the guard used to compare is the one that
  // refuses. Without this the row above would pass against any margin at all.
  it('would have refused the same cut at the 10x margin the guard used', async () => {
    let refusal: string | undefined
    try {
      await assertTronBroadcastAffordable(
        async () => ({
          estimatedResource: BigInt(RAW_ENERGY * 10),
          resourceLabel: 'energy',
          estimateFailed: false,
        }),
        {
          networkName: 'tron',
          operation: 'diamondCut registering 3 facets',
          feeLimitSun: DIAMOND_CUT_FEE_LIMIT_SUN,
          costInSun: async (energy) => energy * SUN_PER_ENERGY,
        }
      )
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    expect(refusal).toBeDefined()
    expect(refusal).toContain('6000000000')
  })
})

describe('regression fixture — EXSC-906, the version to profile fallback', () => {
  const profiles = parseBuildProfiles(TOML)

  it('grades an honest london deploy against the london profile, not the default', () => {
    const scope = deriveToolchainScope('oldchain', {
      networks: { oldchain: { targetEvmVersion: 'london', isZkEVM: false } },
      profiles,
    })
    expect(
      scope.profiles.map((p) => `${p.solcVersion}/${p.evmVersion}`)
    ).toEqual(['0.8.17/london'])
  })

  it('refuses rather than falling back when no profile pins the hardfork', () => {
    expect(() =>
      deriveToolchainScope('newchain', {
        networks: { newchain: { targetEvmVersion: 'prague', isZkEVM: false } },
        profiles,
      })
    ).toThrow(/no foundry.toml profile pins/)
  })
})

describe('false-GREEN probe — the widening vector the MayanFacet fix would open', () => {
  const profiles = parseBuildProfiles(TOML)

  /**
   * The input class a relaxation would start trusting: the compiler pair named
   * by the record whose commit the proposer chose. D3 asserts commit presence,
   * not ancestry, so a proposer can point a record at any fetchable commit —
   * which under a "read foundry.toml at the record's commit" fix would let them
   * pick the lineage they are graded against.
   *
   * This probe pins that door shut: the scope of legitimate builds is a
   * function of the network row and today's foundry.toml, and adding a
   * record-supplied profile to the call changes nothing about the answer.
   */
  it('offers a network only the lineage its config names, never one merely pinned', () => {
    // `solc_floor` IS pinned and IS a legitimate lineage for the fleet: it is
    // the pair the largest class of attested slots reproduces under. What
    // decides whether this network is graded against it is the network row, and
    // nothing else. A fix reading foundry.toml at the record's own commit would
    // hand that decision to whoever chose the commit.
    expect(Object.keys(profiles)).toContain('solc_floor')

    const scope = deriveToolchainScope('somechain', {
      networks: { somechain: { targetEvmVersion: 'cancun', isZkEVM: false } },
      profiles,
    })
    expect(scope.isClosedSet).toBe(true)
    expect(scope.profiles.map((p) => p.profile)).toEqual(['default'])

    // The paired present: the same available profile IS offered to the network
    // whose row names it, so the assertion above is about the row and not
    // about `solc_floor` being unreachable everywhere.
    const london = deriveToolchainScope('oldchain', {
      networks: { oldchain: { targetEvmVersion: 'london', isZkEVM: false } },
      profiles,
    })
    expect(london.profiles.map((p) => p.profile)).toEqual(['solc_floor'])
  })

  it('still refuses a slot whose record names a lineage the network does not', () => {
    const budget = gradeAttestedSet(
      corpus({ slots: [slot({ solcVersion: '0.8.17', evmVersion: 'london' })] })
    )
    expect(budget.refusals).toBe(1)
    // A relaxation that made this row pass would have to be paired with a
    // probe showing a tampered record cannot reach the same outcome. No
    // relaxation ships in this package, so the row stays refused and named.
    expect(budget.byRule).toEqual([['AFR-2-cross-profile-network', 1]])
  })
})
