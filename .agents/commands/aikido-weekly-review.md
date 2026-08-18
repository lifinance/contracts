---
name: aikido-weekly-review
description: Recurring (weekly) Aikido security-feed review for a repo — pulls all open findings via the Aikido MCP, builds a severity/type dashboard with SLA status, groups findings into action groups with a recommendation each, and lets the USER decide per group (nothing is fixed or ignored without their pick); ends by offering to schedule the next run. For tech leads reviewing their repo's security posture on a cadence, not for triaging a single PR. Use when asked to "review aikido findings", "weekly aikido review", "aikido security review", "what's open in aikido", or when a scheduled task fires with /aikido-weekly-review.
usage: /aikido-weekly-review [repo-name] — repo defaults to the current git repo
---

# Aikido Weekly Review

Cadence review of the whole Aikido feed for one repo. Produces a dashboard + grouped
suggestions, waits for the user's per-group decisions, executes only those, then offers
to schedule the next run. **Suggest-first is the contract: this command never fixes or
ignores anything the user hasn't picked.** Deep SAST triage mechanics live in
`/aikido-address-findings` — this command orchestrates, it does not duplicate them.

---

## Preflight

- Needs the Aikido MCP (`aikido_issues_list`). Verify availability exactly as described
  in the Preflight section of `.agents/commands/aikido-address-findings.md` (the
  `aikido_full_scan` test call, and its `/aikido:setup` fallback message on failure).
- Derive the repo name from `gh repo view --json name -q .name` unless overridden by the
  argument. Never hardcode: forks share code under different Aikido repo names
  (`contracts` vs `contracts-tron`).

## Step 1 — Pull the full feed

Call `aikido_issues_list` with `repo_name` and NO `issue_types` filter, paginating
(`page: 0, 1, …`) until a page returns fewer than 25 issues. Then two extra calls with
`out_of_sla: true` and `sla_due_soon: true` to mark SLA state per issue — paginated the
same way (the 25/page limit applies to every variant of this call).

`issue_id` values are numbers in the feed but must be passed back as **strings** to
`aikido_ignore_issue`.

## Step 2 — Dashboard

Group by `issue_type` × `issue_severity_label` and render:

```text
| Type          | Crit | High | Med | Low | Out of SLA | Due soon |
|---------------|------|------|-----|-----|------------|----------|
| open_source   | .    | .    | .   | .   | .          | .        |
| sast          | .    | .    | .   | .   | .          | .        |
| leaked_secret | .    | .    | .   | .   | .          | .        |
| iac / other   | .    | .    | .   | .   | .          | .        |
```

Follow with the top items: every critical/high by name (CVE/package or rule/file:line),
and everything out-of-SLA regardless of severity.

## Step 3 — Group into action groups and suggest (do not act)

Exception first: **leaked_secret** findings are surfaced immediately and individually
(file + secret type + rotation note) at the top of the output — a value that reached a
commit is compromised and needs rotation; never fold these into a group or suggest
ignoring them.

Group everything else into decision-sized units — one group = one coherent action a
human can accept or reject as a whole:

- **open_source** → by package (one version bump resolves all its CVEs). Note installed
  vs recommended version and direct-vs-transitive (check `package.json`).
- **sast** → by rule × file-family (e.g. "path traversal × script/tasks propose*
  scripts"). Where a false-positive catalog exists
  (`.agents/references/aikido-false-positive-catalog.md`, contracts-only), name the
  matching pattern; without a catalog match, the only suggestions allowed are Fix or
  Discuss — never Ignore.
- **iac / scm_security / actions** → by rule (all unpinned actions together, all
  persist-credentials together, …).

For each group output: findings covered (ids + count), severity range, SLA state, a
one-line **suggested action** (Fix via the relevant `/aikido-address-findings` Phase 4
recipe / Ignore with the catalog reason / Discuss), and a one-line why. Then STOP and
ask the user to decide per group (accept the suggestion, pick a different action, or
defer) — a numbered list they can answer compactly ("1,3 fix; 2 ignore; rest defer") or
the harness's question UI.

## Step 4 — Execute only the accepted groups

- Per accepted group, offer two execution modes where the harness supports background
  task chips: **do it in this session now**, or **spawn a task chip per group** (a
  self-contained prompt naming the repo, finding ids, and chosen action) so each fix
  becomes its own session/PR the user starts with one click. Default to in-session when
  chips are unavailable.
- Fixes follow the `/aikido-address-findings` Phase 4 recipes (that command's feed mode
  queries SAST only, so apply dependency/actions recipes directly rather than invoking
  it for those buckets). Check open PRs first — a bump may already be in flight.
- Keep SAST execution scoped to the accepted group: run
  `/aikido-address-findings <issue-id> <repo>` per finding in the group. The whole-repo
  `/aikido-address-findings all <repo>` hand-off is allowed only when the user accepted
  every SAST group — it re-triages the full SAST feed and would otherwise touch
  deferred/rejected groups.
- Accepted ignores go through `aikido_ignore_issue` with a reason naming the
  call-site/context justification, not a generic dismissal.
- Deferred/rejected groups are left untouched and listed as such in the report.

## Step 5 — Report

End with four lists: **fixed/PR'd** (links), **ignored with reason** (id + reason),
**deferred by user**, and **escalated** (secrets, plus any group the user routed to
Discuss or left undecided). If nothing is open: say so — that IS the weekly report.

## Step 6 — Offer the next run (scheduling)

Ask which the user wants (skip if this run was itself triggered by a schedule):

1. **Scheduled task (preferred)** — create a weekly recurring task that runs
   `/aikido-weekly-review` in this repo (Claude Code: the `/schedule` flow or the
   scheduled-tasks tooling available in the session; pick a weekday morning in the
   user's timezone). Confirm the created schedule back to the user.
2. **Calendar reminder** — if a calendar connector is available, create a weekly
   30-minute "Aikido review — <repo>" event with a description linking
   https://app.aikido.dev and naming this command.
3. **Neither** — fine; mention the command name so they can invoke it ad hoc.
