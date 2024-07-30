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
  },
  async run({ args }) {
    console.log(await getOpenPRsForBranch(args.branch, args.token))
    return false
  },
})

runMain(main)

const getOpenPRsForBranch = async (branch: string, token: string) => {
  const octokit = new Octokit({
    auth: token,
  })

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
  owner: string,
  repo: string,
  pr_id: number,
  token: string
) => {
  try {
    const octokit = new Octokit({ auth: token })
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: pr_id,
    })

    const approvers = reviews
      .filter((review) => review.state === 'APPROVED')
      .map((review) => review.user?.login)

    return approvers
  } catch (err) {
    console.error(err)
  }
}
