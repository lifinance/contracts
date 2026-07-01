# RCA — Claude Code background jobs killed mid-run during long multi-network proposal runs

**Date:** 2026-06-30 · **Env:** macOS, Claude Code CLI · **Symptom:** `run_in_background: true`
Bash jobs SIGTERM'd (`Terminated: 15`) mid-execution, ~3× in one day, during long-running
multi-network blockchain proposal loops. Eroding trust in overnight / autonomous work.

> Confidence legend — **[CONFIRMED]** directly demonstrated by the incident or stated in
> docs/tool-schema · **[STRONG]** standard harness behavior + incident evidence, not
> contradicted · **[SUSPECTED]** plausible, undocumented, not the leading cause.

---

## TL;DR

The headline cause is **#1: a single Bash invocation hit the wall-clock timeout ceiling and
was SIGTERM'd at ~10 minutes.** The job was launched with `timeout: 900000` (15 min), but the
Bash tool's `timeout` is capped at **600000 ms (10 min)** — values above the ceiling are
**clamped to the max, not rejected** (the job was accepted and ran, then died). `run_in_background:
true` does **not** exempt a job from that wall-clock limit — it only changes whether the agent
*blocks* on it. So the loop got killed mid-iteration the moment it crossed 10 minutes of runtime.

`Terminated: 15` is exactly SIGTERM, which is the timeout-kill signature. Everything matches.

**The fix is not "raise the timeout" — it's "stop putting a >10-min unit of work inside one Bash
call."** Drive the loop at the agent/turn level or in batches, checkpoint per network, and make
the run idempotent so a kill loses at most one item. Details in the Playbook below.

---

## Evidence from the incident (what we can state without any docs)

These are demonstrated by the failure itself, independent of documentation:

1. **The job was killed by SIGTERM.** `Terminated: 15` is the shell's report of signal 15 =
   `SIGTERM`. This is a *deliberate* termination, not a crash, OOM (`SIGKILL`/137), or a script
   error (which would print a stack/error and a non-signal exit code). **[CONFIRMED]**
2. **The job was accepted and ran for a long time before dying.** So `timeout: 900000` was
   **not rejected** as an invalid parameter — an `InputValidationError` would have blocked the
   call up front, never letting it run ~57 iterations. The only way to "run then get SIGTERM'd
   around the 10-min mark" is **clamp-to-ceiling**, then **timeout fires**. **[CONFIRMED by
   behavior]**
3. **The background flag did not save it.** The job *was* `run_in_background: true` and was
   *still* terminated. Whatever killed it applies to background jobs. **[CONFIRMED]**
4. **Timing corroboration.** 57 of 69 iterations completed before the kill → ~10.5 s/iteration
   → 69 iterations would need ~12 min, i.e. *past* the 10-min wall. The cutoff lands exactly
   where a 600000 ms limit would fire. (Per-iteration time is illustrative, but the shape fits.)

## What the docs / tool schema confirm

- Bash `timeout`: **2 min default, 10 min (600000 ms) ceiling.** Overridable via
  `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS`. (Claude Code tools reference + env-vars
  docs.) The in-session Bash tool schema states `timeout` **"max 600000"**. **[CONFIRMED]**
- **Background Bash and monitor tasks are never restored on `claude --resume` / `--continue`.**
  (Scheduled-tasks docs.) **[CONFIRMED]**
- **Tasks only fire while Claude Code is running and idle. Closing the terminal or letting the
  session exit stops them.** (Scheduled-tasks docs, re `/loop`.) Background Bash children are
  children of the CLI process, so the same lifecycle bound applies. **[STRONG]**
- The public docs do **not** specify: clamp-vs-reject, the timeout signal, any grace period,
  whether background jobs inherit the per-command timeout, or compaction behavior. Those gaps
  are why this RCA leans on incident evidence for #1. (Worth a `/feedback` to Anthropic.)

## What this repo's config does **not** do (ruled out)

Inspected `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`,
`.agents/hooks/*`, `.claude/scripts/*`:

