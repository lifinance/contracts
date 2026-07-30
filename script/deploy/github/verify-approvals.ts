/**
 * Checks that the open pull request for a branch carries the approvals required
 * before facet upgrades may be proposed to the Safe.
 *
 * Consumed by `script/deploy/deployUpgradesToSAFE.sh`, which gates on the exit
 * code: 0 means "approved, keep going", any non-zero exit means "stop". Every
 * lookup failure therefore has to surface as a non-zero exit rather than as an
 * empty result that would read as "nothing to complain about".
 */
import { Octokit } from '@octokit/rest'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

const OWNER = 'lifinance'
const REPO = 'contracts'
const PER_PAGE = 100 // GitHub's maximum page size, so paginated calls need the fewest requests

/** The pull request facts the approval policy is evaluated against. */
export interface IApprovalCheckInput {
  facets: string[]
  changedFiles: string[]
  scTeam: string[]
  auditors: string[]
  approvers: string[]
}

/**
 * Splits the newline-separated `--facets` value into facet names.
 * @param raw - raw CLI value (the shell caller may append blank or trailing lines)
 * @returns trimmed facet names with empty entries removed
 */
export const parseFacetList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split('\n')
    .map((facet) => facet.trim())
    .filter((facet) => facet.length > 0)

/**
 * Resolves the GitHub token to authenticate the approval lookups with.
 * @param cliToken - value passed via `--token`; empty when the caller has none configured
 * @returns the resolved, non-empty token
 * @throws If neither the CLI argument nor the environment provides a token, so the
 * check can never degrade into unauthenticated lookups that see no teams or reviews.
 */
export const resolveGithubToken = (cliToken: string | undefined): string => {
  const token = cliToken?.trim() || process.env.GH_TOKEN?.trim()

  if (!token)
    throw new Error(
      'No GitHub token available: pass --token or set GH_TOKEN in your .env (see .env.example). ' +
        'It must be a personal access token with the "repo" and "read:org" scopes so this check ' +
        'can read pull request reviews and team membership.'
    )

  return token
}

/**
 * Collects every reason the pull request fails the approval policy. Pure, so the
 * policy can be exercised without touching the GitHub API.
 * @param input - facets being deployed plus the pull request facts fetched from GitHub
 * @returns one message per violation; an empty array means the pull request is approved
 */
export const collectApprovalFailures = (
  input: IApprovalCheckInput
): string[] => {
  const { facets, changedFiles, scTeam, auditors, approvers } = input
  const failures: string[] = []

  if (facets.length === 0) failures.push('No facets were passed to the check')

  for (const facet of facets)
    if (!changedFiles.includes(`src/Facets/${facet}.sol`))
      failures.push(`${facet} is not included in this PR`)

  if (scTeam.length === 0 || auditors.length === 0)
    failures.push('Team members not configured correctly')

  if (approvers.length === 0) failures.push('No approvals')

  const scApproved = scTeam.some((dev) => approvers.includes(dev))
  const auditorApproved = auditors.some((auditor) =>
    approvers.includes(auditor)
  )

  if (!scApproved || !auditorApproved)
    failures.push('Missing required approvals')

  return failures
}

/**
 * Lists the open pull requests whose head is the given branch.
 * @param octokit - authenticated GitHub client
 * @param branch - branch name to match against each pull request's head ref
 * @returns the matching open pull requests
 * @throws If the GitHub API call fails.
 */
const getOpenPRsForBranch = async (octokit: Octokit, branch: string) => {
  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner: OWNER,
    repo: REPO,
    state: 'open',
    per_page: PER_PAGE,
  })

  return pullRequests.filter((pullRequest) => pullRequest.head.ref === branch)
}

/**
 * Lists the files a pull request adds or modifies.
 * @param octokit - authenticated GitHub client
 * @param pullNumber - pull request number
 * @returns every added or modified file path across all pages
 * @throws If the GitHub API call fails.
 */
export const getFilesInPR = async (
  octokit: Octokit,
  pullNumber: number
): Promise<string[]> => {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: OWNER,
    repo: REPO,
    pull_number: pullNumber,
    per_page: PER_PAGE,
  })

  return files
    .filter((file) => file.status === 'modified' || file.status === 'added')
    .map((file) => file.filename)
}

/**
 * Lists the logins whose current review state approves the pull request.
 * @param octokit - authenticated GitHub client
 * @param pullNumber - pull request number
 * @returns the logins whose latest state-changing review is an approval
 * @throws If the GitHub API call fails.
 */
