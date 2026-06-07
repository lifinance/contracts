# Contract Changelog Analysis System

Automated system that analyzes Solidity contract changes and generates changelog entries using **Claude Sonnet** (Anthropic API). Output lives under the **`changelog/`** folder (similar to `audit/`):

- **`changelog/CHANGELOG.md`** — single file with all contract changes **grouped by version** (from `@custom:version` in contracts). Each run adds one block; inside it, one subsection per contract version with combined changes (Breaking, Added, Changed, Removed, Fixed) from all commits in the PR.
- **`changelog/contracts/{ContractName}.md`** — one file per contract; sections are **per version** (e.g. `## v1.0.2`). Under each version: commit links, date, and combined changes from all commits that contributed to that version.

---

## Architecture

```
script/changelogAnalysis/
├── generateContractChangelog.ts   # Entrypoint: git diff → AI analysis → write changelog
├── aiChangelogAnalyzer.ts         # Claude Sonnet API + diff building + response parsing
└── README.md                      # This file
```

**GitHub workflow**: `.github/workflows/generateContractChangelog.yml` — runs the script in CI and optionally commits the generated file(s).

---

## Components

### 1. `generateContractChangelog.ts` (orchestrator)

**Role**: CLI entrypoint and orchestration. No AI calls; it drives git and the analyzer.

**Responsibilities**:

- **Commits to analyze**: For a merge commit (e.g. PR merge), gets all commits in the branch via `getCommitsToAnalyze()`; otherwise the single trigger commit.
- **Per-commit, per-file**: For each commit, runs `git diff` for changed `.sol` under `src/`. For each changed file:
  - Reads old/new content with `git show <commit>:<file>`.
  - Derives contract name from file content (regex) or filename.
  - Gets unified diff via `aiChangelogAnalyzer.getFileDiff()` and builds a `ContractDiff` via `buildContractDiff()`.
  - Calls `analyzeContractChangesWithAI(contractDiff)` (the only AI call).
  - Merges the returned categories (breaking, added, changed, removed, fixed) into a single changelog entry.
- **Output**: Builds one combined Markdown entry, calls `updateChangelog()` to prepend it to `changelog/CHANGELOG.md`, and for each changed contract calls `updateContractChangelog()` to prepend that commit’s changes to `changelog/contracts/{ContractName}.md`.

**Key functions**:

