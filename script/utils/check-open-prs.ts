/**
 * check-open-prs.ts — deterministic data-collection backend for the
 * `check-open-prs` skill (.agents/commands/check-open-prs.md).
 *
 * Collects ALL mechanical GitHub state in a handful of `gh` calls and prints
 * a finished dashboard (default: human table, `--json`: compact JSON for the
 * skill). Slack thread cross-referencing is deliberately NOT done here — the
 * skill layers that on top, only for PRs flagged `slackCheck: true`.
 *
 * Org-agnostic: the GitHub scope is read from env (LI.FI defaults), so the
 * same script serves any org without code edits:
 *   PR_DASH_ORGS            comma list of owners to search for your own PRs
 *   PR_DASH_INCOMING_REPOS  comma list of owner/repo whose PRs are your review queue
 *
 * Usage:
 *   bunx tsx script/utils/check-open-prs.ts          # human table
 *   bunx tsx script/utils/check-open-prs.ts --json   # compact JSON
 *   bunx tsx script/utils/check-open-prs.ts --quick  # own non-draft PRs only
 */

import { execFileSync } from 'child_process'

// ---------- config (env-overridable; mirrors the skill's scope) ----------
const csv = (raw: string | undefined, fallback: string): string[] =>
  (raw ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const ORGS = csv(process.env.PR_DASH_ORGS, 'lifinance,lifinance-tron')
// Incoming review queue = repos whose PRs land in the review channel(s)
const INCOMING_REPOS = csv(
  process.env.PR_DASH_INCOMING_REPOS,
  'lifinance/contracts,lifinance/contracts-tron'
)
const BOT_RE =
  /(\[bot\]|-bot$|^coderabbitai$|^github-actions$|^lifi-action-bot$|^linear$|^linear-code$|^github-advanced-security$|^aikido-pr-checks$|^lifi-team$|^app\/)/i
// checks that fail because a human review/approval/audit is missing — not restartable
const REVIEW_CI_RE =
  /coderabbit|audit|security|slither|olympix|review|approval|protect-critical/i
// the SC Core Dev Approval gate (job `core-dev-approval`) is RED by default until a core dev
// approves — at which point the PR auto-merges. It is a governance gate, not a CI failure, so on
// its own it must NOT push a PR into CI-RED; the PR instead routes through the normal review-wait
// flow. (A red security/audit gate while core-dev-approval is green is still reported — that case
// genuinely needs a bump.)
const CORE_DEV_GATE_RE = /core-dev-approval|sc core dev approval/i
const INCOMING_LOOKBACK_DAYS = 42 // mirrors the skill's 6-week channel-history window
const STALE_CREATED_DAYS = 42 // 6 weeks
const STALE_UPDATED_DAYS = 14 // 2 weeks
const DORMANT_DAYS = 28 // 4 weeks
const GQL_CHUNK = 40

// GitHub mergeStateStatus → human reason an APPROVED PR still can't merge.
// CLEAN is the only state that merges without intervention; everything else blocks.
const MERGE_STATE_NOTE: Record<string, string> = {
  BLOCKED:
    "approved but merge blocked by branch protection / ruleset (e.g. required reviewer or check) — see the PR's merge box",
  BEHIND: 'approved but branch is behind base — update branch before merging',
  UNSTABLE: 'approved but a required check is still pending/failing',
  DIRTY: 'approved but has merge conflicts',
  HAS_HOOKS: 'approved but a pre-receive hook is blocking the merge',
  DRAFT: 'approved but PR is still a draft',
  UNKNOWN:
    'approved but GitHub is still computing mergeability — re-check shortly',
}

const argv = process.argv.slice(2)
const JSON_MODE = argv.includes('--json')
const QUICK = argv.includes('--quick')
const NOW = Date.now()

const gh = (args: string[]): string =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

const days = (iso: string | null | undefined): number =>
  iso ? (NOW - Date.parse(iso)) / 86400_000 : Infinity

const ago = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = days(iso)
  if (d < 1) return `${Math.round(d * 24)}h`
  if (d < 14) return `${Math.round(d)}d`
  return `${Math.round(d / 7)}w`
}

