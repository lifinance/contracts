---
name: aikido-weekly-review
description: Weekly review of a repo's whole Aikido feed — severity/SLA dashboard, findings grouped into action groups with a suggestion each; acts only on groups the user picks. Use for "weekly aikido review", "what's open in aikido", or a scheduled run. Single-PR triage is /aikido-address-findings.
usage: /aikido-weekly-review [repo-name] — repo defaults to the current git repo
---

# Aikido Weekly Review

**Suggest-first: never fix or ignore anything the user hasn't picked.** Triage mechanics live in `/aikido-address-findings`; this command orchestrates and does not duplicate them.

## Preflight

- Probe the Aikido MCP as in the Preflight section of `.agents/commands/aikido-address-findings.md` (the `aikido_full_scan` test call and its `/aikido:setup` fallback message).
- Repo name: the argument, else `gh repo view --json name -q .name`. Never hardcode — forks share code under different Aikido repo names (`contracts` vs `contracts-tron`).

## Step 1 — Pull the full feed

`aikido_issues_list` with `repo_name` and no `issue_types` filter, paginating (`page: 0, 1, …`) until a page returns fewer than 25 issues. Then the same paginated call with `out_of_sla: true` and with `sla_due_soon: true` to mark SLA state per issue.

`issue_id` values are numbers in the feed but must be passed to `aikido_ignore_issue` as **strings**.

## Step 2 — Dashboard

Group by `issue_type` × `issue_severity_label`:

```text
| Type          | Crit | High | Med | Low | Out of SLA | Due soon |
|---------------|------|------|-----|-----|------------|----------|
| open_source   | .    | .    | .   | .   | .          | .        |
| sast          | .    | .    | .   | .   | .          | .        |
| leaked_secret | .    | .    | .   | .   | .          | .        |
| iac / other   | .    | .    | .   | .   | .          | .        |
```

Then list every critical/high by name (CVE/package or rule/file:line) and everything out of SLA regardless of severity.

## Step 3 — Group and suggest (do not act)

**leaked_secret** findings go first, individually (file + secret type + rotation note): a value that reached a commit is compromised and needs rotation — never group them or suggest ignoring.

Group everything else so each group is one action the user can accept or reject whole:

- **open_source** → by package (one bump resolves all its CVEs). Note installed vs recommended version and direct vs transitive (check `package.json`).
- **sast** → by rule × file-family (e.g. "path traversal × script/tasks propose* scripts"). Name the matching pattern from `.agents/references/aikido-false-positive-catalog.md` (contracts-only); without a catalog match, only Fix or Discuss are allowed — never Ignore.
- **iac / scm_security / actions** → by rule (all unpinned actions together, all persist-credentials together, …).

Per group: finding ids + count, severity range, SLA state, a one-line **suggested action** (Fix via the `/aikido-address-findings` Phase 4 recipe / Ignore with the catalog reason / Discuss) and a one-line why. Then stop and ask for a decision per group (accept, pick another action, or defer) — a numbered list answerable compactly ("1,3 fix; 2 ignore; rest defer") or the harness's question UI.

## Step 4 — Execute only the accepted groups

- Where the harness supports background task chips, offer per group: do it in this session, or spawn a chip with a self-contained prompt (repo, finding ids, chosen action) so each fix becomes its own session/PR. Default to in-session.
- Check open PRs first — a bump may already be in flight. `/aikido-address-findings` feed mode queries SAST only, so apply its dependency/actions recipes directly.
- SAST: run `/aikido-address-findings <issue-id> <repo>` per finding in the group. `/aikido-address-findings all <repo>` is allowed only when the user accepted every SAST group — it re-triages the full feed and would touch deferred/rejected groups.
- Accepted ignores go through `aikido_ignore_issue` with a reason naming the call-site/context justification, not a generic dismissal.
- Leave deferred/rejected groups untouched.

## Step 5 — Report

Four lists: **fixed/PR'd** (links), **ignored with reason** (id + reason), **deferred by user**, **escalated** (secrets, plus groups routed to Discuss or left undecided). If nothing is open, say so — that is the weekly report.

## Step 6 — Offer the next run

Skip if this run was itself scheduled. Otherwise offer:

1. **Scheduled task (preferred)** — a weekly recurring task running `/aikido-weekly-review` in this repo (`/schedule` or the session's scheduled-tasks tooling), on a weekday morning in the user's timezone; confirm the schedule back.
2. **Calendar reminder** — if a calendar connector is available, a weekly 30-minute "Aikido review — <repo>" event linking https://app.aikido.dev and naming this command.
3. **Neither** — mention the command name for ad-hoc use.
