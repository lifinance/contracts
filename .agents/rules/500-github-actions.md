---
name: GitHub Actions and CI/CD workflows
description: Structure, conventions, and best practices for GitHub Actions workflows
globs:
  - '.github/workflows/**/*.yml'
  - '.github/workflows/**/*.yaml'
  - '.github/**/*.yml'
  - '.github/**/*.yaml'
alwaysApply: false # for Cursor
paths:
  - '.github/workflows/**/*.yml'
  - '.github/workflows/**/*.yaml'
  - '.github/**/*.yml'
  - '.github/**/*.yaml'
---

## GitHub Actions Conventions

### Immutable action refs ([CONV:ACTIONS-IMMUTABLE])

- **Every external `uses:` reference MUST use a full 40-character commit SHA** (local `./.github/actions/*` paths take none) — including `actions/upload-artifact` and the `actions-ecosystem` label actions. Do not use tags (e.g. `@v4`, `@v1`, `@main`) or short SHAs; tags can be reassigned.
- **Format**: `owner/repo@<full-40-char-sha>` with an optional trailing comment for traceability:

  ```yaml
  - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332 # v4.1.7
  ```

### No template injection in `run:` scripts ([CONV:ACTIONS-NO-INJECTION])

- **Never interpolate `${{ github.* }}` (or any other `${{ ... }}` expression carrying attacker-influenced data) directly into a `run:` shell script.** The expression is substituted into the script body **before** the shell runs, so a crafted value (e.g. a branch name, PR title, commit message, or actor login containing shell metacharacters) executes as code on the runner.
- **Highest-risk contexts** (attacker-controllable on `pull_request`/`issue`/`issue_comment` triggers): `github.actor`, `github.event.*` (`.pull_request.title`, `.pull_request.body`, `.pull_request.head.ref`, `.issue.title`, `.comment.body`, `.label.name`, `.action`), `github.head_ref`. Treat every `github.event.*` field as untrusted.
- **Fix**: bind the expression to an `env:` entry on the step, then reference the shell variable (quoted) inside `run:`. Values passed via `env:` reach the script as data, never as code. Use a **custom** env-var name — GitHub silently ignores assignments to names it reserves (`GITHUB_*`, `RUNNER_*`), so `env: GITHUB_ACTOR: ...` is dropped and `$GITHUB_ACTOR` falls back to the runner default (works only by coincidence when the values match).
- **Example (correct)**:

  ```yaml
  - name: Check for authorized actor
    env:
      ACTOR_LOGIN: ${{ github.actor }}
    shell: bash
    run: |
      if [[ "$ACTOR_LOGIN" == "lifi-action-bot" ]]; then echo "authorized"; fi
  ```

- **Anti-pattern (forbidden)**:

  ```yaml
  - run: |
      if [[ "${{ github.actor }}" == "lifi-action-bot" ]]; then echo "authorized"; fi
  ```

- The `run:` script body is the direct injection sink. `${{ ... }}` in `if:`/`with:`/`env:` is not that sink, but it is not automatically safe: `if:` cannot reference `secrets.*` at all (map to `env:` first), and a value handed to `with:` is only as safe as what the receiving action does with it. Always bind untrusted expressions through `env:` and reference the quoted shell variable in `run:`.

### Foundry installation ([CONV:FOUNDRY-SETUP])

- **Always install foundry via the project's `./.github/actions/setup-foundry` composite action.** Do not call `foundry-rs/foundry-toolchain` directly from a workflow.
- The composite action reads `.foundry-version`, installs that exact version, and verifies the installed binary matches the pin. This keeps every CI runner and every dev's pre-commit hook on the same foundry version.
- To bump foundry repo-wide, change one line in `.foundry-version`. Every workflow that uses the composite action picks it up on the next run.
- **Correct**:

  ```yaml
  - name: Install Foundry
    uses: ./.github/actions/setup-foundry
  ```

- **Anti-pattern (forbidden)**:

  ```yaml
  - uses: foundry-rs/foundry-toolchain@<sha>     # bypasses the .foundry-version pin
    with:
      version: stable                            # floats — not reproducible across runs
  ```

### Scheduled workflows ([CONV:CRON-SCHEDULE])

