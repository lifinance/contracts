/**
 * The calldata address check, exercised against the repo's real deployment data.
 *
 * Three properties carry more weight than the happy path. **Real current data
 * still passes** — a check that refused everything would satisfy every refusal
 * case below while blocking every honest proposal. **An unanswerable question is
 * not a pass** — an unreadable store, a source that lags, a call the extractor
 * could not open, or an address nobody looked up all have to be distinguishable
 * from a clean resolution. And **the repo deployment files are not the record**:
 * one real facet, `SymbiosisFacet` on mainnet, is missing from the repo files in
 * one version and from the deployment-log export in the other, which is why the
 * source of the entries is itself judged.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import deploymentLogExport from '../../../deployments/_deployments_log_file.json'
import diamondLog from '../../../deployments/mainnet.diamond.json'
import type { IDeploymentRecord } from '../shared/mongo-log-utils'

import {
  AddressGradeEnum,
  AddressRoleEnum,
  DeploymentIndexSourceEnum,
  assertCalldataAddressesResolve,
  evaluateCalldataAddresses,
  renderCalldataAddresses,
  type IAddressReference,
  type IDeploymentIndex,
  type IDeploymentIndexEntry,
  type IExpectedIdentity,
} from './calldata-address-check'

/**
 * `SymbiosisFacet@1.0.0` on mainnet: the only mainnet row the export carries
 * for that facet, and in neither repo deployment file. The repo files are
 * current-address maps, so they carry whatever version mainnet runs now and
 * nothing else — which is what a repo file that has not caught up with an
 * address looks like, and at sign time that is every address a proposal is
 * about.
 */
const RECORDED_NOT_IN_REPO_FILES = '0x23Fc1b73e66Cd13e988170CB94e252Cb7FF88185'

/**
 * `SymbiosisFacet@2.0.0` on mainnet: the version currently installed there,
 * carried by both repo deployment files and absent from the export entirely.
 * The same facet as above, in the opposite direction.
 */
const IN_REPO_FILES_NOT_IN_EXPORT = '0xa0353221443CA4E2e6A040F30A57B47F5A6d479D'

/** A real facet the record holds on mainnet only. */
const MAINNET_ONLY_FACET = '0xC4E5F14dfE359653D66AE49B1f12177e6f99102b'

/** A real facet the record holds on mainnet and eighteen other networks. */
const FLEET_WIDE_FACET = '0x4bEAa5D26300e81cd17e0981fc15494Bb4B10959'

/**
 * Every production deployment the committed export carries, as record-shaped
 * tuples.
 *
 * Read from `deployments/_deployments_log_file.json` because it is the only
 * export of the deploy log inside the repository, and the tuples in it are the
 * real ones. Tests below that declare these `DeploymentRecord` are exercising
 * the resolution predicate on real values, not claiming the export is the
 * record — the provenance predicate has its own cases, and they hold the export
 * to the source it actually is.
 */
const realProductionEntries = ((): IDeploymentIndexEntry[] => {
  const entries: IDeploymentIndexEntry[] = []
  const log = deploymentLogExport as unknown as Record<
    string,
    Record<string, Record<string, Record<string, { ADDRESS?: string }[]>>>
  >
  for (const [contractName, byNetwork] of Object.entries(log))
    for (const [network, byEnvironment] of Object.entries(byNetwork))
      for (const [version, rows] of Object.entries(
        byEnvironment.production ?? {}
      ))
        for (const row of rows)
          if (typeof row.ADDRESS === 'string')
            entries.push({
              contractName,
              network,
              version,
              address: row.ADDRESS,
            })
  return entries
})()

/** Every address the repo's mainnet diamond file lists, facets and periphery. */
const repoFileEntries = ((): IDeploymentIndexEntry[] => {
  const { Facets, Periphery } = (
    diamondLog as unknown as {
      LiFiDiamond: {
        Facets: Record<string, { Name: string; Version: string }>
        Periphery: Record<string, string>
      }
    }
  ).LiFiDiamond
  return [
    ...Object.entries(Facets).map(([address, facet]) => ({
      contractName: facet.Name,
      network: 'mainnet',
      version: facet.Version,
      address,
    })),
    ...Object.entries(Periphery).map(([contractName, address]) => ({
      contractName,
      network: 'mainnet',
      version: '',
      address,
    })),
  ]
})()

