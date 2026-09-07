import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  getGitBranch,
  getScopedDirtyTree,
  PROVENANCE_UNKNOWN,
  type ProvenanceActor,
} from './git-provenance'
import {
  buildDeploymentUpsert,
  captureRecordProvenance,
  deploymentRecordEqFilter,
  mongoEq,
  provenanceUpdate,
  type IDeploymentRecord,
} from './mongo-log-utils'

describe('mongoEq', () => {
  it('wraps a plain value in an equality operator', () => {
    expect(mongoEq('AcrossFacetV4')).toEqual({ $eq: 'AcrossFacetV4' })
    expect(mongoEq(true)).toEqual({ $eq: true })
    expect(mongoEq(200000)).toEqual({ $eq: 200000 })
  })

  /**
   * The Aikido false-positive catalog dismisses NoSQL-injection findings in the
   * deployment-log scripts on the grounds that mongoEq neutralises an operator
   * object, so that property needs a test holding it true.
   */
  it.each([
    ['comparison', { $ne: null }],
    ['evaluation', { $where: 'sleep(1000)' }],
    ['array', { $in: ['a', 'b'] }],
  ])(
    'nests an injected %s operator instead of passing it through',
    (_, payload) => {
      const filter = mongoEq(payload)

      expect(filter).toEqual({ $eq: payload })
      expect(Object.keys(filter)).toEqual(['$eq'])
    }
  )

  it('keeps undefined and null as literal matches', () => {
    expect(mongoEq(undefined)).toEqual({ $eq: undefined })
    expect(mongoEq(null)).toEqual({ $eq: null })
  })
})

describe('deploymentRecordEqFilter', () => {
  it('wraps every supplied field in an equality operator', () => {
    expect(
      deploymentRecordEqFilter({
        contractName: 'AcrossFacetV4',
        network: 'arbitrum',
        verified: false,
      })
    ).toEqual({
      contractName: { $eq: 'AcrossFacetV4' },
      network: { $eq: 'arbitrum' },
      verified: { $eq: false },
    })
  })

  it('omits fields that were not supplied rather than matching on undefined', () => {
    expect(deploymentRecordEqFilter({ network: 'arbitrum' })).toEqual({
      network: { $eq: 'arbitrum' },
    })
    expect(deploymentRecordEqFilter({})).toEqual({})
  })

  /**
   * The filter is a whitelist because its callers hand it caller-supplied
   * objects: a key outside the whitelist must not reach the query at all.
   */
  it('drops keys outside the whitelist', () => {
    const filter = deploymentRecordEqFilter({
      network: 'arbitrum',
      $where: 'sleep(1000)',
      _id: 'deadbeef',
    } as unknown as Parameters<typeof deploymentRecordEqFilter>[0])

    expect(filter).toEqual({ network: { $eq: 'arbitrum' } })
  })
})

describe('provenanceUpdate — twin provenance fields', () => {
  const hash = 'a'.repeat(40)
  const repo = 'github.com/lifinance/contracts'
  const captured = {
    gitCommitHash: hash,
    repo,
    gitBranch: 'feature/exsc-695',
    dirtyTreeScoped: ['src/Facets/AcrossFacetV4.sol'],
    dirtyTreeTruncated: false,
    actor: 'human' as const,
  }

  it('sets branch, dirty tree and actor from a full capture', () => {
    expect(provenanceUpdate(captured).set).toEqual({
      gitCommitHash: hash,
      repo,
      gitBranch: 'feature/exsc-695',
      dirtyTreeScoped: ['src/Facets/AcrossFacetV4.sol'],
      dirtyTreeTruncated: false,
      actor: 'human',
    })
  })

  /**
   * The JSON sync path builds records with none of these fields, so an
   * unconditional `$set` would erase on every sync what the add CLI recorded at
   * deploy time. Paired with the case above so "not present" cannot pass by
   * observing an update this function never populates at all.
   */
  it('leaves every twin field alone on a record that carries none', () => {
    const update = provenanceUpdate({ gitCommitHash: hash, repo })

    for (const field of [
      'gitBranch',
      'dirtyTreeScoped',
      'dirtyTreeTruncated',
      'actor',
    ]) {
      expect(update.set).not.toHaveProperty(field)
      expect(update.setOnInsert).not.toHaveProperty(field)
    }
    expect(update.set).toHaveProperty('gitCommitHash', hash)
  })

  it.each([
    ['gitBranch', { gitBranch: PROVENANCE_UNKNOWN }],
    ['actor', { actor: PROVENANCE_UNKNOWN as ProvenanceActor }],
  ])(
    'records a failed %s capture on insert but never over an existing value',
    (field, sentinelField) => {
      const update = provenanceUpdate({
        ...captured,
        ...sentinelField,
      })

      expect(update.set).not.toHaveProperty(field)
      expect(update.setOnInsert).toHaveProperty(field, PROVENANCE_UNKNOWN)
    }
  )

  /**
   * An empty list is the answer "this tree was clean", not a missing capture —
   * and it has to be written, or a record logged from a dirty tree keeps its
   * paths forever once the tree is cleaned and the deploy is re-run.
   */
  it('writes a clean tree as an empty list rather than omitting it', () => {
    const update = provenanceUpdate({ ...captured, dirtyTreeScoped: [] })

    expect(update.set).toHaveProperty('dirtyTreeScoped', [])
    expect(update.set).toHaveProperty('dirtyTreeTruncated', false)
  })

  it('carries the truncation flag when the dirty list was capped', () => {
    const update = provenanceUpdate({ ...captured, dirtyTreeTruncated: true })

    expect(update.set).toHaveProperty('dirtyTreeTruncated', true)
  })

  /**
   * Provenance must never become part of a deployment's identity: EXSC-695's
   * safety note turns on the filter staying the four identity fields, and this
   * whitelist is the other place a branch could leak into a query.
   */
  it('keeps the twin fields out of the equality-filter whitelist', () => {
    const filter = deploymentRecordEqFilter({
      network: 'arbitrum',
      gitBranch: 'feature/exsc-695',
      actor: 'human',
      dirtyTreeScoped: ['src/Facets/AcrossFacetV4.sol'],
    })

    expect(filter).toEqual({ network: { $eq: 'arbitrum' } })
  })
})