- **A monthly cron uses a day-of-month between 1 and 28.** Days 29-31 do not exist in every month, so `0 3 31 * *` fires 7 times a year with gaps of up to 61 days. The intent is "once a month"; only 1-28 delivers it on every month.
- **The expression must be classifiable by the liveness watchdog.** `script/utils/cronLiveness.ts` derives an expected cadence for every `on.schedule` entry and reports any expression it cannot bucket, every day, until the schedule is fixed or a classifier rule is added. Modelled shapes are a minute step (`*/10 * * * *`), a fixed hour (daily), a fixed weekday (weekly), and a fixed day-of-month 1-28 (monthly); steps outside the minute field, fixed months, ranges, lists and any value outside cron's own field ranges (minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6) are refused.
- **Example (correct)**:

  ```yaml
  on:
    schedule:
      - cron: '0 3 1 * *' # 03:00 UTC on the 1st of each month
  ```

- **Anti-pattern (forbidden)**:

  ```yaml
  on:
    schedule:
      - cron: '0 3 31 * *' # skips Feb, Apr, Jun, Sep and Nov - not monthly
      - cron: '0 */6 * * *' # step outside the minute field - unclassifiable
  ```

### Upstream-only jobs on forks ([CONV:FORK-GUARD])

- Forks of this repo (e.g. `lifinance/contracts-tron`) sync every workflow and, inside the org, read the same secrets. A fork's checks on its own PRs and pushes (tests, lint, label gates) should keep running there.
- **A job that posts to Slack, holds a stored signing key, touches chain or MongoDB state, or writes to another repo MUST carry the guard `github.repository == 'lifinance/contracts'` in its `if:`** (AND-ed with any existing condition), plus a short comment saying what it would do on a fork. This applies to every automatic trigger (`schedule`, `push`, `pull_request`), not only `schedule`. Jobs a human starts on purpose for that repo (a label-triggered QA review, the team-gated emergency-pause dispatch) stay unguarded.
- The guard is a job-level `if:` on purpose. A composite action runs as a step, so it cannot skip the job, and a skipped job shows as neutral rather than failed.

## GitHub Actions Workflow Structure

- **Retiring a workflow**: delete it. Git history is the archive — a parked copy under a sibling directory is never re-enabled, drifts out of date, and hides live-looking policy that no longer runs.
- **Header**: every workflow file starts with a comment block stating purpose, triggers, key behaviors, and known limitations or disabled checks:

  ```yaml
  # Workflow Name
  # - Brief description of purpose
  # - Key behavior 1
  # - Known limitations or special cases
  ```

- **Job names**: kebab-case (e.g., `version-control`, `audit-verification`).
- **Shell logging**: ANSI colors — `\033[32m` green (success), `\033[31m` red (error), `\033[0m` reset.

### Permissions

- **Default-deny at the workflow level** with `permissions: {}`, then grant the minimal
  scopes each job needs at the **job level**. A workflow-level grant is inherited by every
  job, handing low-trust jobs more access than they need (flagged by Aikido as
  "Overly Broad Permissions").
- Document why each permission is needed with an inline comment:

```yaml
permissions: {}

jobs:
  build:
    permissions:
      contents: read # required to fetch repository contents
      pull-requests: write # required to edit PR title and assign/remove labels
      actions: write # required to upload/download artifacts between jobs
```

### Secrets and bot identity

- Use service account tokens (e.g., `lifi-action-bot`) for automated actions; secrets follow names like `GIT_ACTIONS_BOT_PAT_CLASSIC`, `MONGODB_URI`.
- Unset the default `GITHUB_TOKEN` when using a custom PAT:

  ```bash
  unset GITHUB_TOKEN
  echo $GH_PAT | gh auth login --with-token
  ```

- Only specific bots (e.g., `lifi-action-bot`) may modify protected labels; verify label state after modifying it.

### Label-gated heavy workflows ([CONV:CI-LABEL-GATE])

Use when a workflow is expensive (Foundry install, type generation, external repo publish) and most PRs do not need it:

1. **Gate the heavy job** on a dedicated label (e.g. `requires-types`) for `pull_request` events; keep unconditional runs for `push` to `main` and `workflow_dispatch`.
2. **Auto-assign the label** in a separate lightweight workflow using `dorny/paths-filter` on ABI-relevant paths so humans/agents do not need to remember the label for typical contract changes.
3. **Include `labeled` in triggers** so the heavy workflow runs after the auto-label workflow adds the label (avoids race on the first `synchronize` event).
4. **Document manual opt-in**: edge-case PRs (e.g. script-only changes needing fresh bindings) can add the label by hand.

Reference: `assignRequiresTypesLabel.yml` + `types.yaml`.

### PR Comments

- Identify bot comments with a unique marker (e.g., "🤖 GitHub Action: Security Alerts Review 🔍") and update an existing comment instead of posting a new one.
- Status indicators: ✅ success, ❌ error, ⚠️ warning.
