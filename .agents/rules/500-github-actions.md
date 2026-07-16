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

- Workflows: explicit permissions, comments, secrets via `${{ secrets.* }}`; clear step names & triggers.

### Immutable action refs ([CONV:ACTIONS-IMMUTABLE])

- **Every `uses:` reference MUST use a full 40-character commit SHA.** Do not use tags (e.g. `@v4`, `@v1`, `@main`) or short SHAs. Tags can be reassigned and have been exploited in supply-chain attacks (e.g. compromised third-party actions).
- **Format**: `owner/repo@<full-40-char-sha>` with an optional trailing comment for traceability (e.g. `# v4.1.7`).
- **When adding or updating a workflow**: Resolve the action’s tag/branch to its commit SHA (e.g. from the action’s repo releases or `git ls-remote`) and pin to that SHA.
- **Example (correct)**:

  ```yaml
  - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332 # v4.1.7
  ```

- **Anti-pattern (forbidden)**:

  ```yaml
  - uses: actions/checkout@v4.1.7
  - uses: some-action@main
  ```

### No template injection in `run:` scripts ([CONV:ACTIONS-NO-INJECTION])

- **Never interpolate `${{ github.* }}` (or any other `${{ ... }}` expression carrying attacker-influenced data) directly into a `run:` shell script.** The expression is substituted into the script body **before** the shell runs, so a crafted value (e.g. a branch name, PR title, commit message, or actor login containing shell metacharacters) executes as code on the runner.
- **Highest-risk contexts** (attacker-controllable on `pull_request`/`issue`/`issue_comment` triggers): `github.actor`, `github.event.*` (`.pull_request.title`, `.pull_request.body`, `.pull_request.head.ref`, `.issue.title`, `.comment.body`, `.label.name`, `.action`), `github.head_ref`. Treat every `github.event.*` field as untrusted.
- **Fix**: bind the expression to an `env:` entry on the step, then reference the shell variable (quoted) inside `run:`. Values passed via `env:` reach the script as data, never as code.
- **Example (correct)**:

  ```yaml
  - name: Check for authorized actor
    env:
      GITHUB_ACTOR: ${{ github.actor }}
    run: |
      if [[ "$GITHUB_ACTOR" == "lifi-action-bot" ]]; then echo "authorized"; fi
  ```

- **Anti-pattern (forbidden)**:

  ```yaml
  - run: |
      if [[ "${{ github.actor }}" == "lifi-action-bot" ]]; then echo "authorized"; fi
  ```

- `${{ secrets.* }}` and `${{ github.* }}` inside `if:`/`with:`/`env:` values are fine — only direct interpolation into the `run:` script body is the injection sink.

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

## GitHub Actions Workflow Structure

### File Organization

- **Location**: All workflow files must be in `.github/workflows/`
- **Naming**: Use descriptive names ending in `.yml` (e.g., `versionControlAndAuditCheck.yml`, `protectAuditLabels.yml`)
- **Deactivated workflows**: Move to `.github/workflows_deactivated/` instead of deleting

### File Header and Documentation

Every workflow file MUST start with a clear header comment block describing:

1. **Purpose**: What the workflow does
2. **Triggers**: When it runs (events, branches, paths)
3. **Key behaviors**: Important actions it performs
4. **Known limitations**: Any edge cases or disabled features

Example header format:

```yaml
# Workflow Name
# - Brief description of purpose
# - Key behavior 1
# - Key behavior 2
# - Known limitations or special cases
```

### Workflow Structure

#### Required Sections (in order)

1. **Name**: Descriptive workflow name
2. **On triggers**: Explicit event types and conditions
3. **Permissions**: Minimal required permissions with comments explaining each
4. **Jobs**: Organized by logical function

#### Permissions

- **Default-deny at the workflow level** with `permissions: {}`, then grant the minimal
  scopes each job needs at the **job level**. A workflow-level grant is inherited by every
  job, handing low-trust jobs more access than they need (flagged by Aikido as
  "Overly Broad Permissions").
- **Always document why each permission is needed** with inline comments
- Use minimal permissions (principle of least privilege)
- Common patterns:
  - `contents: read` - Fetch repository contents
  - `pull-requests: write` - Edit PR title, assign/remove labels, post comments
  - `actions: write` - Upload/download artifacts between jobs
  - `security-events: write` - Upload SARIF results to GitHub Code Scanning
  - `issues: write` - Post comments via GitHub Issues API

Example:

```yaml
# Default-deny at the workflow level; grant only what each job needs at the job level.
permissions: {}

jobs:
  build:
    permissions:
      contents: read # required to fetch repository contents
      pull-requests: write # required to edit PR title and assign/remove labels
      actions: write # required to upload/download artifacts between jobs
```

#### Job Organization

- **Job names**: Use kebab-case (e.g., `version-control`, `audit-verification`)
- **Conditional execution**: Use `if:` conditions to skip jobs when appropriate
- **Job dependencies**: Use `needs:` to ensure proper execution order
- **Concurrency**: Use `concurrency:` groups to prevent duplicate runs

#### Step Documentation