const getPRApprovers = async (
  octokit: Octokit,
  pullNumber: number
): Promise<string[]> => {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: OWNER,
    repo: REPO,
    pull_number: pullNumber,
    per_page: PER_PAGE,
  })

  // Reviews arrive oldest-first and include every historical submission, so keep only
  // each user's latest state-changing review: a later CHANGES_REQUESTED (or a dismissal)
  // supersedes that user's earlier approval, while COMMENTED reviews leave it standing.
  const stateChangingReviews = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']
  const latestStateByLogin = new Map<string, string>()
  for (const review of reviews) {
    const login = review.user?.login
    if (login && stateChangingReviews.includes(review.state))
      latestStateByLogin.set(login, review.state)
  }

  return [...latestStateByLogin.entries()]
    .filter(([, state]) => state === 'APPROVED')
    .map(([login]) => login)
}

/**
 * Lists the members of an organisation team.
 * @param octokit - authenticated GitHub client
 * @param team - team slug
 * @returns the member logins across all pages
 * @throws If the GitHub API call fails.
 */
const getTeamMembers = async (
  octokit: Octokit,
  team: string
): Promise<string[]> => {
  try {
    const members = await octokit.paginate(
      octokit.rest.teams.listMembersInOrg,
      {
        org: OWNER,
        team_slug: team,
        per_page: PER_PAGE,
      }
    )

    return members.map((member) => member.login)
  } catch (error) {
    // a token without organisation read access fails here, which must not read as "team is empty"
    throw new Error(
      `Failed to load members of the "${team}" team: ${
        error instanceof Error ? error.message : String(error)
      }. The token needs the "read:org" scope for the ${OWNER} organisation.`
    )
  }
}

/**
 * Fetches the pull request facts from GitHub and evaluates the approval policy.
 * @param octokit - authenticated GitHub client
 * @param branch - branch whose open pull request is checked
 * @param facets - facet names about to be deployed
 * @returns one message per violation; empty when the pull request is approved
 * @throws If any GitHub lookup fails, so a failed lookup can never be mistaken for an
 * approved pull request.
 */
export const verifyApprovals = async (
  octokit: Octokit,
  branch: string,
  facets: string[]
): Promise<string[]> => {
  const openPullRequests = await getOpenPRsForBranch(octokit, branch)
  const pullRequest = openPullRequests[0]

  if (!pullRequest) return [`No open PR found for branch "${branch}"`]

  const changedFiles = await getFilesInPR(octokit, pullRequest.number)
  const scTeam = await getTeamMembers(octokit, 'smartcontract')
  const auditors = await getTeamMembers(octokit, 'auditors')
  const approvers = await getPRApprovers(octokit, pullRequest.number)

  return collectApprovalFailures({
    facets,
    changedFiles,
    scTeam,
    auditors,
    approvers,
  })
}

/** The process surface `reportApprovalResult` terminates and prints through. */
export interface IReportTarget {
  stdout: { write: (text: string) => unknown }
  exit: (code: number) => never
}

/**
 * Applies the contract the shell gate relies on: failures go to stderr and terminate
 * the process non-zero, and the success marker reaches stdout only when there is
 * nothing to report.
 * @param failures - violations returned by the approval check
 * @param target - process to print through and terminate; injectable so the exit-code
 * contract can be unit-tested
 */
export const reportApprovalResult = (
  failures: string[],
  target: IReportTarget = process
): void => {
  if (failures.length === 0) {
    target.stdout.write('OK')
    return
  }

  for (const failure of failures) consola.error(failure)
  consola.error(
    `PR approval check failed (${failures.length} issue(s)) - not proceeding`
  )

  target.exit(1)
}

const main = defineCommand({
  meta: {
    name: 'verify-approvals',
    description: 'Checks that a PR has the correct amount of approvals',
  },
  args: {
    branch: {
      type: 'string',
      description: 'The current branch',
      required: true,
    },
    token: {
      type: 'string',
      description: 'Github access token',
    },
    facets: {
      type: 'string',
      description: 'List of facets that should be part of this PR',
      required: true,
    },
  },
  async run({ args }) {
    const octokit = new Octokit({ auth: resolveGithubToken(args.token) })

    const failures = await verifyApprovals(
      octokit,
      args.branch,
      parseFacetList(args.facets)
    )

    reportApprovalResult(failures)
  },
})

if (import.meta.main) runMain(main)