const recordIndex = (
  addresses: readonly string[],
  entries: readonly IDeploymentIndexEntry[] = realProductionEntries
): IDeploymentIndex => ({
  source: DeploymentIndexSourceEnum.DeploymentRecord,
  available: true,
  queried: addresses.map((address) => address.toLowerCase()),
  entries,
})

const facetAdd = (
  address: string,
  path = 'call[0].cuts[0]'
): IAddressReference => ({
  address,
  role: AddressRoleEnum.FacetAdd,
  path,
})

const expectations = (
  ...pairs: [string, IExpectedIdentity][]
): ReadonlyMap<string, IExpectedIdentity> =>
  new Map(pairs.map(([address, identity]) => [address.toLowerCase(), identity]))

describe('evaluateCalldataAddresses against the real deployment record', () => {
  it('resolves real facet addresses to the name and version the record holds', () => {
    // The paired positive. Every case after this one is a refusal or an error,
    // so without it they would all pass while the check blocked every proposal.
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          facetAdd(MAINNET_ONLY_FACET, 'call[0].cuts[0]'),
          facetAdd(FLEET_WIDE_FACET, 'call[0].cuts[1]'),
        ],
        expectations: expectations(
          [
            MAINNET_ONLY_FACET,
            { contractName: 'CBridgeFacet', version: '1.0.0' },
          ],
          [
            FLEET_WIDE_FACET,
            { contractName: 'DexManagerFacet', version: '1.0.0' },
          ]
        ),
      },
      recordIndex([MAINNET_ONLY_FACET, FLEET_WIDE_FACET])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings.map((finding) => finding.grade)).toEqual([
      AddressGradeEnum.Resolved,
      AddressGradeEnum.Resolved,
    ])
    expect(() => assertCalldataAddressesResolve(verdict)).not.toThrow()
  })

  it('refuses an address the record holds nowhere', () => {
    // One hex digit of the real address above, changed. The typo class is the
    // whole point of the check, and the record holds no such deployment.
    const typo = MAINNET_ONLY_FACET.replace(/b$/, 'c')
    expect(typo).not.toBe(MAINNET_ONLY_FACET)
    expect(
      realProductionEntries.some(
        (entry) => entry.address.toLowerCase() === typo.toLowerCase()
      )
    ).toBe(false)

    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd(typo)] },
      recordIndex([typo])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Unknown)
    expect(verdict.reason).toContain('no deployment record on any network')
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('refuses a real address deployed on another network', () => {
    const verdict = evaluateCalldataAddresses(
      { network: 'arbitrum', references: [facetAdd(MAINNET_ONLY_FACET)] },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.WrongNetwork)
    expect(verdict.reason).toContain('CBridgeFacet@1.0.0 on mainnet')
  })

  it('refuses a real address whose recorded name is not the expected one', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(FLEET_WIDE_FACET)],
        expectations: expectations([
          FLEET_WIDE_FACET,
          { contractName: 'OwnershipFacet' },
        ]),
      },
      recordIndex([FLEET_WIDE_FACET])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NameMismatch)
    expect(verdict.reason).toContain('DexManagerFacet@1.0.0 on mainnet')
  })

  it('refuses a real address whose recorded version is not the expected one', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(FLEET_WIDE_FACET)],
        expectations: expectations([
          FLEET_WIDE_FACET,
          { contractName: 'DexManagerFacet', version: '1.0.1' },
        ]),
      },
      recordIndex([FLEET_WIDE_FACET])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.VersionMismatch)
  })

  it('errors on an install whose identity no anchor supplied', () => {
    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd(FLEET_WIDE_FACET)] },
      recordIndex([FLEET_WIDE_FACET])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.refuses).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.IdentityUnchecked)
    expect(verdict.errors.join(' ')).toContain('reported and not verified')
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('reports rather than verifies the identity of a removal target', () => {
    // The pair for the case above: the same missing expectation, in the one
    // role T2 forbids blocking, has to stay a warning or the error would be a
    // blanket refusal of every proposal that omits the map.
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: FLEET_WIDE_FACET,
            role: AddressRoleEnum.FacetRemove,
            path: 'call[0].cuts[0]',
          },
        ],
      },
      recordIndex([FLEET_WIDE_FACET])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.IdentityUnchecked)
    expect(verdict.warnings.join(' ')).toContain('reported and not verified')
    expect(() => assertCalldataAddressesResolve(verdict)).not.toThrow()
  })
})

