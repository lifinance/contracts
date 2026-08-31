/**
 * Unit and CLI tests for the production deploy gate in `verify-approvals.ts`.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { EnvironmentEnum } from '../../common/types'

import {
  collectDeployGateFailures,
  collectSourceClosure,
  createDefaultDeps,
  parseFacetList,
  reportApprovalResult,
  resolveAuditCommitHash,
  resolveSolidityImport,
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
    refExists: () => true,
    sourceClosure: (path) => [path],
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
            divergedFromMain: ['src/Facets/AcrossFacet.sol'],
          },
        ],
      })
    ).toEqual([
      'AcrossFacet (v1.2.0) diverges from main (src/Facets/AcrossFacet.sol) and has no audit log entry with a commit hash in audit/auditLog.json on main',
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
            auditCommitAvailable: true,
            matchesAuditedCommit: false,
            changedSinceAudit: ['src/Libraries/LibSwap.sol'],
          },
        ],
      })
    ).toEqual([
      `AcrossFacet has changed since audited commit ${'bb'.repeat(
        20
      )} (src/Libraries/LibSwap.sol)`,
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

describe('resolveSolidityImport', () => {
  it.each([
    ['../Libraries/LibSwap.sol', 'src/Libraries/LibSwap.sol'],
    ['./Helpers/SwapperV2.sol', 'src/Facets/Helpers/SwapperV2.sol'],
    ['lifi/Libraries/LibAsset.sol', 'src/Libraries/LibAsset.sol'],
  ])('resolves %p inside src', (spec, expected) => {
    expect(resolveSolidityImport('src/Facets/AcrossFacet.sol', spec)).toBe(
      expected
    )
  })

  it.each([
    ['@openzeppelin/token/ERC20/IERC20.sol'],
    ['solady/utils/SafeTransferLib.sol'],
    ['../../lib/forge-std/src/Test.sol'],
  ])('ignores %p because it resolves outside src', (spec) => {
    expect(
      resolveSolidityImport('src/Facets/AcrossFacet.sol', spec)
    ).toBeUndefined()
  })
})

describe('collectSourceClosure', () => {
  const sources: Record<string, string> = {
    'src/Facets/AcrossFacet.sol':
      'import { LibSwap } from "../Libraries/LibSwap.sol";\n' +
      'import { IERC20 } from "@openzeppelin/token/ERC20/IERC20.sol";\n' +
      '// import { Gone } from "../Libraries/Deleted.sol";\n',
    'src/Libraries/LibSwap.sol':
      'import { LibAsset } from "lifi/Libraries/LibAsset.sol";\n' +
      'import { LibSwap } from "./LibSwap.sol";\n',
    'src/Libraries/LibAsset.sol': '',
  }
  const closure = collectSourceClosure(
    'src/Facets/AcrossFacet.sol',
    (path) => sources[path]
  )

  it('walks transitively through remapped and relative imports', () => {
    expect(closure).toEqual([
      'src/Facets/AcrossFacet.sol',
      'src/Libraries/LibAsset.sol',
      'src/Libraries/LibSwap.sol',
    ])
  })

  it('keeps the entry path when the facet file does not exist, so the gate fails closed', () => {
    expect(
      collectSourceClosure('src/Facets/Ghost.sol', () => undefined)
    ).toEqual(['src/Facets/Ghost.sol'])
  })

  it('pulls real libraries into the closure of a real facet', () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..')
    const real = collectSourceClosure(
      'src/Facets/AccessManagerFacet.sol',
      (p) => {
        try {
          return readFileSync(join(repoRoot, p), 'utf8')
        } catch {
          return undefined
        }
      }
    )

    expect(real).toContain('src/Libraries/LibDiamond.sol')
    expect(real).toContain('src/Libraries/LibAccess.sol')
    expect(real.length).toBeGreaterThan(1)
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

  it('fails closed when only a library in the facet closure diverges from main', async () => {
    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'feature/lib-edit',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        sourceClosure: () => [
          'src/Facets/AcrossFacet.sol',
          'src/Libraries/LibSwap.sol',
        ],
        fileMatchesRef: (_ref, path) => !path.endsWith('LibSwap.sol'),
        resolveAuditCommitHash: () => undefined,
        getOpenPrCount: async () => 1,
      })
    )

    expect(failures).toEqual([
      'AcrossFacet (v1.0.0) diverges from main (src/Libraries/LibSwap.sol) and has no audit log entry with a commit hash in audit/auditLog.json on main',
    ])
  })

  it('fails closed when a closure file changed since the audited commit', async () => {
    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'feature/lib-edit',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        sourceClosure: () => [
          'src/Facets/AcrossFacet.sol',
          'src/Libraries/LibSwap.sol',
        ],
        fileMatchesRef: (_ref, path) => !path.endsWith('LibSwap.sol'),
        resolveAuditCommitHash: () => 'cc'.repeat(20),
      })
    )

    expect(failures).toEqual([
      `AcrossFacet has changed since audited commit ${'cc'.repeat(
        20
      )} (src/Libraries/LibSwap.sol)`,
    ])
  })

  it('reports a missing audited commit instead of blaming the source files', async () => {
    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'feature/across-v2',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        fileMatchesRef: (ref) => ref !== 'origin/main',
        refExists: () => false,
        resolveAuditCommitHash: () => 'ee'.repeat(20),
      })
    )

    expect(failures).toEqual([
      `AcrossFacet audited commit ${'ee'.repeat(
        20
      )} is not present in this checkout - fetch it before deploying`,
    ])
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

  // cwd is a temp dir, so any git or gh lookup would fail: reaching exit 0 proves
  // these two paths short-circuit before touching the repo or GitHub.
  it.each([
    ['staging', 'feature/some-branch'],
    ['production', 'main'],
  ])('allows %s on %s without contacting GitHub', (environment, branch) => {
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--environment',
        environment,
        '--branch',
        branch,
        '--facets',
        'AcrossFacet',
      ],
      { cwd: tmpdir(), encoding: 'utf8' }
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

describe('diamondUpdateFacet gate condition', () => {
  // getPrivateKey only treats *staging* as staging, so any other value - including a
  // typo like "prod" - reaches the production key. The gate must run for those too.
  // Anchored on the gate's own invocation and walked backwards, because the host
  // script carries other `$ENVIRONMENT` conditions that a first-match scan picks up.
  const lines = readFileSync(
    join(import.meta.dir, '..', '..', 'tasks', 'diamondUpdateFacet.sh'),
    'utf8'
  ).split('\n')
  const gateIndex = lines.findIndex((line) =>
    line.includes('verify-approvals.ts')
  )
  const condition = lines
    .slice(0, gateIndex)
    .reverse()
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

describe('audit log source', () => {
  const MERGED_HASH = '11'.repeat(20)
  const FABRICATED_HASH = '99'.repeat(20)

  const auditLog = (hash: string): string =>
    JSON.stringify({
      audits: { audit1: { auditCommitHash: hash } },
      auditedContracts: { AcrossFacet: { '1.0.0': ['audit1'] } },
    })

  it('reads the merged entry, not the one fabricated in the working tree', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-audit-'))
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

    run('init', '-b', 'main')
    run('config', 'user.email', 'gate@example.com')
    run('config', 'user.name', 'gate')
    mkdirSync(join(repoRoot, 'audit'))
    writeFileSync(join(repoRoot, 'audit/auditLog.json'), auditLog(MERGED_HASH))
    run('add', '.')
    run('commit', '-m', 'audit log', '--no-gpg-sign')

    // the self-certification attempt: an unmerged, uncommitted audit entry
    writeFileSync(
      join(repoRoot, 'audit/auditLog.json'),
      auditLog(FABRICATED_HASH)
    )

    expect(
      createDefaultDeps(repoRoot).resolveAuditCommitHash('AcrossFacet', '1.0.0')
    ).toBe(MERGED_HASH)
  })
})

describe('open-PR lookup', () => {
  const source = readFileSync(
    join(import.meta.dir, 'verify-approvals.ts'),
    'utf8'
  )

  it('uses the GitHub CLI instead of a personal access token', () => {
    expect(source).toContain("'gh'")
    expect(source).not.toContain('Octokit')
    expect(source).not.toMatch(/GH_TOKEN|--token/)
  })
})