const isBot = (login: string | null | undefined): boolean =>
  !login || BOT_RE.test(login)

// ---------- 1. seed: who am I + own PRs + incoming PRs ----------
const me: string = JSON.parse(
  gh(['api', 'user', '--jq', '{login: .login}'])
).login

const ownSeed: any[] = JSON.parse(
  gh([
    'search',
    'prs',
    '--author=@me',
    '--state=open',
    '--limit',
    '200',
    ...ORGS.flatMap((o) => ['--owner', o]),
    '--json',
    'url,title,number,repository,createdAt,updatedAt,isDraft',
  ])
)

const excluded: string[] = []
const incomingSeed: any[] = []
if (!QUICK) {
  for (const repo of INCOMING_REPOS) {
    try {
      const rows: any[] = JSON.parse(
        gh([
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--limit',
          '100',
          '--json',
          'number,title,url,author,isDraft,createdAt,updatedAt',
        ])
      )
      incomingSeed.push(
        ...rows
          .filter(
            (r) =>
              r.author?.login !== me &&
              !r.isDraft &&
              !isBot(r.author?.login) &&
              (NOW - Date.parse(r.createdAt)) / 86400_000 <=
                INCOMING_LOOKBACK_DAYS
          )
          .map((r) => ({ ...r, repoFull: repo }))
      )
    } catch {
      // repo may not exist / no access — skip but surface it for auditability
      excluded.push(
        `${repo} (incoming fetch failed — missing repo / no access)`
      )
    }
  }
}

interface ISeed {
  repoFull: string
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  authorLogin: string
}
const seeds: ISeed[] = [
  ...ownSeed.map((p) => ({
    repoFull:
      p.repository?.nameWithOwner ??
      `${p.repository?.owner?.login}/${p.repository?.name}`,
    number: p.number,
    title: p.title,
    url: p.url,
    isDraft: !!p.isDraft,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    authorLogin: me,
  })),
  ...incomingSeed.map((p) => ({
    repoFull: p.repoFull,
    number: p.number,
    title: p.title,
    url: p.url,
    isDraft: false,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    authorLogin: p.author.login,
  })),
]

// ---------- 2. one batched GraphQL call (chunked at 40 aliases) ----------
const PR_FIELDS = `
  number title state isDraft createdAt updatedAt
  author { login }
  reviewDecision
  mergeable mergeStateStatus
  reviews(last: 50) { nodes { author { login } state submittedAt } }
  comments(last: 30) { nodes { author { login } createdAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup {
    state
    contexts(last: 100) { nodes {
      __typename
      ... on CheckRun { name conclusion status }
      ... on StatusContext { context state }
    } }
  } } } }`

const detail: Record<string, any> = {} // key: repoFull#number → { isArchived, pr }
for (let i = 0; i < seeds.length; i += GQL_CHUNK) {
  const chunk = seeds.slice(i, i + GQL_CHUNK)
  const body = chunk
    .map((s, j) => {
      const [owner, name] = s.repoFull.split('/')
      return `pr${j}: repository(owner:"${owner}", name:"${name}") { isArchived pullRequest(number:${s.number}) { ${PR_FIELDS} } }`
    })
    .join('\n')
  const resp = JSON.parse(
    gh(['api', 'graphql', '-f', `query=query { ${body} }`])
  )
  chunk.forEach((s, j) => {
    const node = resp.data[`pr${j}`]
    if (node?.pullRequest)
      detail[`${s.repoFull}#${s.number}`] = {
        isArchived: node.isArchived,
        pr: node.pullRequest,
      }
  })
}