describe('a broad expectation and a narrow one for the same address', () => {
  it('agree, because an absent version means any version', () => {
    // `version` is checked only when present, so a name-only anchor and a
    // name-plus-version one narrow rather than contradict. Merging exactly
    // those two is the shape a caller assembling this map produces.
    const expectations = new Map([
      [MAINNET_ONLY_FACET, { contractName: 'CBridgeFacet' }],
      [
        MAINNET_ONLY_FACET.toLowerCase(),
        { contractName: 'CBridgeFacet', version: '1.0.0' },
      ],
    ])

    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations,
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.error).toBe(false)
    expect(verdict.refuses).toBe(false)
  })

  it('cannot decide when the two state different versions, so it errors', () => {
    // Paired presence: only two *stated* versions can disagree, and when they
    // do the identity is genuinely undecided. That is `error`, not `refuses` —
    // nothing here contradicts the record, the check just has no answer, and
    // the two outcomes are the distinction this module is built on.
    const expectations = new Map([
      [MAINNET_ONLY_FACET, { contractName: 'CBridgeFacet', version: '1.0.0' }],
      [
        MAINNET_ONLY_FACET.toLowerCase(),
        { contractName: 'CBridgeFacet', version: '2.0.0' },
      ],
    ])

    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations,
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.refuses).toBe(false)
  })
})

describe('the expectations map is checked before it is trusted', () => {
  it('matches a checksummed key, so the name check the caller asked for happens', () => {
    // The helpers that hand back an address return the checksummed form, which
    // is what MAINNET_ONLY_FACET is written as here, while references arrive
    // lowercased. A map keyed that way has to reach the name comparison; if it
    // does not, this address grades identity-unchecked and the wrong name below
    // goes unnoticed.
    expect(MAINNET_ONLY_FACET).not.toBe(MAINNET_ONLY_FACET.toLowerCase())

    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: new Map([
          [MAINNET_ONLY_FACET, { contractName: 'OwnershipFacet' }],
        ]),
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NameMismatch)
    expect(verdict.reason).toContain('CBridgeFacet@1.0.0 on mainnet')
  })

  it('resolves a checksummed key that names the recorded contract', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: new Map([
          [
            MAINNET_ONLY_FACET,
            { contractName: 'CBridgeFacet', version: '1.0.0' },
          ],
        ]),
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Resolved)
  })

  it('errors on a key that is not an address instead of ignoring it', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: new Map([
          ['CBridgeFacet', { contractName: 'CBridgeFacet', version: '1.0.0' }],
        ]),
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain(
      'keyed with "CBridgeFacet", which is not a 20-byte hex address'
    )
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('errors when two keys for one address disagree about its identity', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: new Map([
          [
            MAINNET_ONLY_FACET,
            { contractName: 'CBridgeFacet', version: '1.0.0' },
          ],
          [
            MAINNET_ONLY_FACET.toLowerCase(),
            { contractName: 'CBridgeFacet', version: '2.0.0' },
          ],
        ]),
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('is not decided')
  })
})

