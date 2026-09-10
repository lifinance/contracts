import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  PROVENANCE_UNKNOWN,
  resetGitProvenanceCache,
  type CommandRunner,
  type ICommandResult,
  type ProvenanceActor,
} from './git-provenance'
import {
  buildDeploymentUpsert,
  captureRecordProvenance,
  deploymentRecordEqFilter,
  describeDirtyTree,
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
   * An empty list is the answer "this tree was clean" on a first insert.
   * Writing it through `$set` would let a later clean re-log erase the dirty
   * list that is the tell-tale of the deploy this field exists to surface.
   */
  it('records a clean tree on insert only, never over an existing dirty list', () => {
    const update = provenanceUpdate({ ...captured, dirtyTreeScoped: [] })

    expect(update.set).not.toHaveProperty('dirtyTreeScoped')
    expect(update.set).not.toHaveProperty('dirtyTreeTruncated')
    expect(update.setOnInsert).toHaveProperty('dirtyTreeScoped', [])
    expect(update.setOnInsert).toHaveProperty('dirtyTreeTruncated', false)
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

  it('carries a recorded codehash into the update as one group', () => {
    const codehash = {
      // pre-commit-checker: not a secret
      hash: `0x${'1'.repeat(64)}`,
      // pre-commit-checker: not a secret
      maskedHash: `0x${'2'.repeat(64)}`,
      byteLength: 7390,
      maskedByteCount: 480,
    }

    const { update } = buildDeploymentUpsert({ ...record, codehash }, now)

    expect(update.$set.codehash).toEqual(codehash)
  })

  /**
   * `$set: { codehash: undefined }` would reach the driver as a null and erase
   * what a run that did observe the code had stored, so the key has to be
   * absent as an own property. Asserted on the update's own keys rather than
   * through JSON, which erases an undefined value and would pass either way.
   */
  it('writes no codehash key for a record that carries none', () => {
    const { update } = buildDeploymentUpsert(record, now)

    expect(Object.keys(update.$set).includes('codehash')).toBe(false)
    // Paired positive: the absence above must not pass on an empty update.
    expect(Object.keys(update.$set).includes('contractName')).toBe(true)
  })
})

describe('describeDirtyTree', () => {
  it.each([
    ['unknown', { dirtyTreeScoped: undefined }, 'unknown'],
    ['no', { dirtyTreeScoped: [] }, 'no'],
    [
      '1 path(s)',
      { dirtyTreeScoped: ['src/Facets/AcrossFacetV4.sol'] },
      '1 path(s)',
    ],
    [
      '2+ path(s)',
      {
        dirtyTreeScoped: ['a.sol', 'b.sol'],
        dirtyTreeTruncated: true,
      },
      '2+ path(s)',
    ],
  ])('renders %s', (_label, record, expected) => {
    expect(describeDirtyTree(record)).toBe(expected)
  })

  /**
   * The one rendering that must never be wrong: no readable capture has to look
   * different from a clean tree, or the summary a deployer reads invents a
   * clean bill of health.
   */
  it('never renders an absent capture the way it renders a clean tree', () => {
    expect(describeDirtyTree({ dirtyTreeScoped: undefined })).not.toBe(
      describeDirtyTree({ dirtyTreeScoped: [] })
    )
  })
})

describe('captureRecordProvenance', () => {
  /** Canned git answers, keyed by the subcommand the capture asks for. */
  const gitRunner =
    (answers: Record<string, ICommandResult>): CommandRunner =>
    (command, args) => {
      const key = `${command} ${args.join(' ')}`
      return (
        answers[key] ?? {
          status: 128,
          stdout: '',
          stderr: `no stub for ${key}`,
        }
      )
    }

  const ok = (stdout: string): ICommandResult => ({
    status: 0,
    stdout,
    stderr: '',
  })
  const failed: ICommandResult = {
    status: 128,
    stdout: '',
    stderr: 'fatal: not a git repository',
  }

  const REPO = '/repo'
  const HEAD = 'c'.repeat(40)
  const baseAnswers: Record<string, ICommandResult> = {
    'git rev-parse --show-toplevel': ok(`${REPO}\n`),
    'git rev-parse HEAD': ok(`${HEAD}\n`),
    'git rev-parse --abbrev-ref HEAD': ok('feature/exsc-695\n'),
    'git status --porcelain --untracked-files=normal': ok(
      ' M src/Facets/AcrossFacetV4.sol\n'
    ),
    [`git branch --remotes --contains ${HEAD}`]: ok('  origin/main\n'),
    'git config user.name': ok('Provenance Tester\n'),
    'git config user.email': ok('provenance@example.com\n'),
  }

  const capture = (answers: Record<string, ICommandResult>) =>
    captureRecordProvenance({
      cwd: REPO,
      env: {},
      run: gitRunner(answers),
    })

  beforeEach(() => {
    // The capture memoises a success for the process lifetime, and `bun test`
    // runs every file in one process.
    resetGitProvenanceCache()
  })
  afterEach(() => {
    resetGitProvenanceCache()
  })

  it('maps branch, dirty paths and actor off the git answers it was given', () => {
    const provenance = capture(baseAnswers)

    expect(provenance.gitCommitHash).toBe(HEAD)
    expect(provenance.gitBranch).toBe('feature/exsc-695')
    expect(provenance.dirtyTreeScoped).toEqual(['src/Facets/AcrossFacetV4.sol'])
    expect(provenance.dirtyTreeTruncated).toBe(false)
    expect(provenance.actor).toBe('human')
    expect(provenance.captureErrors).toBeUndefined()
  })

  it('takes the commit from the shared capture, including the CI SHA', () => {
    const sha = 'd'.repeat(40)
    const provenance = captureRecordProvenance({
      cwd: REPO,
      env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: sha },
      run: gitRunner(baseAnswers),
    })

    expect(provenance.gitCommitHash).toBe(sha)
  })

  it('records a clean tree as an empty list', () => {
    const provenance = capture({
      ...baseAnswers,
      'git status --porcelain --untracked-files=normal': ok(''),
    })

    expect(provenance.dirtyTreeScoped).toEqual([])
    expect(provenance.dirtyTreeTruncated).toBe(false)
  })

  /**
   * The fix this pairs with: the shared capture collects every probe's failure
   * in one bag, so keying the dirty list on that bag let an unrelated failure —
   * here the remote-containment probe on a tree `git status` read fine — delete
   * a list that was actually known, and with it the clearing of a stale one.
   */
  it.each([
    ['clean', '', []],
    [
      'dirty',
      ' M src/Facets/AcrossFacetV4.sol\n',
      ['src/Facets/AcrossFacetV4.sol'],
    ],
  ])(
    'still records a %s tree when an unrelated probe failed',
    (_label, porcelain, expected) => {
      // The clean row is the one that discriminates: a non-empty list is
      // evidence in itself and survives either rule, so only an empty one
      // forces the question of whether the tree probe actually ran.
      const provenance = capture({
        ...baseAnswers,
        'git status --porcelain --untracked-files=normal': ok(
          porcelain as string
        ),
        [`git branch --remotes --contains ${HEAD}`]: failed,
      })

      expect(provenance.dirtyTreeScoped).toEqual(expected)
      expect(provenance.dirtyTreeTruncated).toBe(false)
      expect(provenance.captureErrors?.length).toBeGreaterThan(0)
    }
  )

  it('omits the dirty list when the tree itself could not be read', () => {
    const provenance = capture({
      ...baseAnswers,
      'git status --porcelain --untracked-files=normal': failed,
    })

    expect(provenance).not.toHaveProperty('dirtyTreeScoped')
    expect(provenance).not.toHaveProperty('dirtyTreeTruncated')
    // Paired positive: the capture still ran and answered everything else, so
    // the two absences above are the tree probe's, not an empty result.
    expect(provenance.gitBranch).toBe('feature/exsc-695')
    expect(provenance.captureErrors?.join(' ')).toContain('git status')
  })

  it('reports the sentinel branch when git answers nothing', () => {
    const provenance = capture({})

    expect(provenance.gitBranch).toBe(PROVENANCE_UNKNOWN)
    expect(provenance).not.toHaveProperty('dirtyTreeScoped')
  })
})