- **No `Stop` / `SubagentStop` hooks** anywhere → nothing hook-driven kills a running job.
- All `PostToolUse` hooks ([post-edit-format.sh](.agents/hooks/post-edit-format.sh),
  [post-edit-validate.sh](.agents/hooks/post-edit-validate.sh)) read stdin, act on the *edited
  file*, and unconditionally `exit 0`. They never signal other PIDs.
- `PreToolUse` Bash hooks (`pr-ready-gate.ts/.py`, signing gate) gate *new* Bash calls; they
  cannot reach an already-running background PID.
- **No timeout env vars set** in any settings file → `BASH_MAX_TIMEOUT_MS` is at its **default
  ceiling of 600000 ms.** This is precisely why a 15-min request got clamped to 10 min.

Repo config is **not** a contributing cause — but the *absence* of a raised `BASH_MAX_TIMEOUT_MS`
is what leaves the 10-min ceiling in force.

---

## Prioritized root causes

| # | Root cause | Status | Why it's the cause / how it bites |
|---|------------|--------|-----------------------------------|
| **1** | **Single Bash invocation exceeded the 10-min wall-clock ceiling; `timeout: 900000` clamped to 600000; SIGTERM at ~10 min.** | **[CONFIRMED]** | Direct match: SIGTERM, ran-then-died, killed mid-iteration ~10 min in. **This explains all ~3 kills** if each "run" was one long background loop. |
| 2 | **`run_in_background: true` is not exempt from the per-command timeout.** | **[CONFIRMED]** | The killed job *was* backgrounded. Background changes blocking behavior, not lifetime. A 12-min job dies at 10 min whether foreground or background. |
| 3 | **Job tied to CLI/session lifecycle — not restored on resume; dies on session exit.** | **[STRONG]** | If a session was closed, resumed, or rolled over (`--resume`/`--continue`) while a loop ran, the loop is gone. Secondary here (signal was SIGTERM-at-10-min, not session-end), but a real overnight risk. |
| 4 | **Context compaction / summarization during a long idle wait.** | **[SUSPECTED]** | Compaction runs *within* a live session and shouldn't reap the child PID, but it's undocumented. Not the leading cause (timing points to the timeout), but cannot be fully excluded. |
| 5 | **No checkpoint/idempotency → a kill loses the whole run, not one item.** | **[CONFIRMED, amplifier]** | Not what *caused* the kill, but what made each kill *expensive* (lost ~57 iterations of progress) and erodes trust. The fix that matters most operationally. |

---

## Playbook — running long (>10 min) multi-step jobs reliably

Ordered by leverage. Do #1–#3 always; they make the timeout a non-event instead of a disaster.

### 1. Never put a >10-min unit of work inside one Bash call

The ceiling is real and silent. Two ways to live within it:

- **Batch at the call level (preferred).** Split N networks into chunks that each finish
  comfortably under ~8 min (leave headroom). One Bash call per chunk, foreground. The *agent*
  drives the loop across calls — each call is a fresh timeout budget. 69 networks at ~10 s each
  → run in chunks of ~30, three calls, none near the wall.
- **Raise the ceiling (situational).** Set in `.claude/settings.json`:
  ```json
  { "env": { "BASH_DEFAULT_TIMEOUT_MS": "600000", "BASH_MAX_TIMEOUT_MS": "3600000" } }
  ```
  This raises the per-command ceiling to 60 min. **Verify it actually takes effect** (the
  in-session tool schema may still advertise 600000; enforcement uses the env var). Treat as a
  cushion, not a substitute for batching + checkpointing — a 55-min monolith that dies at 54 min
  still loses everything.

> Note: `.env` is symlinked/shared across worktrees, but these go in `settings.json` (not `.env`),
> so they're worktree-scoped and safe to set here.

### 2. Checkpoint per item — a kill must lose at most one network

Make the loop write a state file after each network, and **skip already-done networks on
re-entry**. This is the single highest-trust change: a kill becomes "resume from network 58,"
not "redo all 69."