describe('the source of the entries is itself judged', () => {
  it('will not decide on the repo deployment files, which lag until after execution', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(RECORDED_NOT_IN_REPO_FILES)],
      },
      {
        source: DeploymentIndexSourceEnum.RepoDeploymentsFile,
        available: true,
        queried: [RECORDED_NOT_IN_REPO_FILES.toLowerCase()],
        entries: repoFileEntries,
      }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.refuses).toBe(false)
    expect(verdict.errors.join(' ')).toContain('merges to main only after')
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('will not decide on the deployment-log export, which omits recent contracts', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(IN_REPO_FILES_NOT_IN_EXPORT)],
      },
      {
        source: DeploymentIndexSourceEnum.DeploymentLogExport,
        available: true,
        queried: [IN_REPO_FILES_NOT_IN_EXPORT.toLowerCase()],
        entries: realProductionEntries,
      }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('omits recent contracts')
  })

  it('will not decide on a source it has no provenance argument for', () => {
    // A source the module has no provenance argument for — an attested index, a
    // cache, a Tron log added to the enum later — may not decide an address,
    // even one that resolves cleanly against real entries.
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: expectations([
          MAINNET_ONLY_FACET,
          { contractName: 'CBridgeFacet', version: '1.0.0' },
        ]),
      },
      {
        source: 'attested-build-index' as DeploymentIndexSourceEnum,
        available: true,
        queried: [MAINNET_ONLY_FACET.toLowerCase()],
        entries: realProductionEntries,
      }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain(
      '"attested-build-index" is not a source this check has a provenance argument for'
    )
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('decides on the deployment record, on the same input', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: expectations([
          MAINNET_ONLY_FACET,
          { contractName: 'CBridgeFacet', version: '1.0.0' },
        ]),
      },
      {
        source: DeploymentIndexSourceEnum.DeploymentRecord,
        available: true,
        queried: [MAINNET_ONLY_FACET.toLowerCase()],
        entries: realProductionEntries,
      }
    )

    expect(verdict.error).toBe(false)
    expect(verdict.refuses).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Resolved)
  })

  it('is not a theoretical concern: one real facet is missing from each file, in opposite directions', () => {
    const inRepoFiles = new Set(
      repoFileEntries.map((entry) => entry.address.toLowerCase())
    )
    const inExport = new Set(
      realProductionEntries.map((entry) => entry.address.toLowerCase())
    )

    // SymbiosisFacet@1.0.0: recorded on mainnet, in neither repo file, so a
    // repo-file-sourced index calls a genuinely-deployed facet unknown.
    expect(inExport.has(RECORDED_NOT_IN_REPO_FILES.toLowerCase())).toBe(true)
    expect(inRepoFiles.has(RECORDED_NOT_IN_REPO_FILES.toLowerCase())).toBe(
      false
    )

    // SymbiosisFacet@2.0.0, the version mainnet runs: in the repo files and
    // absent from the export, so the export cannot rule out an address either.
    expect(inRepoFiles.has(IN_REPO_FILES_NOT_IN_EXPORT.toLowerCase())).toBe(
      true
    )
    expect(inExport.has(IN_REPO_FILES_NOT_IN_EXPORT.toLowerCase())).toBe(false)
  })

  it('grades the same real address unknown when the repo file is trusted as the record', () => {
    // The false red the source guard exists to prevent, shown rather than
    // asserted: the guard is bypassed by labelling the repo file's entries as
    // record-sourced, which is precisely the wiring mistake.
    const asRecord = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(RECORDED_NOT_IN_REPO_FILES)],
      },
      recordIndex([RECORDED_NOT_IN_REPO_FILES], repoFileEntries)
    )

    expect(asRecord.refuses).toBe(true)
    expect(asRecord.findings[0]?.grade).toBe(AddressGradeEnum.Unknown)

    // The same address, the same reference, resolved against the record.
    const againstRecord = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(RECORDED_NOT_IN_REPO_FILES)],
        expectations: expectations([
          RECORDED_NOT_IN_REPO_FILES,
          { contractName: 'SymbiosisFacet', version: '1.0.0' },
        ]),
      },
      recordIndex([RECORDED_NOT_IN_REPO_FILES])
    )

    expect(againstRecord.refuses).toBe(false)
    expect(againstRecord.findings[0]?.grade).toBe(AddressGradeEnum.Resolved)
  })
})

