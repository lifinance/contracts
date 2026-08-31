/**
 * Cron-liveness watchdog.
 *
 * Every scheduled workflow in this repo alerts on its own failures, but none of
 * them can alert on never having run: a dropped schedule, a workflow GitHub
 * disabled for inactivity, or a job that dies before reaching its Slack step all
 * look exactly like a quiet, healthy day. This job watches for that absence.
 *
 * Scope is discovered, never configured: the workflow directory at the checked-out
 * ref IS the authoritative list of schedules (GitHub only runs `schedule` triggers
 * from the default branch), so a new cron is covered the moment its PR merges and
 * a deleted one drops out on its own. Opt out with `# watchdog:ignore <reason>`
 * in the workflow's own YAML.
 *
 * Usage:
 *   bunx tsx script/utils/checkCronLiveness.ts --dry-run
 *   bunx tsx script/utils/checkCronLiveness.ts --heartbeat
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  composeSlackMessage,
  evaluateLiveness,
  extractCronExpressions,
  findIgnoreMarker,
  isAlertable,
} from './cronLiveness'
import type { ILivenessVerdict, IWorkflowFacts } from './cronLiveness'
import { fetchWithTimeout } from './fetchWithTimeout'

const GITHUB_API = 'https://api.github.com'
const WORKFLOW_DIR = '.github/workflows'
const DEFAULT_OWNER = 'lifinance'
const DEFAULT_REPO = 'contracts'

/** The slice of GitHub's workflow object this job reads. */
interface IRegisteredWorkflow {
  id: number
  name: string
  path: string
  /** `active`, `disabled_manually` or `disabled_inactivity`. */
  state: string
}

interface IWorkflowRun {
  created_at: string
}

/**
 * GitHub REST GET via the repo's mandated timeout helper ([CONV:FETCH-TIMEOUT]).
 *
 * Throws on a non-2xx so a token or permission problem surfaces as a red run
 * rather than as an empty result that would read as "nothing is scheduled".
 */
