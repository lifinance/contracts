/**
 * The calldata address check, exercised against the repo's real deployment data.
 *
 * Three properties carry more weight than the happy path. **Real current data
 * still passes** — a check that refused everything would satisfy every refusal
 * case below while blocking every honest proposal. **An unanswerable question is
 * not a pass** — an unreadable store, a source that lags, a call the extractor
 * could not open, or an address nobody looked up all have to be distinguishable
 * from a clean resolution. And **the repo deployment files are not the record**:
 * two real addresses in this repository prove each file wrong in a different
 * direction, which is why the source of the entries is itself judged.
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
 * A real mainnet facet the deployment record holds and **neither** repo
 * deployment file lists: the cut that replaced it removed its row. A
 * repo-file-sourced index therefore grades a recorded mainnet deployment as
 * unknown.
 */
const RECORDED_NOT_IN_REPO_FILES = '0x23Fc1b73e66Cd13e988170CB94e252Cb7FF88185'

/**
 * A real mainnet facet the repo files list and the deployment-log export does
 * not carry at all — the export lags, in the opposite direction.
 */
const IN_REPO_FILES_NOT_IN_EXPORT = '0x8452788daad6af88fe88BC5dFc892974C11C32Ad'

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

  it('reports rather than verifies an identity no anchor supplied', () => {
    const verdict = evaluateCalldataAddresses(
      { network: 'mainnet', references: [facetAdd(FLEET_WIDE_FACET)] },
      recordIndex([FLEET_WIDE_FACET])
    )

    expect(verdict.refuses).toBe(false)
    expect(verdict.error).toBe(false)
    expect(verdict.findings[0]?.grade).toBe(AddressGradeEnum.IdentityUnchecked)
    expect(verdict.warnings.join(' ')).toContain('reported and not verified')
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

  it('is not a theoretical concern: each file is wrong about a real address, in opposite directions', () => {
    const inRepoFiles = new Set(
      repoFileEntries.map((entry) => entry.address.toLowerCase())
    )
    const inExport = new Set(
      realProductionEntries.map((entry) => entry.address.toLowerCase())
    )

    // Recorded on mainnet, listed by neither repo file: wiring the check to the
    // repo file would call this genuinely-deployed facet unknown.
    expect(inExport.has(RECORDED_NOT_IN_REPO_FILES.toLowerCase())).toBe(true)
    expect(inRepoFiles.has(RECORDED_NOT_IN_REPO_FILES.toLowerCase())).toBe(
      false
    )

    // Listed by the repo files, absent from the export: the export cannot rule
    // out an address either.
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