// ---------- 3. classify ----------
interface ICiFailure {
  name: string
  kind: 'review/audit' | 'restartable' | 'core-dev-gate'
}
interface IRow {
  repo: string
  number: number
  title: string
  url: string
  kind: 'own' | 'incoming'
  bucket: string
  draft: boolean
  ci: string // PASS | FAIL | PENDING | NO-CHECKS
  ciFailures: ICiFailure[]
  conflicts: boolean
  reviewDecision: string | null
  mergeStateStatus: string | null
  lastCommitAt: string | null
  lastNonAuthorComment: { author: string; at: string } | null
  myLastReview: { state: string; at: string } | null
  createdAt: string
  updatedAt: string
  author: string
  slackCheck: boolean
  note: string
}

const rows: IRow[] = []

for (const s of seeds) {
  const key = `${s.repoFull}#${s.number}`
  const d = detail[key]
  if (!d) {
    excluded.push(`${key} (no GraphQL data)`)
    continue
  }
  if (d.isArchived) {
    excluded.push(`${key} (archived repo)`)
    continue
  }
  const pr = d.pr
  if (pr.state !== 'OPEN') continue // merged/closed since seed fetch

  const lastCommit = pr.commits?.nodes?.[0]?.commit
  const rollup = lastCommit?.statusCheckRollup
  const ci =
    rollup?.state === 'SUCCESS'
      ? 'PASS'
      : rollup?.state === 'FAILURE' || rollup?.state === 'ERROR'
      ? 'FAIL'
      : rollup?.state === 'PENDING'
      ? 'PENDING'
      : 'NO-CHECKS'

  const ciFailures: ICiFailure[] = (rollup?.contexts?.nodes ?? [])
    .filter(
      (c: any) =>
        (c.__typename === 'CheckRun' &&
          (c.conclusion === 'FAILURE' ||
            c.conclusion === 'TIMED_OUT' ||
            c.conclusion === 'ACTION_REQUIRED')) ||
        (c.__typename === 'StatusContext' &&
          (c.state === 'FAILURE' || c.state === 'ERROR'))
    )
    .map((c: any) => {
      const name = c.name ?? c.context
      const kind = CORE_DEV_GATE_RE.test(name)
        ? ('core-dev-gate' as const)
        : REVIEW_CI_RE.test(name)
        ? ('review/audit' as const)
        : ('restartable' as const)
      return { name, kind }
    })
    // dedupe repeated runs of the same check
    .filter(
      (f: ICiFailure, idx: number, arr: ICiFailure[]) =>
        arr.findIndex((g) => g.name === f.name) === idx
    )

  const conflicts = pr.mergeable === 'CONFLICTING'
  const author = pr.author?.login ?? s.authorLogin

  // events by humans-other-than-author (comments + reviews), and the latest one
  const events: { login: string; at: string }[] = [
    ...(pr.comments?.nodes ?? []).map((c: any) => ({
      login: c.author?.login,
      at: c.createdAt,
    })),
    ...(pr.reviews?.nodes ?? []).map((r: any) => ({
      login: r.author?.login,
      at: r.submittedAt,
    })),
  ].filter((e) => e.login && e.at)
  const nonAuthorHuman = events
    .filter((e) => e.login !== author && !isBot(e.login))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const lastNonAuthor = nonAuthorHuman.at(-1) ?? null

  const myReviews = (pr.reviews?.nodes ?? [])
    .filter((r: any) => r.author?.login === me && r.state !== 'PENDING')
    .sort(
      (a: any, b: any) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)
    )
  const myLastReview = myReviews.at(-1) ?? null

  const base: Omit<IRow, 'bucket' | 'slackCheck' | 'note'> = {
    repo: s.repoFull,
    number: s.number,
    title: s.title,
    url: s.url,
    kind: s.authorLogin === me ? 'own' : 'incoming',
    draft: !!pr.isDraft,
    ci,
    ciFailures,
    conflicts,
    reviewDecision: pr.reviewDecision ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    lastCommitAt: lastCommit?.committedDate ?? null,
    lastNonAuthorComment: lastNonAuthor
      ? { author: lastNonAuthor.login, at: lastNonAuthor.at }
      : null,
    myLastReview: myLastReview
      ? { state: myLastReview.state, at: myLastReview.submittedAt }
      : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    author,
  }

  let bucket = ''
  let slackCheck = false
  let note = ''

  if (base.kind === 'own') {
    const stale =
      days(s.createdAt) >= STALE_CREATED_DAYS &&
      days(s.updatedAt) >= STALE_UPDATED_DAYS
    // The core-dev-approval gate is red by default until reviewed — on its own it is not a CI
    // failure. Only genuine failures (tests, security/audit gates, restartable jobs) make a PR red.
    const realFailures = ciFailures.filter((f) => f.kind !== 'core-dev-gate')
    const ciRed = ci === 'FAIL' && realFailures.length > 0
    if (pr.isDraft) {
      if (stale) bucket = 'STALE'
      else if (/^chore\((claude|skills)\): sync/i.test(s.title))
        bucket = 'OWN-DRAFT/SYNC-PR'
      else if (days(base.lastCommitAt) >= DORMANT_DAYS)
        bucket = 'OWN-DRAFT/DORMANT'
      else if (ciRed || /\(WIP\)|\bWIP\b/.test(s.title))
        bucket = 'OWN-DRAFT/NEEDS-WORK'
      else bucket = 'OWN-DRAFT/READY-TO-FLIP'
    } else if (stale) {
      bucket = 'STALE'
    } else if (conflicts) {
      bucket = 'CONFLICTS'
    } else if (ciRed) {
      bucket = 'CI-RED'
      note = realFailures.some((f) => f.kind === 'review/audit')
        ? 'review/audit checks failing — may need a review pass, not a restart'
        : 'failures look restartable'
    } else if (base.reviewDecision === 'APPROVED') {
      // APPROVED + green checks is necessary but not sufficient: branch protection /
      // rulesets can still block the merge. Only CLEAN is actually mergeable now.
      if (base.mergeStateStatus === 'CLEAN') {
        bucket = 'READY-TO-MERGE'
      } else {
        bucket = 'APPROVED-BLOCKED'
        note =
          MERGE_STATE_NOTE[base.mergeStateStatus ?? ''] ??
          `approved but merge state is ${
            base.mergeStateStatus ?? 'UNKNOWN'
          } — not mergeable yet`
      }
    } else if (
      base.reviewDecision === 'CHANGES_REQUESTED' ||
      (lastNonAuthor &&
        Date.parse(lastNonAuthor.at) >
          Date.parse(base.lastCommitAt ?? s.createdAt))
    ) {
      bucket = 'WAITING-ON-ME'
      slackCheck = true
    } else {
      bucket = 'WAITING-ON-TEAM'
      slackCheck = true // skill checks the review thread: who replied last / 48h cooldown
    }
  } else {
    // incoming queue (GitHub-only approximation; Slack signal verified by the skill)
    const anyHumanReview = (pr.reviews?.nodes ?? []).some(
      (r: any) => !isBot(r.author?.login) && r.state !== 'PENDING'
    )
    const newCommitsSinceMyReview =
      myLastReview &&
      base.lastCommitAt &&
      Date.parse(base.lastCommitAt) > Date.parse(myLastReview.submittedAt)
    if (!anyHumanReview) {
      bucket = 'INBOX-UNREVIEWED'
    } else if (myLastReview?.state === 'APPROVED') {
      bucket = 'DONE-BY-ME'
    } else if (myLastReview && newCommitsSinceMyReview) {
      bucket = 'MAYBE-REREVIEW'
      slackCheck = true // skill confirms an explicit author re-review signal in Slack
      note = 'new commits since my review — verify re-review signal in Slack'
    } else if (myLastReview) {
      bucket = 'WAITING-ON-AUTHOR'
    } else {
      bucket = 'WAITING-ON-OTHERS'
    }
  }

  rows.push({ ...base, bucket, slackCheck, note })
}

