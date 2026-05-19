#!/usr/bin/env bunx tsx
/**
 * PreToolUse hook gating PR-creation / PR-update commands on a clean /pr-ready run.
 *
 * Reads the Claude Code PreToolUse JSON payload from stdin and either:
 * - exits 0 (allow) — for unrelated commands or when the gate is satisfied, or
 * - prints a deny JSON decision on stdout and exits 0 — for gated commands when
 *   the gate is not yet satisfied (this surfaces a tool error to the model with
 *   the reason string, so Claude routes into the /pr-ready skill).
 *
 * Gate is satisfied when ANY of:
 *   1. The command contains `PR_READY_OK=1` as a command-prefix env-assignment
 *      (env-var bypass / explicit override).
 *   2. A marker file at `<gitdir>/PR_READY_OK` exists and its mtime is newer
 *      than the HEAD commit's timestamp on the current branch.
 *
 * Match scope (case-insensitive):
 *   - `gh pr create` (any flags, including `--draft`)
 *   - `gh pr ready`  (draft → Ready for Review)
 *   - `git push` — only when the current branch has an OPEN, NON-DRAFT PR.
 *     Pushes on branches without a PR, or to draft PRs, are allowed through so
 *     that WIP iteration stays friction-free. The check is gated on a fast
 *     `gh pr view` lookup; if `gh` is unavailable, unauthenticated, or there's
 *     no PR for the branch, the push is allowed.
 *
 * Everything else (including `gh pr list`, `gh pr view`, `gh issue …`, plain
 * `gh auth`, etc.) is allowed through.
 *
 * Errors are non-fatal: any internal exception falls back to allow, so a broken
 * gate never blocks legitimate work. The model can still be redirected by the
 * soft CLAUDE.md rule in that case.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const SKILL_NAME = '/pr-ready'

// Matches `gh pr create` or `gh pr ready` as a command, tolerating extra
// whitespace and leading env-var / `sudo` / `bun x` / similar prefixes that
// don't change the fact that `gh pr create|ready` is what runs.
const PR_CMD_RE = /(?:^|[;&|`$(\s])gh\s+pr\s+(create|ready)\b/i

// `PR_READY_OK=1` as a command-prefix env-assignment in front of the gated
// command. Only this position counts — `PR_READY_OK=1` buried elsewhere in
// the line (e.g. inside an echo) does not bypass the gate.
const BYPASS_PREFIX_RE =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*PR_READY_OK=1(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+(?:gh\s+pr\s+(?:create|ready)|git\s+push)\b/i

// Matches `git push` (any args). We only enforce when the branch has an open
// non-draft PR — see `pushTargetsReadyPr`.
const GIT_PUSH_RE = /(?:^|[;&|`$(\s])git\s+push\b/i

interface HookPayload {
  tool_name?: string
  tool?: string
  tool_input?: { command?: unknown } & Record<string, unknown>
  cwd?: string
}

const readStdinSync = (): string => {
  // Synchronous stdin read via fd 0; sufficient for the tiny JSON payload
  // Claude Code sends to hooks.
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const readPayload = (): HookPayload => {
  try {
    const raw = readStdinSync()
    return raw.trim() ? (JSON.parse(raw) as HookPayload) : {}
  } catch {
    return {}
  }
}

const deny = (reason: string): never => {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

const allow = (): never => process.exit(0)

const run = (
  cmd: string,
  args: readonly string[],
  cwd: string | undefined,
  timeoutMs: number
): string | null => {
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
    })
    if (r.status !== 0) return null
    return (r.stdout ?? '').trim()
  } catch {
    return null
  }
}

const git = (args: readonly string[], cwd: string | undefined): string | null =>
  run('git', args, cwd, 3000)

const pushTargetsReadyPr = (cwd: string | undefined): boolean => {
  // Best-effort: does the current branch have an OPEN, non-draft PR?
  // False on any error → fail open (allow the push).
  try {
    const r = spawnSync('gh', ['pr', 'view', '--json', 'isDraft,state'], {
      cwd,
      timeout: 4000,
      encoding: 'utf8',
    })
    if (r.status !== 0) return false
    const data = JSON.parse(r.stdout || '{}') as {
      state?: string
      isDraft?: boolean
    }
    return data.state === 'OPEN' && data.isDraft === false
  } catch {
    return false
  }
}

const gateSatisfied = (
  cwd: string | undefined
): { satisfied: boolean; why: string } => {
  const gitdir = git(['rev-parse', '--git-dir'], cwd)
  if (!gitdir) {
    // Not a git repo — let `gh pr create` fail on its own; don't block.
    return { satisfied: true, why: '' }
  }
  const gitdirPath = isAbsolute(gitdir) ? gitdir : resolve(cwd ?? '.', gitdir)
  const markerPath = `${gitdirPath}/PR_READY_OK`

  let markerMtime: number
  try {
    markerMtime = statSync(markerPath).mtimeMs / 1000
  } catch {
    return { satisfied: false, why: 'no marker file' }
  }

  const headTsRaw = git(['log', '-1', '--format=%ct', 'HEAD'], cwd)
  const headTs = headTsRaw ? Number(headTsRaw) : 0
  const headTsNum = Number.isFinite(headTs) ? headTs : 0

  if (markerMtime <= headTsNum) {
    return {
      satisfied: false,
      why: 'marker is not newer than HEAD (new commits since last /pr-ready)',
    }
  }
  return { satisfied: true, why: '' }
}

const main = (): void => {
  const payload = readPayload()
  const toolName = payload.tool_name ?? payload.tool ?? ''
  const toolInput = payload.tool_input ?? {}
  if (toolName !== 'Bash') allow()

  const command = typeof toolInput.command === 'string' ? toolInput.command : ''
  if (!command.trim()) allow()

  const mPr = PR_CMD_RE.exec(command)
  const mPush = !mPr ? GIT_PUSH_RE.exec(command) : null
  if (!mPr && !mPush) allow()

  // Bypass: explicit PR_READY_OK=1 as command-prefix env assignment
  if (BYPASS_PREFIX_RE.test(command)) allow()

  const cwd = payload.cwd ?? process.cwd()

  // For `git push`, only enforce when the current branch has an open,
  // non-draft PR. Pushing on branches without a PR (or on draft PRs) is
  // the WIP path and must stay frictionless.
  if (mPush && !pushTargetsReadyPr(cwd)) allow()

  const { satisfied, why } = gateSatisfied(cwd)
  if (satisfied) allow()

  let blocked: string
  let action: string
  if (mPr) {
    const subcmd = mPr[1].toLowerCase()
    blocked = `gh pr ${subcmd}`
    action =
      subcmd === 'create'
        ? 'create a PR'
        : 'flip a draft PR to Ready for Review'
  } else {
    blocked = 'git push'
    action = 'push new commits to this Ready-for-Review PR'
  }

  const reason =
    `Blocked: \`${blocked}\` requires a clean ${SKILL_NAME} run first (${why}).\n` +
    `\n` +
    `Before you ${action}, run the ${SKILL_NAME} skill on this branch:\n` +
    `  1. It runs \`coderabbit review --base origin/<base> --plain\` locally.\n` +
    `  2. Triages findings into Auto-apply / Ask / Reject.\n` +
    `  3. Re-runs until clean, then writes the gate marker.\n` +
    `\n` +
    `Once ${SKILL_NAME} reports CLEAN (or only documented-deferred items remain) and the\n` +
    `marker file \`$(git rev-parse --git-dir)/PR_READY_OK\` is newer than HEAD, retry this\n` +
    `command. For legitimate emergency bypass (e.g. sensitive security fix), prepend\n` +
    `\`PR_READY_OK=1\` to the command and document the reason in the PR description.`

  deny(reason)
}

try {
  main()
} catch {
  // Fail open: never block on internal error.
  allow()
}