async function githubGet<T>(path: string, token: string): Promise<T> {
  const response = await fetchWithTimeout(`${GITHUB_API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  })

  if (!response.ok)
    throw new Error(
      `GitHub API ${path} returned HTTP ${response.status} ${response.statusText}`
    )

  return (await response.json()) as T
}

interface IScheduledWorkflowFile {
  path: string
  cronExpressions: string[]
  ignore: ReturnType<typeof findIgnoreMarker>
}

/** Every workflow file at this ref that declares an `on.schedule` block. */
function discoverScheduledWorkflows(): IScheduledWorkflowFile[] {
  const entries = readdirSync(WORKFLOW_DIR).filter((file) =>
    /\.ya?ml$/.test(file)
  )

  return entries
    .map((file) => {
      const path = `${WORKFLOW_DIR}/${file}`
      const contents = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
      return {
        path,
        cronExpressions: extractCronExpressions(contents),
        ignore: findIgnoreMarker(contents),
      }
    })
    .filter((workflow) => workflow.cronExpressions.length > 0)
}

/**
 * When the workflow file first landed, bounding how long it has had to fire.
 *
 * Returns null in a shallow checkout, where the answer is unknowable rather than
 * "never" — the caller must not read that as evidence of staleness.
 */
function firstCommitDate(path: string): Date | null {
  try {
    const output = execFileSync(
      'git',
      ['log', '--format=%cI', '--reverse', '--', path],
      { encoding: 'utf8' }
    )
    const first = output.split('\n')[0]?.trim()
    return first ? new Date(first) : null
  } catch {
    return null
  }
}

const main = defineCommand({
  meta: {
    name: 'checkCronLiveness',
    description:
      'Alerts when a scheduled workflow stops running, is disabled, or cannot be watched',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Print the verdict table without posting to Slack',
      default: false,
    },
    heartbeat: {
      type: 'boolean',
      description: 'Post the green summary even when nothing is wrong',
      default: false,
    },
    token: {
      type: 'string',
      description:
        'GitHub token; prefer the GH_TOKEN env var so it stays out of the process table',
    },
  },
  async run({ args }) {
    const [owner, repo] = (
      process.env.GITHUB_REPOSITORY ?? `${DEFAULT_OWNER}/${DEFAULT_REPO}`
    ).split('/') as [string, string]

    // GH_TOKEN over GITHUB_TOKEN: Actions silently drops `env:` assignments to
    // reserved GITHUB_* names, so a workflow that set GITHUB_TOKEN would fall back
    // to the runner default and work only by coincidence ([CONV:ACTIONS-NO-INJECTION]).
    const token = args.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
    if (!token) {
      consola.error('No GitHub token: pass --token or set GH_TOKEN.')
      process.exit(1)
    }

    const scheduled = discoverScheduledWorkflows()
    consola.info(
      `Discovered ${scheduled.length} scheduled workflow(s) in ${WORKFLOW_DIR}`
    )

    const registered = await listRegisteredWorkflows(owner, repo, token)
    const byPath = new Map(
      registered.map((workflow) => [workflow.path, workflow])
    )

    const now = new Date()
    const verdicts: ILivenessVerdict[] = []

    for (const workflow of scheduled) {
      const registration = byPath.get(workflow.path)

      // A file on the default branch that Actions does not know about will never
      // fire; surfacing it as a non-active state routes it to the same alert.
      const state = registration?.state ?? 'not_registered_with_actions'

      let lastScheduledRunAt: Date | null = null
      if (registration)
        // event=schedule is load-bearing: a manual workflow_dispatch run is not
        // evidence that the SCHEDULE still fires, and counting it would hide
        // exactly the failure this job looks for.
        try {
          const { workflow_runs: runs } = await githubGet<{
            workflow_runs: IWorkflowRun[]
          }>(
            `/repos/${owner}/${repo}/actions/workflows/${registration.id}/runs?event=schedule&per_page=1`,
            token
          )
          const latest = runs[0]
          lastScheduledRunAt = latest ? new Date(latest.created_at) : null
        } catch (error) {
          consola.warn(
            `Could not read runs for ${workflow.path}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }

      const facts: IWorkflowFacts = {
        name: registration?.name ?? workflow.path,
        path: workflow.path,
        state,
        cronExpressions: workflow.cronExpressions,
        ignore: workflow.ignore,
        lastScheduledRunAt,
        fileFirstSeenAt: firstCommitDate(workflow.path),
      }

      verdicts.push(evaluateLiveness(facts, now))
    }

    verdicts.sort((a, b) => a.name.localeCompare(b.name))
    for (const verdict of verdicts) {
      const line = `${verdict.status.padEnd(18)} ${verdict.name} — ${
        verdict.detail
      }`
      if (isAlertable(verdict.status)) consola.warn(line)
      else consola.info(line)
    }

    const message = composeSlackMessage(verdicts, {
      heartbeat: args.heartbeat,
      runUrl: process.env.GITHUB_RUN_ID
        ? `https://github.com/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : `https://github.com/${owner}/${repo}/actions`,
    })

    const alertCount = verdicts.filter((verdict) =>
      isAlertable(verdict.status)
    ).length

    if (message === null)
      consola.success('All scheduled workflows alive; staying silent.')
    else if (args['dry-run']) {
      consola.info('--dry-run: the message below would be posted to Slack')
      consola.log(message)
    } else await postToSlack(message)

    if (alertCount > 0) process.exit(1)
  },
})

/** Every workflow registered with Actions, following pagination to the last page. */
async function listRegisteredWorkflows(
  owner: string,
  repo: string,
  token: string
): Promise<IRegisteredWorkflow[]> {
  const perPage = 100
  const collected: IRegisteredWorkflow[] = []

  for (let page = 1; ; page++) {
    const { workflows } = await githubGet<{ workflows: IRegisteredWorkflow[] }>(
      `/repos/${owner}/${repo}/actions/workflows?per_page=${perPage}&page=${page}`,
      token
    )
    collected.push(...workflows)
    if (workflows.length < perPage) return collected
  }
}

/**
 * Post to the CI notifications channel.
 *
 * A webhook that is unset or refuses the message fails the run: an alerting job
 * that silently fails to alert is worse than no alerting job, because it looks
 * like coverage.
 */
async function postToSlack(message: string): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS
  if (!webhookUrl) {
    consola.error(
      'WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS is unset, so the cron-liveness alert cannot be delivered. Set the SLACK_WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS repository secret.'
    )
    process.exit(1)
  }

  const response = await fetchWithTimeout(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })

  // Slack's incoming webhooks answer 200 'ok' as a plain body, so a 2xx alone is
  // not proof of delivery.
  const body = (await response.text()).trim()
  if (!response.ok || body !== 'ok') {
    consola.error(
      `Slack rejected the cron-liveness alert: HTTP ${response.status} '${body}'`
    )
    process.exit(1)
  }

  consola.success('Posted cron-liveness status to Slack.')
}

void runMain(main)