describe('a question that cannot be answered is not answered yes', () => {
  it('errors when the record could not be read', () => {
    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd(MAINNET_ONLY_FACET)] },
      {
        source: DeploymentIndexSourceEnum.DeploymentRecord,
        available: false,
        unavailableReason: 'connection to the deployment record timed out',
        queried: [],
        entries: [],
      }
    )

    expect(verdict.error).toBe(true)
    expect(verdict.refuses).toBe(false)
    expect(verdict.errors.join(' ')).toContain('timed out')
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NotQueried)
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('errors on an address the store was never asked about, rather than calling it unknown', () => {
    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd(MAINNET_ONLY_FACET)] },
      recordIndex([])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NotQueried)
    expect(verdict.errors.join(' ')).toContain('never looked up')
  })

  it('errors when a call could not be read all the way through', () => {
    // The envelope class: a batch pairing one readable cut with one unreadable
    // wrapper must not pass because the readable half resolved.
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: expectations([
          MAINNET_ONLY_FACET,
          { contractName: 'CBridgeFacet', version: '1.0.0' },
        ]),
        undecodable: ['call[1]'],
      },
      recordIndex([MAINNET_ONLY_FACET])
    )

    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Resolved)
    expect(verdict.error).toBe(true)
    expect(verdict.errors.join(' ')).toContain('may reference others')
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow()
  })

  it('refuses a value that is not an address instead of skipping it', () => {
    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd('0xdeadbeef')] },
      recordIndex(['0xdeadbeef'])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Malformed)
  })
})

describe('the zero address, by role', () => {
  it('accepts it as a cut with no init calldata', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: '0x0000000000000000000000000000000000000000',
            role: AddressRoleEnum.CutInit,
            path: 'call[0]._init',
          },
        ],
      },
      recordIndex(['0x0000000000000000000000000000000000000000'])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NotApplicable)
  })

  it('accepts it as a removal target, which is the only value LibDiamond allows there', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: '0x0000000000000000000000000000000000000000',
            role: AddressRoleEnum.FacetRemove,
            path: 'call[0].cuts[0]',
          },
        ],
      },
      recordIndex(['0x0000000000000000000000000000000000000000'])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NotApplicable)
  })

  it('refuses it as a facet the cut would install', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd('0x0000000000000000000000000000000000000000')],
      },
      recordIndex(['0x0000000000000000000000000000000000000000'])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.IllegalZero)
  })

  it('refuses it as a periphery registration', () => {
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: '0x0000000000000000000000000000000000000000',
            role: AddressRoleEnum.PeripheryRegistration,
            path: 'call[0].registerPeripheryContract',
          },
        ],
      },
      recordIndex(['0x0000000000000000000000000000000000000000'])
    )

    expect(verdict.refuses).toBe(true)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.IllegalZero)
  })
})

describe('removals warn where installs refuse', () => {
  it('does not refuse an unrecorded removal target', () => {
    const typo = MAINNET_ONLY_FACET.replace(/b$/, 'c')
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: typo,
            role: AddressRoleEnum.FacetRemove,
            path: 'call[0].cuts[0]',
          },
        ],
      },
      recordIndex([typo])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Unknown)
    expect(verdict.warnings).toHaveLength(1)
  })

  it('refuses the same unrecorded address in an install role', () => {
    // Paired with the case above: without it, "removals warn" would be
    // indistinguishable from "nothing ever refuses".
    const typo = MAINNET_ONLY_FACET.replace(/b$/, 'c')
    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd(typo)] },
      recordIndex([typo])
    )

    expect(verdict.refuses).toBe(true)
  })

  it('does not error on a removal target nobody looked up', () => {
    // A narrower query must not turn the warn-only removal policy into a block:
    // T2 puts subtractive operations outside the gate however little is known
    // about what they remove, and a rollback is the time-critical path.
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: MAINNET_ONLY_FACET,
            role: AddressRoleEnum.FacetRemove,
            path: 'call[0].cuts[0]',
          },
        ],
      },
      recordIndex([])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.errors).toHaveLength(0)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.NotQueried)
    expect(verdict.warnings.join(' ')).toContain('never looked up')
    expect(() => assertCalldataAddressesResolve(verdict)).not.toThrow()
  })

  it('errors on a role it has no refusal policy for, rather than warning', () => {
    // Neither role set names it, so whether failing to resolve it refuses has
    // no answer — which is an unanswerable question, not a pass.
    const typo = MAINNET_ONLY_FACET.replace(/b$/, 'c')
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: typo,
            role: 'timelock-admin-grant' as AddressRoleEnum,
            path: 'call[0].grantRole',
          },
        ],
      },
      recordIndex([typo])
    )

    expect(verdict.error).toBe(true)
    expect(verdict.warnings).toHaveLength(0)
    expect(verdict.errors.join(' ')).toContain(
      'is in role "timelock-admin-grant", which this check has no refusal policy for'
    )
    expect(() => assertCalldataAddressesResolve(verdict)).toThrow(
      /will not be signed/
    )
  })

  it('warns rather than errors on the removal role it does name', () => {
    // The pair for the case above: the unrecognised-role error must not be a
    // blanket refusal of every role outside the refusal-bearing set.
    const typo = MAINNET_ONLY_FACET.replace(/b$/, 'c')
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: typo,
            role: AddressRoleEnum.FacetRemove,
            path: 'call[0].cuts[0]',
          },
        ],
      },
      recordIndex([typo])
    )

    expect(verdict.error).toBe(false)
    expect(verdict.warnings).toHaveLength(1)
  })

  it('refuses an unrecorded init target, which runs against the diamond storage', () => {
    const typo = MAINNET_ONLY_FACET.replace(/b$/, 'c')
    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [
          {
            address: typo,
            role: AddressRoleEnum.CutInit,
            path: 'call[0]._init',
          },
        ],
      },
      recordIndex([typo])
    )

    expect(verdict.refuses).toBe(true)
  })
})