- `getCommitsToAnalyze(commitSha)` — for merge commits, all commits in the branch; else `[commitSha]`.
- `getChangedSolidityFiles(commitSha)` — list of changed `.sol` paths for that commit.
- `getFileAtCommit(file, commit)` — file content at a given commit.
- `extractContractName(content, filename)` — contract name for headings.
- `extractVersion(content)` — parse `@custom:version X.Y.Z` (or `custom::version`) from file.
- `formatContractSections(analysis)` — Markdown sections (### Breaking, Added, etc.) for one contract.
- `updateChangelog(entry, commitSha)` — prepend this commit’s full entry to `changelog/CHANGELOG.md`; no-op if commit already present.
- `updateContractChangelog(contractName, commitSha, ...)` — prepend this commit’s changes for one contract to `changelog/contracts/{ContractName}.md`.
- `mainWithAI()` — async main: get commits → analyze each file → aggregate by version → write changelog + per-contract files.

**Constants**: `CHANGELOG_DIR = 'changelog'`, `CONTRACTS_CHANGELOG_DIR = 'changelog/contracts'`, `CONTRACTS_DIR = 'src'`.

---

### 2. `aiChangelogAnalyzer.ts` (AI + diff utilities)

**Role**: Build inputs for the model, call Anthropic, and parse the response. Single AI provider (Claude Sonnet); no fallbacks.

**Responsibilities**:

- **API**: Call Anthropic Messages API (`https://api.anthropic.com/v1/messages`) with model `claude-sonnet-4-5`. Uses env var `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY`.
- **Prompt**: Builds a single user prompt containing contract name, file path, and the git diff; asks for a JSON object with `summary`, `breaking`, `added`, `changed`, `removed`, `fixed`, `context`.
- **Parsing**: Extracts JSON from the reply (allows surrounding text), validates required fields, and prefixes each item with the contract name (e.g. `` `ContractName`: description ``).
- **Git helpers**: `getFileDiff(file, oldCommit, newCommit)` runs `git diff`; `buildContractDiff(...)` returns the `ContractDiff` object passed to the AI.

**Key functions**:

- `analyzeContractChangesWithAI(diff, apiKey?)` — public entry; resolves API key from env or argument, then calls Claude.
- `analyzeWithClaudeSonnet(diff, apiKey)` — HTTP request to Anthropic and response handling.
- `buildAnalysisPrompt(diff)` — builds the prompt text.
- `parseAIResponse(content, contractName)` — JSON parse + validation + prefixing.
- `getFileDiff(file, oldCommit, newCommit)` — shell `git diff`.
- `buildContractDiff(file, contractName, oldContent, newContent, diff)` — builds `ContractDiff`.

**Environment**: `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` (required for AI).

---

### 3. `.github/workflows/generateContractChangelog.yml` (CI)

**Role**: Run the changelog generator in GitHub Actions and commit the `changelog/` folder when updated.

**Triggers**:

- **Pull request closed (merged)** into `main` and the PR touched `src/**/*.sol` → run after merge.
- **Manual**: `workflow_dispatch` (optional input: commit SHA to analyze; if empty, current HEAD is used).
- **Push**: Push to the test branch that touches `src/**/*.sol` also triggers the workflow.

**Steps**:

1. **Checkout** — full history (`fetch-depth: 0`) for diff analysis.
2. **Setup Bun** — install Bun.
3. **Install dependencies** — `bun install`.
4. **Generate changelog** — runs `bun run script/changelogAnalysis/generateContractChangelog.ts` with env:
   - `COMMIT_SHA`, `GITHUB_TOKEN`, `REPOSITORY`
   - `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` (from repo secrets).
5. **Check for changes** — detect if any file under `changelog/` was modified.
6. **Commit and push** — if `changelog/` changed, commit and push (e.g. message: `chore: add contract changelog for commit <short-sha>`).
7. **Summary** — write job summary (success, contracts analyzed).

**Secrets**: Repo must have `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` set in Settings → Secrets and variables → Actions.

---

## Process (end-to-end)

1. **Trigger**  
   - Merge of a PR into `main` that changed `src/**/*.sol`, or manual `workflow_dispatch`.

2. **Change set**  
   - Script gets commits via `getCommitsToAnalyze(commitSha)` (all commits in PR for a merge, else the single commit). For each commit, `git diff` yields changed `src/**/*.sol` paths.

3. **Per commit, per changed file**  
   - Old/new content from git; contract name and version (`@custom:version`) from file.  
   - `getFileDiff(file, parent, commit)` → unified diff.  
   - `buildContractDiff(...)` → one `ContractDiff` per file.

4. **AI analysis**  
   - One call to Claude Sonnet per `ContractDiff` with a structured prompt; model returns JSON: `summary`, `breaking`, `added`, `changed`, `removed`, `fixed`, `context`.

5. **Aggregate by version**  
   - Results are grouped by `(contractName, version)`. All commits that touch the same contract version are merged: commit SHAs collected, change categories concatenated, latest date kept.

6. **Write**  
   - `updateChangelogVersioned()` prepends one block to `changelog/CHANGELOG.md` with one subsection per contract version (skips if trigger commit already in file).
   - For each contract, `updateContractChangelogVersioned()` prepends one section per version to `changelog/contracts/{ContractName}.md` (commit links, date, combined change sections). Author is not included.

7. **CI only**  
   - Workflow detects changes under `changelog/` and, if any, commits and pushes.

---

## Usage

### Manual (local)

Requires `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` in the environment.

```bash
# From repo root; analyzes last commit (HEAD vs HEAD~1)
bun run script/changelogAnalysis/generateContractChangelog.ts
```

Output: `changelog/CHANGELOG.md` and `changelog/contracts/{ContractName}.md` updated (only if there were changed `.sol` files and this commit is not already recorded).

### Automatic (CI)

- Merge a PR into `main` that changes `src/**/*.sol` → workflow runs and may update/commit `changelog/`.
- Or run manually: Actions → “Generate Contract Changelog” → “Run workflow”.

---

## Configuration

| Item | Where | Description |
|------|--------|-------------|
| `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` | Env / GitHub secret | Anthropic API key; required for AI. |
| `CHANGELOG_DIR` / `CONTRACTS_CHANGELOG_DIR` | `generateContractChangelog.ts` | `changelog/` and `changelog/contracts/` for main changelog and per-contract files. |
| `CONTRACTS_DIR` | `generateContractChangelog.ts` | Path filter for contracts (default `src`). |

No other AI providers or fallbacks are used.

---

## Output format

**`changelog/CHANGELOG.md`**: Title and short intro, then one block per run (e.g. per PR merge). Each block has:

- Heading: `## [shortSha] - Contract version updates`
- **Commit** (link), **Date**
- One **subsection per contract version** (e.g. `### ContractName v1.0.2`): **Commits** (links for all commits that contributed), **Date**, and combined **Breaking** / **Added** / **Changed** / **Removed** / **Fixed** (only if non-empty). Author is not included.

**`changelog/contracts/{ContractName}.md`**: One file per contract. Title “{ContractName} – Changelog”, intro “Changes grouped by contract version”, then one section per **version** (e.g. `## v1.0.2`), newest first. Each section has: **Commits** (links), **Date**, and the change sections for that version only.

---

## Troubleshooting

| Issue | What to check |
|-------|-------------------------------|
| “No Solidity files changed” | Files must be under `src/` and `.sol`; for the analyzed commit(s) run `git diff` against parent and confirm. |
| “No API key provided” | Set `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` (env or GitHub secret). |
| “Anthropic API error” | Key valid, network access, and (if 4xx) Anthropic status/docs. |
| “Failed to parse AI response” | Model must return valid JSON in the requested shape; check prompt and model output. |
| Commit already in changelog | Script skips if this commit SHA is already present in `changelog/CHANGELOG.md` or in the per-contract file. |

---

## Related

- Workflow file: `.github/workflows/generateContractChangelog.yml`
- Changelog output: `changelog/CHANGELOG.md` (by version per run) and `changelog/contracts/*.md` (per contract, by version)
