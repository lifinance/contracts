import { Octokit } from '@octokit/rest'
import { defineCommand, runMain } from 'citty'

const OWNER = 'lifinance'
const REPO = 'contracts'

const main = defineCommand({
  meta: {
    name: 'verify-approvals',
    description: 'Checks that a PR has the correct amount of approvals',
  },
  args: {
    branch: {
      type: 'string',
      description: 'The current branch',
    },
    token: {
      type: 'string',
      description: 'Github access token',
    },
    facets: {
      type: 'string',
      description: 'List of facets that should be part of this PR',
    },
  },
  async run({ args }) {
    // Initialize Octokit
    const octokit = new Octokit({ auth: args.token })

    const facets = args.facets.split('\n')

    // Fetch PR information
    const pr = await getOpenPRsForBranch(octokit, args.branch, args.token)

    // Fetch files related to this PR
    const files = await getFilesInPR(octokit, pr[0].number)

    for (const facet of facets) {
      if (!files?.includes(`src/Facets/${facet}.sol`)) {
        console.error(`${facet} is not included in this PR`)
      }
    }

    // Get smartcontracts team members
    const scTeam = await getTeamMembers(octokit, 'smartcontract')

    // Get auditors team members
    const auditors = await getTeamMembers(octokit, 'auditors')

    if (!scTeam?.length || !auditors?.length) {
      console.error('Team members not configured correctly')
    }

    // Get approvals
    const approvals = await getPRApprovers(octokit, pr[0].number, args.token)

    if (!approvals?.length) {
      console.error('No approvals')
    }

    // Check that 1 of each team sc and auditors has approved the PR
    let scApproved,
      auditorApproved = false
    for (const dev of scTeam) {
      if (approvals?.includes(dev)) {
        scApproved = true
        break
      }
    }
    for (const auditor of auditors) {
      if (approvals?.includes(auditor)) {
        auditorApproved = true
        break
      }
    }
    if (!scApproved || !auditorApproved) {
      console.error('Missing required approvals')
    }

    process.stdout.write('OK')
  },
})

runMain(main)

const getOpenPRsForBranch = async (
  octokit: Octokit,
  branch: string,
  token: string
) => {
  let pullRequests: any[] = []
  let page = 1

  let fetching = true
  while (fetching) {
    const { data: pullsForPage } = await octokit.pulls.list({
      owner: OWNER,
      repo: REPO,
      state: 'open',
      per_page: 100,
      page: page++,
    })

    if (pullsForPage.length === 0) {
      fetching = false
      break
    }

    pullRequests = [...pullRequests, ...pullsForPage]
  }

  const openPrsForBranch = pullRequests.filter((pr) => pr.head.ref === branch)

  return openPrsForBranch
}

const getPRApprovers = async (
  octokit: Octokit,
  pull_number: number,
  token: string
) => {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner: OWNER,
      repo: REPO,
      pull_number: pull_number,
    })

    const approvers = reviews
      .filter((review) => review.state === 'APPROVED')
      .map((review) => review.user?.login)

    return approvers
  } catch (error) {
    console.error(error)
  }
}

const getFilesInPR = async (octokit: Octokit, pull_number: number) => {
  try {
    const result = await octokit.rest.pulls.listFiles({
      owner: OWNER,
      repo: REPO,
      pull_number: pull_number,
    })

    return result.data
      .filter((file) => file.status === 'modified' || file.status === 'added')
      .map((file) => file.filename)
  } catch (error) {
    console.error(error)
  }
}

const getTeamMembers = async (octokit: Octokit, team: string) => {
  try {
    const response = await octokit.teams.listMembersInOrg({
      org: OWNER,
      team_slug: team,
    })

    return response.data.map((t) => t.login) || []
  } catch (error) {
    console.error(error)
  }
}
