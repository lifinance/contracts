/**
 * Unit and CLI tests for the production deploy gate in `verify-approvals.ts`.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { EnvironmentEnum } from '../../common/types'

import {
  collectDeployGateFailures,
  parseFacetList,
  reportApprovalResult,
  resolveAuditCommitHash,
  resolveGithubToken,
  verifyDeployGate,
  type IDeployGateDeps,
  type IReportTarget,
} from './verify-approvals'

const PROD_BRANCH = {
  environment: EnvironmentEnum.production,
  branch: 'deploy/across',
  hasOpenPr: true,
}

const MATCHING_FACET = {
  name: 'AcrossFacet',
  matchesMain: true,
}

/** Captures what the CLI would print and the code it would exit with. */
function captureReport(): IReportTarget & {
  written: string[]
  exitCode: number | undefined
} {
  const written: string[] = []
  const captured = {
    written,
    exitCode: undefined as number | undefined,
    stdout: {
      write: (text: string) => written.push(text),
    },
    exit: ((code: number) => {
      captured.exitCode = code
    }) as (code: number) => never,
  }

  return captured
}

function stubDeps(overrides: Partial<IDeployGateDeps> = {}): IDeployGateDeps {
  return {
    mainRef: 'origin/main',
    fileMatchesRef: () => true,
    getContractVersion: async () => '1.0.0',
    resolveAuditCommitHash: () => 'aa'.repeat(20),
    getOpenPrCount: async () => 1,
    ...overrides,
  }
}

describe('parseFacetList', () => {
  it('trims entries and drops the blank lines the shell caller appends', () => {
    expect(parseFacetList('AcrossFacet\n  AmarokFacet  \n\n')).toEqual([
      'AcrossFacet',
      'AmarokFacet',
    ])
  })

  it('returns an empty list for missing or empty input', () => {
    expect(parseFacetList(undefined)).toEqual([])
    expect(parseFacetList('   ')).toEqual([])
  })
})

describe('resolveGithubToken', () => {
  const originalToken = process.env.GH_TOKEN

  beforeEach(() => {
    delete process.env.GH_TOKEN
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = originalToken
  })

  it('throws an actionable error when neither the flag nor the environment has a token', () => {
    expect(() => resolveGithubToken(undefined)).toThrow(/GH_TOKEN/)
    expect(() => resolveGithubToken('')).toThrow(/GH_TOKEN/)
    expect(() => resolveGithubToken('   ')).toThrow(/GH_TOKEN/)
  })

  it('prefers the CLI flag and falls back to the environment', () => {
    expect(resolveGithubToken('  flag-token  ')).toBe('flag-token')

    process.env.GH_TOKEN = 'env-token'
    expect(resolveGithubToken('')).toBe('env-token')
  })
})