- **Step names**: Use clear, action-oriented names (e.g., "Checkout repository", "Verify version updates")
- **Comments**: Add inline comments for complex logic, especially in shell scripts
- **Error handling**: Include proper error messages with ANSI color codes for visibility
- **Environment variables**: Document all custom environment variables

### Shell Script Patterns

When using shell scripts in workflow steps:

1. **Error handling**: Use `set -e` where appropriate, or explicit error checks
2. **Logging**: Use ANSI color codes for visibility:
   - `\033[32m` - Green (success)
   - `\033[31m` - Red (error)
   - `\033[0m` - Reset
3. **Variable initialization**: Initialize variables before use
4. **Exit codes**: Use appropriate exit codes (0 for success, 1 for failure)
5. **Comments**: Add descriptive comments for complex logic blocks

Example:

```bash
##### Initialize empty variables
CONTRACTS=""

##### go through all file paths and identify all files in src/ folder
while IFS= read -r FILE; do
  if echo "${FILE}" | grep -E '^src/.*\.sol$'; then
    CONTRACTS="${CONTRACTS}${FILE}"$'\n'
  fi
done <<< "${FILES}"
```

### Secrets Management

- **Use GitHub Secrets**: Never hardcode sensitive data
- **Naming convention**: Use descriptive names (e.g., `GIT_ACTIONS_BOT_PAT_CLASSIC`, `MONGODB_URI`)
- **Access control**: Use service account tokens (e.g., `lifi-action-bot`) for automated actions
- **Token usage**: Unset default `GITHUB_TOKEN` when using custom PATs:

  ```bash
  unset GITHUB_TOKEN
  echo $GH_PAT | gh auth login --with-token
  ```

### Conditional Execution

- **Draft PRs**: Skip workflows on draft PRs: `if: ${{ github.event.pull_request.draft == false }}`
- **Branch targeting**: Check base branch: `if: ${{ github.event.pull_request.base.ref == 'main' }}`
- **Path filters**: Use `paths:` to trigger only on relevant file changes
- **Event types**: Specify exact event types needed (e.g., `types: [opened, synchronize, ready_for_review]`)

### Artifact Management

- **Upload/download artifacts**: Pin to full commit SHA (e.g. `actions/upload-artifact@<full-sha> # v4`); never use `@v4` or other tags.
- **Artifact names**: Use descriptive names (e.g., `contracts_for_audit`)
- **Cleanup**: Initialize empty files to prevent upload failures

### Label Management

- **Label assignment**: Pin to full commit SHA for `actions-ecosystem/action-add-labels` and `action-remove-labels`; never use `@v1` or other tags.
- **Authorization**: Only allow specific bots (e.g., `lifi-action-bot`) to modify protected labels
- **Verification**: Always verify label state after modification

### Label-gated heavy workflows ([CONV:CI-LABEL-GATE])

Use when a workflow is expensive (Foundry install, type generation, external repo publish) and most PRs do not need it:

1. **Gate the heavy job** on a dedicated label (e.g. `requires-types`) for `pull_request` events; keep unconditional runs for `push` to `main` and `workflow_dispatch`.
2. **Auto-assign the label** in a separate lightweight workflow using `dorny/paths-filter` on ABI-relevant paths so humans/agents do not need to remember the label for typical contract changes.
3. **Include `labeled` in triggers** so the heavy workflow runs after the auto-label workflow adds the label (avoids race on the first `synchronize` event).
4. **Document manual opt-in**: edge-case PRs (e.g. script-only changes needing fresh bindings) can add the label by hand.

Reference: `assignRequiresTypesLabel.yml` + `types.yaml`.

### PR Comments

- **Comment identification**: Use unique markers (e.g., "🤖 GitHub Action: Security Alerts Review 🔍")
- **Update vs. create**: Check for existing comments before creating new ones
- **Formatting**: Use Markdown for readability (headers, lists, code blocks)
- **Status indicators**: Use emojis for visual status (✅ success, ❌ error, ⚠️ warning)

### Error Messages

- **Clear messaging**: Provide actionable error messages
- **Context**: Include relevant file paths, contract names, or identifiers
- **Color coding**: Use ANSI colors for visibility in logs
- **Exit behavior**: Fail fast with `exit 1` when critical checks fail

### Testing and Validation

- **Input validation**: Validate environment variables and inputs early
- **State verification**: Verify expected state after operations (e.g., label assignment)
- **Graceful degradation**: Handle missing data gracefully (e.g., empty file lists)
- **Known limitations**: Document disabled checks or edge cases in comments

### Integration Patterns

- **Workflow dependencies**: Ensure prerequisite workflows complete before dependent workflows
- **Status checks**: Verify upstream workflow success when needed
- **Concurrency groups**: Use concurrency groups to prevent duplicate runs on same PR
- **Manual triggers**: Include `workflow_dispatch` for manual execution when appropriate

### Best Practices

1. **Idempotency**: Design workflows to be safely re-runnable
2. **Transparency**: Log all important decisions and state changes
3. **Failure handling**: Provide clear error messages and recovery guidance
4. **Performance**: Use path filters and conditional execution to minimize unnecessary runs
5. **Maintainability**: Keep workflows focused on single responsibilities
6. **Documentation**: Comment complex logic and document known limitations