describe('renderCalldataAddresses', () => {
  it('says how many resolved rather than staying silent on a clean verdict', () => {
    const lines = renderCalldataAddresses(
      evaluateCalldataAddresses(
        {
          network: 'mainnet',
          references: [facetAdd(MAINNET_ONLY_FACET)],
          expectations: expectations([
            MAINNET_ONLY_FACET,
            { contractName: 'CBridgeFacet', version: '1.0.0' },
          ]),
        },
        recordIndex([MAINNET_ONLY_FACET])
      )
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1 of 1')
  })

  it('says nothing needed resolving rather than ticking zero of zero', () => {
    const lines = renderCalldataAddresses(
      evaluateCalldataAddresses(
        { network: 'mainnet', references: [] },
        recordIndex([])
      )
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\S+ Calldata address check skipped: no call in this proposal references an address\.$/
    )
  })

  it('names the refused address and the record it contradicts', () => {
    const lines = renderCalldataAddresses(
      evaluateCalldataAddresses(
        { network: 'arbitrum', references: [facetAdd(MAINNET_ONLY_FACET)] },
        recordIndex([MAINNET_ONLY_FACET])
      )
    )

    expect(lines.join('\n')).toContain('REFUSED')
    expect(lines.join('\n')).toContain(MAINNET_ONLY_FACET)
    expect(lines.join('\n')).toContain('not on arbitrum')
  })

  it('distinguishes a check that could not run from one that passed', () => {
    const lines = renderCalldataAddresses(
      evaluateCalldataAddresses(
        { network: 'mainnet', references: [facetAdd(MAINNET_ONLY_FACET)] },
        {
          source: DeploymentIndexSourceEnum.DeploymentRecord,
          available: false,
          unavailableReason: 'tunnel closed',
          queried: [],
          entries: [],
        }
      )
    )

    expect(lines.join('\n')).toContain('CANNOT CHECK')
    expect(lines.join('\n')).not.toContain('resolved to the deployment record')
  })
})

describe('the index shape the record satisfies', () => {
  it('accepts a deployment record as an index entry without a conversion', () => {
    // A compile-time claim, checked here rather than in the module so the module
    // does not import the Mongo driver's types: if `IDeploymentRecord` drifts
    // away from the four fields the check reads, this stops type-checking.
    const record: Pick<
      IDeploymentRecord,
      'contractName' | 'network' | 'version' | 'address'
    > = {
      contractName: 'CBridgeFacet',
      network: 'mainnet',
      version: '1.0.0',
      address: MAINNET_ONLY_FACET,
    }
    const entry: IDeploymentIndexEntry = record

    const verdict = evaluateCalldataAddresses(
      {
        network: 'mainnet',
        references: [facetAdd(MAINNET_ONLY_FACET)],
        expectations: expectations([
          MAINNET_ONLY_FACET,
          { contractName: 'CBridgeFacet', version: '1.0.0' },
        ]),
      },
      recordIndex([MAINNET_ONLY_FACET], [entry])
    )

    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.Resolved)
  })
})