describe('collectDeployGateFailures', () => {
  it('allows staging deploys regardless of branch, PR, or audit state', () => {
    expect(
      collectDeployGateFailures({
        environment: EnvironmentEnum.staging,
        branch: 'feature/wip',
        hasOpenPr: false,
        facets: [{ name: 'AcrossFacet', matchesMain: false }],
      })
    ).toEqual([])
  })

  it('allows production deploys from main even when the working tree diverges', () => {
    expect(
      collectDeployGateFailures({
        environment: EnvironmentEnum.production,
        branch: 'main',
        hasOpenPr: false,
        facets: [{ name: 'AcrossFacet', matchesMain: false }],
      })
    ).toEqual([])
  })

  it('allows a production feature-branch deploy when every selected facet matches main', () => {
    expect(
      collectDeployGateFailures({
        ...PROD_BRANCH,
        hasOpenPr: false,
        facets: [MATCHING_FACET, { name: 'AmarokFacet', matchesMain: true }],
      })
    ).toEqual([])
  })

  it('reports an empty facet list on production feature branches', () => {
    expect(collectDeployGateFailures({ ...PROD_BRANCH, facets: [] })).toEqual([
      'No facets were passed to the check',
    ])
  })

  it('requires an open PR when a selected facet does not match main', () => {
    expect(
      collectDeployGateFailures({
        ...PROD_BRANCH,
        hasOpenPr: false,
        facets: [
          {
            name: 'AcrossFacet',
            matchesMain: false,
            version: '1.0.0',
            auditCommitHash: 'aa'.repeat(20),
            matchesAuditedCommit: true,
          },
        ],
      })
    ).toEqual(['No open PR found for branch "deploy/across"'])
  })

  it('requires an audit-log commit hash when a selected facet does not match main', () => {
    expect(
      collectDeployGateFailures({
        ...PROD_BRANCH,
        facets: [
          {
            name: 'AcrossFacet',
            matchesMain: false,
            version: '1.2.0',
          },
        ],
      })
    ).toEqual([
      'AcrossFacet (v1.2.0) has no audit log entry with a commit hash',
    ])
  })

  it('rejects a diverged facet that has changed since its audited commit', () => {
    expect(
      collectDeployGateFailures({
        ...PROD_BRANCH,
        facets: [
          {
            name: 'AcrossFacet',
            matchesMain: false,
            version: '1.0.0',
            auditCommitHash: 'bb'.repeat(20),
            matchesAuditedCommit: false,
          },
        ],
      })
    ).toEqual([
      `AcrossFacet has changed since audited commit ${'bb'.repeat(20)}`,
    ])
  })

  it('allows a diverged facet that has an open PR, an audit, and a frozen audited commit', () => {
    expect(
      collectDeployGateFailures({
        ...PROD_BRANCH,
        facets: [
          MATCHING_FACET,
          {
            name: 'AmarokFacet',
            matchesMain: false,
            version: '1.0.0',
            auditCommitHash: 'cc'.repeat(20),
            matchesAuditedCommit: true,
          },
        ],
      })
    ).toEqual([])
  })
})

describe('collectDeployGateFailures - unknown environment', () => {
  it('fails closed instead of treating it as staging', () => {
    expect(
      collectDeployGateFailures({
        environment: 'prod',
        branch: 'feature/x',
        facets: [],
        hasOpenPr: false,
      })
    ).toEqual(['Unknown environment "prod" (expected production or staging)'])
  })
})

describe('resolveAuditCommitHash', () => {
  const log = {
    audits: {
      auditOld: { auditCommitHash: '11'.repeat(20) },
      auditNada: {
        auditCommitHash: 'n/a (forked contract)',
      },
      auditNew: { auditCommitHash: '22'.repeat(20) },
    },
    auditedContracts: {
      AcrossFacet: {
        '1.0.0': ['auditOld', 'auditNada', 'auditNew'],
        '2.0.0': ['auditNada'],
      },
    },
  }

  it('returns the latest usable 40-char hash for the contract version', () => {
    expect(resolveAuditCommitHash(log, 'AcrossFacet', '1.0.0')).toBe(
      '22'.repeat(20)
    )
  })

  it('returns undefined when the version has no usable commit hash', () => {
    expect(resolveAuditCommitHash(log, 'AcrossFacet', '2.0.0')).toBeUndefined()
    expect(resolveAuditCommitHash(log, 'MissingFacet', '1.0.0')).toBeUndefined()
  })
})

describe('reportApprovalResult', () => {
  it('writes the success marker to stdout and does not exit on success', () => {
    const target = captureReport()

    reportApprovalResult([], target)

    expect(target.written).toEqual(['OK\n'])
    expect(target.exitCode).toBeUndefined()
  })

  it('exits non-zero and writes nothing to stdout on failure', () => {
    const target = captureReport()

    reportApprovalResult(
      ['No open PR found for branch "deploy/across"'],
      target
    )

    expect(target.exitCode).toBe(1)
    expect(target.written).toEqual([])
  })
})

