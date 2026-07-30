import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Octokit } from '@octokit/rest'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  collectApprovalFailures,
  getFilesInPR,
  parseFacetList,
  reportApprovalResult,
  resolveGithubToken,
  verifyApprovals,
  type IReportTarget,
} from './verify-approvals'

const APPROVED_INPUT = {
  facets: ['AcrossFacet'],
  changedFiles: ['src/Facets/AcrossFacet.sol'],
  scTeam: ['dev-one'],
  auditors: ['auditor-one'],
  approvers: ['dev-one', 'auditor-one'],
}

interface IStubResponses {
  pulls?: unknown[]
  files?: unknown[]
  reviews?: unknown[]
  teams?: Record<string, unknown[]>
  failingRoutes?: string[]
}

/**
 * Builds a client that mimics the `octokit.paginate(route, params)` surface the script
 * uses, resolving each route from canned responses instead of hitting GitHub.
 */
function stubOctokit(responses: IStubResponses): Octokit {
  const rest = {
    pulls: {
      list: 'pulls.list',
      listFiles: 'pulls.listFiles',
      listReviews: 'pulls.listReviews',
    },
    teams: { listMembersInOrg: 'teams.listMembersInOrg' },
  }

  const paginate = async (
    route: unknown,
    params: { team_slug?: string } = {}
  ): Promise<unknown[]> => {
    if (responses.failingRoutes?.includes(String(route)))
      throw new Error('Bad credentials')

    if (route === rest.pulls.list) return responses.pulls ?? []
    if (route === rest.pulls.listFiles) return responses.files ?? []
    if (route === rest.pulls.listReviews) return responses.reviews ?? []
    if (route === rest.teams.listMembersInOrg)
      return responses.teams?.[params.team_slug ?? ''] ?? []

    throw new Error(`unexpected route: ${String(route)}`)
  }

  return { paginate, rest } as unknown as Octokit
}

/**
 * Asserts `promise` rejects with an error whose message matches `match`. Kept as a
 * helper (rather than `expect().rejects`) so the awaited value is a real Promise —
 * `@typescript-eslint/await-thenable` rejects awaiting bun's matcher.
 */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toMatch(match)
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

describe('collectApprovalFailures', () => {
  it('reports no failures when every requirement is met', () => {
    expect(collectApprovalFailures(APPROVED_INPUT)).toEqual([])
  })

  it('reports facets that the PR does not touch', () => {
    expect(
      collectApprovalFailures({
        ...APPROVED_INPUT,
        facets: ['AcrossFacet', 'AmarokFacet'],
      })
    ).toEqual(['AmarokFacet is not included in this PR'])
  })

  it('reports an empty facet list', () => {
    expect(
      collectApprovalFailures({ ...APPROVED_INPUT, facets: [] })
    ).toContain('No facets were passed to the check')
  })

  it('reports unusable team lists', () => {
    expect(
      collectApprovalFailures({ ...APPROVED_INPUT, auditors: [] })
    ).toContain('Team members not configured correctly')
  })

  it('reports a PR without any approval', () => {
    expect(
      collectApprovalFailures({ ...APPROVED_INPUT, approvers: [] })
    ).toEqual(['No approvals', 'Missing required approvals'])
  })

  it('requires an approval from both the smart contract team and the auditors', () => {
    expect(
      collectApprovalFailures({ ...APPROVED_INPUT, approvers: ['dev-one'] })
    ).toEqual(['Missing required approvals'])
    expect(
      collectApprovalFailures({ ...APPROVED_INPUT, approvers: ['auditor-one'] })
    ).toEqual(['Missing required approvals'])
  })
})

describe('reportApprovalResult', () => {
  it('writes the success marker to stdout and does not exit on success', () => {
    const target = captureReport()

    reportApprovalResult([], target)

    expect(target.written).toEqual(['OK'])
    expect(target.exitCode).toBeUndefined()
  })

  it('exits non-zero and writes nothing to stdout on failure', () => {
    const target = captureReport()

    reportApprovalResult(['Missing required approvals'], target)

    expect(target.exitCode).toBe(1)
    expect(target.written).toEqual([])
  })
})