// ---------- 4. output ----------
const stamp = new Date(NOW).toISOString()

if (JSON_MODE) {
  const compact = rows.map((r) => ({
    repo: r.repo,
    n: r.number,
    title: r.title.slice(0, 80),
    url: r.url,
    kind: r.kind,
    bucket: r.bucket,
    draft: r.draft || undefined,
    ci: r.ci,
    ciFail: r.ciFailures.length ? r.ciFailures : undefined,
    conflicts: r.conflicts || undefined,
    decision: r.reviewDecision ?? undefined,
    mergeState: r.mergeStateStatus ?? undefined,
    lastCommit: r.lastCommitAt ?? undefined,
    lastNonAuthor: r.lastNonAuthorComment ?? undefined,
    myReview: r.myLastReview ?? undefined,
    author: r.kind === 'incoming' ? r.author : undefined,
    created: r.createdAt,
    updated: r.updatedAt,
    slackCheck: r.slackCheck || undefined,
    note: r.note || undefined,
  }))
  console.log(
    JSON.stringify(
      { asOf: stamp, me, quick: QUICK, prs: compact, excluded },
      null,
      0
    )
  )
} else {
  const ORDER = [
    'WAITING-ON-ME',
    'CI-RED',
    'CONFLICTS',
    'READY-TO-MERGE',
    'APPROVED-BLOCKED',
    'WAITING-ON-TEAM',
    'OWN-DRAFT/READY-TO-FLIP',
    'OWN-DRAFT/NEEDS-WORK',
    'OWN-DRAFT/DORMANT',
    'OWN-DRAFT/SYNC-PR',
    'STALE',
    'INBOX-UNREVIEWED',
    'MAYBE-REREVIEW',
    'WAITING-ON-AUTHOR',
    'WAITING-ON-OTHERS',
    'DONE-BY-ME',
  ]
  console.log(
    `# PR dashboard — as of ${stamp}  (user: ${me}${
      QUICK ? ', quick mode' : ''
    })\n`
  )
  for (const b of ORDER) {
    const group = rows.filter((r) => r.bucket === b)
    if (!group.length) continue
    if (['WAITING-ON-AUTHOR', 'WAITING-ON-OTHERS', 'DONE-BY-ME'].includes(b)) {
      console.log(
        `## ${b}: ${group.length} (suppressed — ${group
          .map((r) => `#${r.number}`)
          .join(' ')})`
      )
      continue
    }
    console.log(`## ${b} (${group.length})`)
    for (const r of group.sort(
      (a, b2) => Date.parse(a.createdAt) - Date.parse(b2.createdAt)
    )) {
      const onlyCoreDevGate =
        r.ci === 'FAIL' &&
        r.ciFailures.length > 0 &&
        r.ciFailures.every((f) => f.kind === 'core-dev-gate')
      const bits = [
        `${r.repo}#${r.number}`,
        r.title.length > 60 ? r.title.slice(0, 57) + '…' : r.title,
        `CI:${onlyCoreDevGate ? 'awaiting-core-dev-approval' : r.ci}`,
        r.conflicts ? 'CONFLICTS' : null,
        r.kind === 'incoming' ? `by ${r.author}` : null,
        r.lastNonAuthorComment
          ? `last-non-author: ${r.lastNonAuthorComment.author} ${ago(
              r.lastNonAuthorComment.at
            )} ago`
          : null,
        `commit ${ago(r.lastCommitAt)} ago`,
        `age ${ago(r.createdAt)}`,
        r.slackCheck ? '→ slack-check' : null,
        r.note || null,
      ].filter(Boolean)
      console.log(`  - ${bits.join(' | ')}`)
      if (r.ciFailures.length)
        console.log(
          `      failing: ${r.ciFailures
            .map((f) => `${f.name} [${f.kind}]`)
            .join(', ')}`
        )
    }
    console.log('')
  }
  if (excluded.length) console.log(`Excluded: ${excluded.join('; ')}`)
}