describe('verifyDeployGate', () => {
  it('does not look up GitHub or audits when every facet matches main', async () => {
    let openPrLookups = 0
    let auditLookups = 0

    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'deploy/across',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        fileMatchesRef: () => true,
        resolveAuditCommitHash: () => {
          auditLookups += 1
          return 'aa'.repeat(20)
        },
        getOpenPrCount: async () => {
          openPrLookups += 1
          return 0
        },
      })
    )

    expect(failures).toEqual([])
    expect(openPrLookups).toBe(0)
    expect(auditLookups).toBe(0)
  })

  it('looks up the open PR and audit freeze only for facets that differ from main', async () => {
    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'feature/across-v2',
        facets: ['AcrossFacet', 'AmarokFacet'],
      },
      stubDeps({
        fileMatchesRef: (ref, path) =>
          path.includes('AcrossFacet') ? ref !== 'origin/main' : true,
        getContractVersion: async (name) =>
          name === 'AcrossFacet' ? '2.0.0' : '1.0.0',
        resolveAuditCommitHash: (name) =>
          name === 'AcrossFacet' ? 'dd'.repeat(20) : undefined,
        getOpenPrCount: async () => 1,
      })
    )

    expect(failures).toEqual([])
  })

  it('fails closed when a diverged facet has no open PR', async () => {
    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'feature/orphan',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        fileMatchesRef: (ref) => ref !== 'origin/main',
        getOpenPrCount: async () => 0,
      })
    )

    expect(failures).toContain('No open PR found for branch "feature/orphan"')
  })
})

describe('verify-approvals CLI', () => {
  const script = join(import.meta.dir, 'verify-approvals.ts')

  it('allows staging deploys without a GitHub token', () => {
    const env = { ...process.env }
    delete env.GH_TOKEN

    const result = spawnSync(
      process.execPath,
      [
        script,
        '--environment',
        'staging',
        '--branch',
        'feature/some-branch',
        '--facets',
        'AcrossFacet',
        '--token',
        '',
      ],
      { cwd: tmpdir(), env, encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OK')
  })

  it('allows production deploys from main without a GitHub token', () => {
    const env = { ...process.env }
    delete env.GH_TOKEN

    const result = spawnSync(
      process.execPath,
      [
        script,
        '--environment',
        'production',
        '--branch',
        'main',
        '--facets',
        'AcrossFacet',
        '--token',
        '',
      ],
      { cwd: tmpdir(), env, encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OK')
  })
})

describe('getContractVersion under the tsx runtime', () => {
  // getContractVersion's per-path catch swallows a missing-global error, so a
  // runtime regression here degrades to "no version found" rather than throwing.
  it('resolves a facet version when run through bunx tsx', () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..')
    const probe = join(mkdtempSync(join(tmpdir(), 'gate-')), 'probe.ts')
    writeFileSync(
      probe,
      `import { getContractVersion } from ${JSON.stringify(
        join(repoRoot, 'script/deploy/shared/getContractVersion')
      )}\n` +
        `getContractVersion('OwnershipFacet').then((v) => console.log(v))\n`
    )

    const result = spawnSync('bunx', ['tsx', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('deployUpgradesToSAFE gate condition', () => {
  // getPrivateKey only treats *staging* as staging, so any other value - including a
  // typo like "prod" - reaches the production key. The gate must run for those too.
  const condition = readFileSync(
    join(import.meta.dir, '..', 'deployUpgradesToSAFE.sh'),
    'utf8'
  )
    .split('\n')
    .find((line) => line.includes('$ENVIRONMENT') && line.includes('if [['))

  it('extracts the gate condition from the shell script', () => {
    expect(condition).toBeDefined()
  })

  it.each([
    ['production', 'RUNS'],
    ['prod', 'RUNS'],
    ['', 'RUNS'],
    ['staging', 'SKIPPED'],
  ])('runs the gate for environment %p', (environment, expected) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `ENVIRONMENT=$1; ${condition} echo RUNS; else echo SKIPPED; fi`,
        'bash',
        environment,
      ],
      { encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(expected)
  })
})