describe('getFilesInPR', () => {
  it('returns every file across pages, well beyond the unpaginated 30-file page', async () => {
    const files = Array.from({ length: 45 }, (_, index) => ({
      filename: `src/Facets/Facet${index}.sol`,
      status: 'modified',
    }))

    const result = await getFilesInPR(stubOctokit({ files }), 1)

    expect(result).toHaveLength(45)
    expect(result).toContain('src/Facets/Facet44.sol')
  })

  it('ignores files that are neither added nor modified', async () => {
    const result = await getFilesInPR(
      stubOctokit({
        files: [
          { filename: 'src/Facets/AcrossFacet.sol', status: 'added' },
          { filename: 'src/Facets/OldFacet.sol', status: 'removed' },
        ],
      }),
      1
    )

    expect(result).toEqual(['src/Facets/AcrossFacet.sol'])
  })
})

describe('verifyApprovals', () => {
  const approvedRepo: IStubResponses = {
    pulls: [{ number: 7, head: { ref: 'feature/across' } }],
    files: [{ filename: 'src/Facets/AcrossFacet.sol', status: 'modified' }],
    reviews: [
      { state: 'APPROVED', user: { login: 'dev-one' } },
      { state: 'APPROVED', user: { login: 'auditor-one' } },
      { state: 'COMMENTED', user: { login: 'someone-else' } },
    ],
    teams: {
      smartcontract: [{ login: 'dev-one' }],
      auditors: [{ login: 'auditor-one' }],
    },
  }

  it('returns no failures for an approved PR', async () => {
    expect(
      await verifyApprovals(stubOctokit(approvedRepo), 'feature/across', [
        'AcrossFacet',
      ])
    ).toEqual([])
  })

  it('fails when only a comment, not an approval, is present', async () => {
    expect(
      await verifyApprovals(
        stubOctokit({ ...approvedRepo, reviews: [] }),
        'feature/across',
        ['AcrossFacet']
      )
    ).toEqual(['No approvals', 'Missing required approvals'])
  })

  it('discounts an approval that the same user later superseded with CHANGES_REQUESTED', async () => {
    expect(
      await verifyApprovals(
        stubOctokit({
          ...approvedRepo,
          reviews: [
            ...(approvedRepo.reviews ?? []),
            { state: 'CHANGES_REQUESTED', user: { login: 'auditor-one' } },
          ],
        }),
        'feature/across',
        ['AcrossFacet']
      )
    ).toEqual(['Missing required approvals'])
  })

  it('discounts a dismissed approval', async () => {
    expect(
      await verifyApprovals(
        stubOctokit({
          ...approvedRepo,
          reviews: [
            { state: 'DISMISSED', user: { login: 'dev-one' } },
            { state: 'APPROVED', user: { login: 'auditor-one' } },
          ],
        }),
        'feature/across',
        ['AcrossFacet']
      )
    ).toEqual(['Missing required approvals'])
  })

  it('keeps an approval standing when the same user later merely comments', async () => {
    expect(
      await verifyApprovals(
        stubOctokit({
          ...approvedRepo,
          reviews: [
            ...(approvedRepo.reviews ?? []),
            { state: 'COMMENTED', user: { login: 'auditor-one' } },
          ],
        }),
        'feature/across',
        ['AcrossFacet']
      )
    ).toEqual([])
  })

  it('fails when no open PR exists for the branch', async () => {
    expect(
      await verifyApprovals(stubOctokit({ pulls: [] }), 'feature/orphan', [
        'AcrossFacet',
      ])
    ).toEqual(['No open PR found for branch "feature/orphan"'])
  })

  it('propagates lookup errors instead of returning an empty (approved) result', async () => {
    await expectRejects(
      verifyApprovals(
        stubOctokit({ ...approvedRepo, failingRoutes: ['pulls.listFiles'] }),
        'feature/across',
        ['AcrossFacet']
      ),
      /Bad credentials/
    )
  })

  it('turns an unreadable team into an error rather than an empty team list', async () => {
    await expectRejects(
      verifyApprovals(
        stubOctokit({
          ...approvedRepo,
          failingRoutes: ['teams.listMembersInOrg'],
        }),
        'feature/across',
        ['AcrossFacet']
      ),
      /read:org/
    )
  })
})

describe('verify-approvals CLI', () => {
  it('exits non-zero without printing the success marker when no token is available', () => {
    const env = { ...process.env }
    delete env.GH_TOKEN

    // run outside the repo so a local .env cannot supply a token
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, 'verify-approvals.ts'),
        '--branch',
        'feature/some-branch',
        '--facets',
        'AcrossFacet',
        '--token',
        '',
      ],
      { cwd: tmpdir(), env, encoding: 'utf8' }
    )

    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('OK')
    expect(result.stderr).toContain('GH_TOKEN')
  })
})
