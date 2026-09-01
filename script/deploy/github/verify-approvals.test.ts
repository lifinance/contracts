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
  divergedSubmodules,
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
    divergedSubmodules: () => [],
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

  it('allows a production deploy from main when the working tree matches it', () => {
    expect(
      collectDeployGateFailures({
        environment: EnvironmentEnum.production,
        branch: 'main',
        hasOpenPr: false,
        facets: [{ name: 'AcrossFacet', matchesMain: true }],
      })
    ).toEqual([])
  })

  // being on main is not evidence of anything: uncommitted edits and a stale checkout
  // both present as a diverged working tree, and no PR can have main as its head
  it('blocks a production deploy from main when the working tree diverges', () => {
    const failures = collectDeployGateFailures({
      environment: EnvironmentEnum.production,
      branch: 'main',
      hasOpenPr: false,
      facets: [{ name: 'AcrossFacet', matchesMain: false }],
    })

    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('does not match origin/main')
    expect(failures[0]).not.toContain('No open PR')
    expect(failures[1]).toContain('AcrossFacet')
  })

  it('does not let an audit freeze excuse a diverged working tree on main', () => {
    expect(
      collectDeployGateFailures({
        environment: EnvironmentEnum.production,
        branch: 'main',
        hasOpenPr: false,
        facets: [
          {
            name: 'AcrossFacet',
            matchesMain: false,
            version: '1.0.0',
            auditCommitHash: 'aa'.repeat(20),
            auditCommitAvailable: true,
            matchesAuditedCommit: true,
            divergedFromMain: ['src/Facets/AcrossFacet.sol'],
          },
        ],
      })
    ).toEqual([
      'Deploying from "main", but the working tree does not match origin/main. Move the change onto a branch and open a PR, or discard it (git checkout / git clean) and pull, before deploying',
      'AcrossFacet diverges from origin/main (src/Facets/AcrossFacet.sol)',
    ])
  })

  // a dependency edit changes the deployed bytecode with every src/ file intact, so
  // this must block even when nothing under src/ diverged at all
  it('blocks when a lib/ submodule diverges even though every facet matches main', () => {
    expect(
      collectDeployGateFailures({
        ...PROD_BRANCH,
        facets: [MATCHING_FACET],
        divergedSubmodules: ['lib/solady'],
      })
    ).toEqual([
      'Dependencies under lib/ differ from origin/main (lib/solady). They are compiled into the facet, so restore them with git submodule update --init --recursive before deploying',
    ])
  })

  // the open-PR + audit-freeze exception covers facet sources, not dependencies
  it('does not let an open PR and an audit freeze excuse a diverged submodule', () => {
    const failures = collectDeployGateFailures({
      ...PROD_BRANCH,
      facets: [
        {
          name: 'AmarokFacet',
          matchesMain: false,
          version: '1.0.0',
          auditCommitHash: 'cc'.repeat(20),
          matchesAuditedCommit: true,
        },
      ],
      divergedSubmodules: ['lib/openzeppelin-contracts'],
    })

    expect(failures).toEqual([
      'Dependencies under lib/ differ from origin/main (lib/openzeppelin-contracts). They are compiled into the facet, so restore them with git submodule update --init --recursive before deploying',
    ])
  })

  it('reports a diverged submodule alongside a diverged tree on main', () => {
    const failures = collectDeployGateFailures({
      environment: EnvironmentEnum.production,
      branch: 'main',
      hasOpenPr: false,
      facets: [{ name: 'AcrossFacet', matchesMain: false }],
      divergedSubmodules: ['lib/solady'],
    })

    expect(failures).toHaveLength(3)
    expect(failures[0]).toContain('Dependencies under lib/')
    expect(failures[1]).toContain('does not match origin/main')
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

  // the gate used to return [] on the branch name alone, so a dirty or stale checkout
  // sitting on main proposed to the production Safe without any comparison at all
  it('compares the working tree on main instead of trusting the branch name', async () => {
    let openPrLookups = 0

    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'main',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        fileMatchesRef: () => false,
        resolveAuditCommitHash: () => undefined,
        getOpenPrCount: async () => {
          openPrLookups += 1
          return 0
        },
      })
    )

    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('does not match origin/main')
    // no PR can have main as its head, so asking GitHub is wasted and misleading
    expect(openPrLookups).toBe(0)
  })

  it('allows a clean checkout on main without contacting GitHub', async () => {
    let openPrLookups = 0

    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'main',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        fileMatchesRef: () => true,
        getOpenPrCount: async () => {
          openPrLookups += 1
          return 0
        },
      })
    )

    expect(failures).toEqual([])
    expect(openPrLookups).toBe(0)
  })

  it('surfaces a diverged submodule reported by the deps', async () => {
    const failures = await verifyDeployGate(
      {
        environment: EnvironmentEnum.production,
        branch: 'deploy/across',
        facets: ['AcrossFacet'],
      },
      stubDeps({
        fileMatchesRef: () => true,
        divergedSubmodules: () => ['lib/solady'],
      })
    )

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('lib/solady')
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
  // staging short-circuits before touching the repo or GitHub.
  it('allows staging without contacting the repo or GitHub', () => {
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
      ],
      { cwd: tmpdir(), encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OK')
  })

  // production has no short-circuit left, so the same temp cwd must now fail closed
  // rather than pass: there is no repo to compare the facet against
  it.each(['main', 'feature/some-branch'])(
    'fails closed on production from %p when the repo cannot be read',
    (branch) => {
      const result = spawnSync(
        process.execPath,
        [
          script,
          '--environment',
          'production',
          '--branch',
          branch,
          '--facets',
          'AcrossFacet',
        ],
        { cwd: tmpdir(), encoding: 'utf8' }
      )

      expect(result.status).not.toBe(0)
      expect(result.stdout).not.toContain('OK')
    }
  )
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
  // getPrivateKey hands out the production key for every value that does not contain
  // "staging", so a typo like "prod" reaches it. The gate must run for those too.
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
    ['production', 'MAINNET', 'RUNS'],
    ['prod', 'MAINNET', 'RUNS'],
    ['', 'MAINNET', 'RUNS'],
    ['staging', 'MAINNET', 'SKIPPED'],
    // testnets carry production target state but no Safe, and an unmerged facet is
    // deployed there before it is audited - gating them would block that rollout
    ['production', 'TESTNET', 'SKIPPED'],
    ['staging', 'TESTNET', 'SKIPPED'],
  ])(
    'runs the gate for environment %p on a %s network',
    (environment, network, expected) => {
      const result = spawnSync(
        'bash',
        [
          '-c',
          // isTestnetNetwork is stubbed on the marker rather than reimplemented, so
          // this asserts the condition consults it, not how helperFunctions decides
          `isTestnetNetwork() { [[ "$1" == "TESTNET" ]]; }; ENVIRONMENT=$1; NETWORK=$2; ${condition} echo RUNS; else echo SKIPPED; fi`,
          'bash',
          environment,
          network,
        ],
        { encoding: 'utf8' }
      )

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(expected)
    }
  )
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

    // a real bare origin, because the gate refreshes origin/main before reading it
    const remote = mkdtempSync(join(tmpdir(), 'gate-audit-remote-'))
    spawnSync('git', ['init', '--bare', '-b', 'main', remote])
    run('init', '-b', 'main')
    run('config', 'user.email', 'gate@example.com')
    run('config', 'user.name', 'gate')
    run('remote', 'add', 'origin', remote)
    mkdirSync(join(repoRoot, 'audit'))
    writeFileSync(join(repoRoot, 'audit/auditLog.json'), auditLog(MERGED_HASH))
    run('add', '.')
    run('commit', '-m', 'audit log', '--no-gpg-sign')
    run('push', '-q', 'origin', 'main')

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

