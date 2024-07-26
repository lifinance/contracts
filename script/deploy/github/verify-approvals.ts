import { Octokit } from '@octokit/rest'
import { defineCommand, runMain } from 'citty'

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
  },
  async run({ args }) {
    console.log(args.branch)
    return false
  },
})

runMain(main)

// const getOpenPRsForBranch = async (
//   owner: string,
//   repo: string,
//   branch: string,
//   token: string
// ) => {
//   const octokit = new Octokit({
//     auth: token,
//   });

//   let pullRequests = [];
//   let page = 1;

//   while (true) {
//     const { data: pullsForPage } = await octokit.pulls.list({
//       owner: owner,
//       repo: repo,
//       state: 'open',
//       per_page: 100,
//       page: page++
//     });

//     if (pullsForPage.length === 0) break;

//     pullRequests = [...pullRequests, ...pullsForPage];
//   }

//   const openPrsForBranch = pullRequests.filter(pr => pr.head.ref ===
//     branch);

//   return openPrsForBranch;
// }

// const getPRApprovers = async (
//   owner: string,
//   repo: string,
//   pr_id: number,
//   token: string
// ) => {
//   try {
//     const octokit = new Octokit({ auth: token });
//     const { data: reviews } = await octokit.pulls.listReviews({
//       owner,
//       repo,
//       pull_number: pr_id,
//     });

//     const approvers = reviews
//       .filter(review => review.state === "APPROVED")
//       .map(review => review.user.login);

//     return approvers;
//   } catch (error) {
//     console.error(`Error: ${error.message}`);
//   }
// }