```bash
STATE="$SCRATCH/proposal-progress.json"   # outside the repo tree
done() { jq -e --arg n "$1" '.[$n]==true' "$STATE" >/dev/null 2>&1; }
mark() { tmp=$(mktemp); jq --arg n "$1" '.[$n]=true' "$STATE" >"$tmp" && mv "$tmp" "$STATE"; }

for NET in $NETWORKS; do
  done "$NET" && { echoDebug "skip $NET (already proposed)"; continue; }
  proposeForNetwork "$NET"            # the real work
  mark "$NET"
done
```

This dovetails with the repo's existing **[CONV:PARALLEL-WORK]** rule (`.agents/rules/300-bash.md`):
throttle with `MAX_CONCURRENT_JOBS`, have each worker write its result to a per-item file, and
aggregate after `wait`. Per-item files *are* your checkpoints — reuse `processNetworkLine` /
`executeNetworkInGroup` plumbing rather than reinventing it.

### 3. Make the run idempotent / resumable

Re-running must be safe and cheap. Beyond the checkpoint file, prefer a **source-of-truth check**
over trusting local state: before proposing for a network, query whether the proposal already
exists (Safe / MongoDB) and skip if so. (Use `--no-use-cache` on `query-deployment-logs.ts` for
authoritative reads — the default local cache goes stale after parallel runs; see memory
`mongo-deploy-query-cache-stale`.) Then a kill, a stale checkpoint, or a re-run all converge to
the same correct end state.

### 4. Poll/await background jobs safely (don't rely on one giant blocking job)

When you *do* background something, drive it across turns instead of one long wait:

- Launch with `run_in_background: true`, then **poll** its output between turns rather than
  blocking a single 10-min foreground call. Background jobs keep running while the agent works;
  the agent is re-invoked on completion via the task-notification.
- For a self-paced supervisory loop, use **`/loop`** (or `ScheduleWakeup` in dynamic mode) to
  wake periodically and check progress — but remember `/loop` and background tasks **only fire
  while the CLI is running and idle.** They are not a substitute for a real overnight scheduler.
- For genuinely unattended overnight runs, prefer a **scheduled/cron task** (`CronCreate` /
  `mcp__scheduled-tasks`) that re-enters and resumes from the checkpoint, over a single
  long-lived background process that the session lifecycle can reap.

### 5. Keep the session alive for the duration

Background Bash jobs are **not restored on `--resume`/`--continue`** and stop on terminal/session
exit. For overnight: don't close the terminal, avoid manual resume mid-run, and assume a rollover
could drop in-flight jobs — which is exactly why #2/#3 (checkpoint + idempotency) are mandatory,
not optional.

---

## One-line answers to the original leads

1a. **Clamped, not rejected** — `timeout: 900000` → effective 600000. [CONFIRMED by incident behavior]
1b. **Yes, the timeout applies to background jobs** — `run_in_background` is not an exemption. [CONFIRMED]
1c. **SIGTERM (signal 15).** Grace period before any `SIGKILL` is undocumented; treat as "could be killed any moment past the ceiling." [CONFIRMED signal / SUSPECTED grace]
2. **No documented separate idle/lifetime per-command timeout** beyond the Bash ceiling; session-level limits are about context (compaction) and the 7-day scheduled-task expiry, not execution. [per docs]
3. **Background jobs run across turns while idle; not restored on resume; completion re-invokes the agent via task-notification (reliable while the session lives); session exit stops them.** Compaction's effect on a child PID is undocumented. [mixed CONFIRMED/SUSPECTED]
4. **Session exit / terminal close stops background + `/loop` tasks** (confirmed for `/loop`, structurally true for bg Bash). Esc stops a waiting `/loop`. [STRONG]

---

## Recommended immediate actions for the proposal-run workflow

1. Stop wrapping the whole network loop in one `timeout: 900000` background call. **[do now]**
2. Add the per-network checkpoint file + skip-if-done guard to the proposal script. **[do now]**
3. Add a source-of-truth "already proposed?" check (Safe/MongoDB, `--no-use-cache`). **[do now]**
4. Optionally set `BASH_MAX_TIMEOUT_MS` in `.claude/settings.json` as a cushion, and verify it
   takes effect. **[nice-to-have]**
5. For overnight, run via a scheduled task that resumes from the checkpoint, not a single
   long-lived background process. **[for unattended runs]**
