# Contract Changelog Analysis System

Automated system that analyzes Solidity contract changes and generates changelog entries using **Claude Sonnet** (Anthropic API). Output lives under the **`changelog/`** folder (similar to `audit/`):

- **`changelog/CHANGELOG.md`** — single file with all contract changes by commit (newest first). Full info per commit: link, date, author, and all categories (Breaking, Added, Changed, Removed, Fixed). May become large over time.
- **`changelog/contracts/{ContractName}.md`** — one file per contract; each lists the **commit hash(es)** that modified that contract and the changes in that commit (newest first).

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

- **Change detection**: Runs `git diff --name-only HEAD~1 HEAD`, keeps only paths under `src/` ending in `.sol`.
- **Per-file loop**: For each changed file:
  - Reads old/new content with `git show <commit>:<file>`.
  - Derives contract name from file content (regex) or filename.
  - Gets unified diff via `aiChangelogAnalyzer.getFileDiff()` and builds a `ContractDiff` via `buildContractDiff()`.
  - Calls `analyzeContractChangesWithAI(contractDiff)` (the only AI call).
  - Merges the returned categories (breaking, added, changed, removed, fixed) into a single changelog entry.
- **Output**: Builds one combined Markdown entry, calls `updateChangelog()` to prepend it to `changelog/CHANGELOG.md`, and for each changed contract calls `updateContractChangelog()` to prepend that commit’s changes to `changelog/contracts/{ContractName}.md`.

**Key functions**:

- `getChangedSolidityFiles()` — list of changed `.sol` paths.
- `getFileAtCommit(file, commit)` — file content at a given commit.
- `extractContractName(content, filename)` — contract name for headings.
- `formatChangelogEntry(entry)` — Markdown from the structured entry.
- `formatContractSections(analysis)` — Markdown sections (### Breaking, Added, etc.) for one contract.
- `updateChangelog(entry, commitSha)` — prepend this commit’s full entry to `changelog/CHANGELOG.md`; no-op if commit already present.
- `updateContractChangelog(contractName, commitSha, ...)` — prepend this commit’s changes for one contract to `changelog/contracts/{ContractName}.md`.
- `mainWithAI()` — async main: detect files → analyze each → merge → format → write changelog + per-contract files.

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
   - Script runs `git diff --name-only HEAD~1 HEAD` and keeps `src/**/*.sol` paths.

3. **Per changed file**  
   - Old/new content from git; contract name from source or filename.  
   - `getFileDiff(file, 'HEAD~1', 'HEAD')` → unified diff.  
   - `buildContractDiff(...)` → one `ContractDiff` per file.

4. **AI analysis**  
   - One call to Claude Sonnet per `ContractDiff` with a structured prompt; model returns JSON: `summary`, `breaking`, `added`, `changed`, `removed`, `fixed`, `context`.

5. **Merge and format**  
   - All results for the commit are merged into a single `ChangelogEntry`; `formatChangelogEntry()` turns it into Markdown.

6. **Write**  
   - `updateChangelog()` prepends the full entry to `changelog/CHANGELOG.md` (skips if this commit is already in the file).
   - For each changed contract, `updateContractChangelog()` prepends this commit’s changes to `changelog/contracts/{ContractName}.md` (commit hash, date, author, and change sections).

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

**`changelog/CHANGELOG.md`**: Title and short intro, then one section per commit (newest first). Each section includes:

- Heading: `## [shortSha] - commit message`
- **Commit** (link), **Date**, **Author**
- Full change list: **Breaking**, **Added**, **Changed**, **Removed**, **Fixed** (only if non-empty)
- Each bullet prefixed with the contract name, e.g. `` `LiFiDiamond`: ... ``.

**`changelog/contracts/{ContractName}.md`**: One file per contract. Title “{ContractName} – Changelog”, short intro, then one section per **commit** that modified that contract (newest first). Each section has: commit short hash, message, **Commit** link, **Date**, **Author**, and the change sections (Breaking, Added, Changed, Removed, Fixed) for that contract only.

---

## Troubleshooting

| Issue | What to check |
|-------|-------------------------------|
| “No Solidity files changed” | Files must be under `src/` and `.sol`; run `git diff --name-only HEAD~1 HEAD` and confirm. |
| “No API key provided” | Set `CLAUDE_CODE_SC_CONTRACTS_REPO_CHANGELOGS_API_KEY` (env or GitHub secret). |
| “Anthropic API error” | Key valid, network access, and (if 4xx) Anthropic status/docs. |
| “Failed to parse AI response” | Model must return valid JSON in the requested shape; check prompt and model output. |
| Commit already in changelog | Script skips if this commit SHA is already present in `changelog/CHANGELOG.md` or in the per-contract file. |

---

## Related

- Workflow file: `.github/workflows/generateContractChangelog.yml`
- Changelog output: `changelog/CHANGELOG.md` (all commits) and `changelog/contracts/*.md` (per contract, commit hash + changes)