describe('main ref resolution', () => {
  /**
   * Builds a repo wired to a local bare "origin" so `ls-remote` works offline.
   * @param repoRoot - directory to initialise
   * @returns a `git` runner bound to that repo
   */
  const initWithRemote = (repoRoot: string) => {
    const remote = mkdtempSync(join(tmpdir(), 'gate-remote-'))
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

    spawnSync('git', ['init', '--bare', '-b', 'main', remote])
    run('init', '-b', 'main')
    run('config', 'user.email', 'gate@example.com')
    run('config', 'user.name', 'gate')
    run('remote', 'add', 'origin', remote)
    writeFileSync(join(repoRoot, 'README.md'), 'merged\n')
    run('add', '.')
    run('commit', '-m', 'merged commit', '--no-gpg-sign')
    run('push', '-q', 'origin', 'main')

    return run
  }

  // local main is whatever the operator last committed, so accepting it as the
  // comparison ref would let a local commit stand in for a merged one
  it('refuses a checkout that has local main but no origin/main', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-ref-'))
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })

    run('init', '-b', 'main')
    run('config', 'user.email', 'gate@example.com')
    run('config', 'user.name', 'gate')
    writeFileSync(join(repoRoot, 'README.md'), 'local only\n')
    run('add', '.')
    run('commit', '-m', 'local commit', '--no-gpg-sign')

    expect(() => createDefaultDeps(repoRoot).mainRef).toThrow(
      'Cannot resolve origin/main'
    )
  })

  it('uses origin/main when it is already current', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-ref-ok-'))
    initWithRemote(repoRoot)

    expect(createDefaultDeps(repoRoot).mainRef).toBe('origin/main')
  })

  // without this, "matches main" silently means "matches main as of the last fetch"
  it('fetches when the remote has moved ahead of the local origin/main', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-ref-stale-'))
    const run = initWithRemote(repoRoot)
    const stale = run('rev-parse', 'origin/main').stdout.trim()

    // a second clone advances main, leaving the first checkout's origin/main behind
    const other = mkdtempSync(join(tmpdir(), 'gate-other-'))
    const remote = run('remote', 'get-url', 'origin').stdout.trim()
    spawnSync('git', ['clone', '-q', remote, other])
    const runOther = (...args: string[]) =>
      spawnSync('git', args, { cwd: other, encoding: 'utf8' })
    runOther('config', 'user.email', 'gate@example.com')
    runOther('config', 'user.name', 'gate')
    writeFileSync(join(other, 'README.md'), 'moved on\n')
    runOther('commit', '-qam', 'advance main', '--no-gpg-sign')
    runOther('push', '-q', 'origin', 'main')

    expect(createDefaultDeps(repoRoot).mainRef).toBe('origin/main')
    expect(run('rev-parse', 'origin/main').stdout.trim()).not.toBe(stale)
  })

  it('fails closed when the remote cannot be reached', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-ref-offline-'))
    const run = initWithRemote(repoRoot)
    run('remote', 'set-url', 'origin', join(tmpdir(), 'gate-no-such-remote'))

    expect(() => createDefaultDeps(repoRoot).mainRef).toThrow(
      'Cannot reach origin'
    )
  })
})

