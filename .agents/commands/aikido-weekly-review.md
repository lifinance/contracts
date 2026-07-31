---
name: aikido-weekly-review
description: Recurring (weekly) Aikido security-feed review for a repo — pulls all open findings via the Aikido MCP, builds a severity/type dashboard with SLA status, routes each bucket (SAST triage via /aikido-address-findings, dependency CVEs, leaked secrets, IaC/actions), and ends by offering to schedule the next run. For tech leads reviewing their repo's security posture on a cadence, not for triaging a single PR. Use when asked to "review aikido findings", "weekly aikido review", "aikido security review", "what's open in aikido", or when a scheduled task fires with /aikido-weekly-review.
usage: /aikido-weekly-review [repo-name] — repo defaults to the current git repo
---

# Aikido Weekly Review

Cadence review of the whole Aikido feed for one repo. Produces a dashboard + routed
action list, then offers to schedule the next run. Deep SAST triage mechanics live in
`/aikido-address-findings` — this command orchestrates, it does not duplicate them.

---

## Preflight

- Needs the Aikido MCP (`aikido_issues_list`). Verify exactly as described in the
  Preflight section of `.agents/commands/aikido-address-findings.md` (including the
  `/aikido:setup` fallback message). `aikido_login` should report already-signed-in.
- Derive the repo name from `gh repo view --json name -q .name` unless overridden by the
  argument. Never hardcode: forks share code under different Aikido repo names
  (`contracts` vs `contracts-tron`).

## Step 1 — Pull the full feed

Call `aikido_issues_list` with `repo_name` and NO `issue_types` filter, paginating
(`page: 0, 1, …`) until a page returns fewer than 25 issues. Then two cheap extra calls
with `out_of_sla: true` and `sla_due_soon: true` to mark SLA state per issue.

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

## Step 3 — Route each bucket

- **leaked_secret** — never auto-handle. Escalate immediately to the user with the file
  and secret type; a value that reached a commit is compromised and needs rotation, not
  ignoring.
- **sast** — hand off to `/aikido-address-findings all <repo>` for the full
  fix-vs-ignore triage. In repos without a false-positive catalog
  (`.agents/references/aikido-false-positive-catalog.md` is contracts-only), do not
  auto-ignore anything — report with a recommendation instead.
- **open_source (dependency CVEs)** — group by package; for each, report installed vs
  recommended version and whether it is a direct or transitive dep (check
  `package.json`). Offer a bump PR (`vulnerable_dependency` recipe in
  `/aikido-address-findings`). Check open PRs first — a bump may already be in flight.
- **iac / scm_security / actions findings** — unpinned actions and template injection
  are always real (fix recipes in `/aikido-address-findings`); `persist-credentials`
  and broad-permissions findings need the workflow's push/trigger context before
  deciding fix vs ignore.
- Anything the user decides to accept: ignore via `aikido_ignore_issue` with a reason
  that names the call-site/context justification, not a generic dismissal.

## Step 4 — Report

End with three lists: **fixed/PR'd now** (with PR links), **needs a human decision**
(each with a one-line recommendation), and **ignored with reason** (id + reason). If
nothing is open: say so — that IS the weekly report.

## Step 5 — Offer the next run (scheduling)

Ask which the user wants (skip if this run was itself triggered by a schedule):

1. **Scheduled task (preferred)** — create a weekly recurring task that runs
   `/aikido-weekly-review` in this repo (Claude Code: the `/schedule` flow or the
   scheduled-tasks tooling available in the session; pick a weekday morning in the
   user's timezone). Confirm the created schedule back to the user.
2. **Calendar reminder** — if a calendar connector is available, create a weekly
   30-minute "Aikido review — <repo>" event with a description linking
   https://app.aikido.dev and naming this command.
3. **Neither** — fine; mention the command name so they can invoke it ad hoc.