describe('buildDeploymentUpsert', () => {
  const now = new Date('2026-09-08T00:00:00.000Z')
  const record: IDeploymentRecord = {
    contractName: 'AcrossFacetV4',
    network: 'arbitrum',
    version: '1.0.0',
    address: '0x1111111111111111111111111111111111111111',
    optimizerRuns: '1000000',
    timestamp: now,
    constructorArgs: '0x',
    salt: '',
    verified: true,
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    zkSolcVersion: '',
    gitCommitHash: 'b'.repeat(40),
    repo: 'github.com/lifinance/contracts',
    gitBranch: 'feature/exsc-695',
    dirtyTreeScoped: ['src/Facets/AcrossFacetV4.sol'],
    dirtyTreeTruncated: false,
    actor: 'human',
    createdAt: now,
    updatedAt: now,
    contractNetworkKey: 'AcrossFacetV4-arbitrum',
    contractVersionKey: 'AcrossFacetV4-1.0.0',
  }

  it('puts the captured provenance into the update the CLI applies', () => {
    const { update } = buildDeploymentUpsert(record, now)

    expect(update.$set).toMatchObject({
      gitBranch: 'feature/exsc-695',
      dirtyTreeScoped: ['src/Facets/AcrossFacetV4.sol'],
      dirtyTreeTruncated: false,
      actor: 'human',
      updatedAt: now,
    })
  })

  /**
   * The identity a re-log matches on. A provenance field in here would insert a
   * second row for the same deployed address on every deploy from a new branch.
   */
  it('matches on the four identity fields only', () => {
    const { filter } = buildDeploymentUpsert(record, now)

    expect(filter).toEqual({
      contractName: { $eq: 'AcrossFacetV4' },
      network: { $eq: 'arbitrum' },
      version: { $eq: '1.0.0' },
      address: { $eq: '0x1111111111111111111111111111111111111111' },
    })
  })

  it('claims only the creation stamp on insert for a fully captured record', () => {
    const { update } = buildDeploymentUpsert(record, now)

    expect(update.$setOnInsert).toEqual({ createdAt: now })
  })
})

describe('captureRecordProvenance', () => {
  /**
   * Runs against this checkout, so it asserts that the shared capture is
   * actually reached and mapped onto record fields — not which branch a
   * reviewer happens to be on.
   */
  it('maps the shared git capture onto record fields', () => {
    const provenance = captureRecordProvenance()

    expect(provenance.gitBranch).toBeTruthy()
    expect(provenance.gitBranch).toBe(getGitBranch())
    expect(provenance.dirtyTreeScoped).toEqual(getScopedDirtyTree().paths)
    expect(['human', 'bot', 'ci', PROVENANCE_UNKNOWN]).toContain(
      provenance.actor
    )
    expect(typeof provenance.dirtyTreeTruncated).toBe('boolean')
  })
})