describe('lib/ submodule divergence', () => {
  // submodule content is not in this repo's tree, so it is compared by gitlink;
  // an edited dependency changes the deployed bytecode with every src/ file intact
  it('reports a submodule whose checkout has moved off the recorded commit', () => {
    const dep = mkdtempSync(join(tmpdir(), 'gate-dep-'))
    const runDep = (...args: string[]) =>
      spawnSync('git', args, { cwd: dep, encoding: 'utf8' })
    runDep('init', '-b', 'main')
    runDep('config', 'user.email', 'gate@example.com')
    runDep('config', 'user.name', 'gate')
    writeFileSync(join(dep, 'Lib.sol'), 'contract Lib { }\n')
    runDep('add', '.')
    runDep('commit', '-m', 'v1', '--no-gpg-sign')
    const pinned = runDep('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(dep, 'Lib.sol'), 'contract Lib { uint256 public x; }\n')
    runDep('commit', '-qam', 'v2', '--no-gpg-sign')

    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-super-'))
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
    run('init', '-b', 'main')
    run('config', 'user.email', 'gate@example.com')
    run('config', 'user.name', 'gate')
    run(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      dep,
      'lib/dep'
    )
    spawnSync('git', ['checkout', '-q', pinned], {
      cwd: join(repoRoot, 'lib/dep'),
    })
    run('add', '-A')
    run('commit', '-m', 'pin dep', '--no-gpg-sign')
    run('update-ref', 'refs/remotes/origin/main', 'HEAD')

    // called directly rather than through createDefaultDeps so the test exercises the
    // comparison itself, not the remote refresh that resolving the ref would trigger
    expect(divergedSubmodules(repoRoot, 'origin/main')).toEqual([])

    spawnSync('git', ['checkout', '-q', 'main'], {
      cwd: join(repoRoot, 'lib/dep'),
    })

    expect(divergedSubmodules(repoRoot, 'origin/main')).toEqual(['lib/dep'])
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
