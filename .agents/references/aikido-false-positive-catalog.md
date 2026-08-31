# Aikido False Positive Catalog — lifinance/contracts

Used by `/aikido-address-findings` (auto-triage on scan) and `/aikido-update-false-positive-catalog` (add new patterns).

Each pattern has:

- **Matches when** — how to recognize this false positive from issue data
- **ignore_reason** — exact text to pass to `aikido-mcp:aikido_ignore_issue`
- **sast_context** — text to paste into the Aikido UI "Custom Code Context" for this rule

---

## `path_traversal_scripts`

**Matches when**: issue title contains "path traversal" or "file inclusion"; file is under `script/`, `tasks/`, or `.claude/scripts/`; AND the flagged path input is verifiably constrained at that call site — repo-derived (directory walks, hardcoded constants, deploy-log/artifact names), validated against `config/networks.json` before the read (e.g. `getViemChainForNetworkName`), sanitized (`assertSafePathSegment`, a `path.relative`-containment guard), or a pipeline-generated temp file (mktemp).

**Does NOT match** (fix with a containment guard instead of ignoring — pattern: `getDeployLogFile` in `script/utils/viemScriptHelpers.ts`): a free-form CLI string interpolated into a path with NO upstream validation. A plain `string` network/contract/path parameter is not an allow-list — do not claim SupportedChain typing unless the parameter is actually typed and runtime-validated at that call site.

**ignore_reason**:
> False positive — internal developer CLI tool. At this call site the path input is constrained: repo-derived names (directory walk / deploy log / hardcoded constant), a value validated against config/networks.json before the read, a sanitized segment (assertSafePathSegment or a path.relative containment guard), or a pipeline-generated temp file. No HTTP server; these scripts run locally or in CI, never with untrusted external user input. (State which of these applies for the specific call site.)

**sast_context** — the relevant rule is the **TS** row titled "Potential file inclusion attack via reading file" under Repositories → contracts → Checks → View SAST Rules (there is no rule literally named "Path Traversal"; a JS row carries the identical title — ours is TS). NOTE (2026-07-28): the exact click path to "Custom Code Context" from that list is unverified — rows on the SAST rules list did not appear to open a detail panel. Treat this whole step as optional; it suppresses future recurrences but gates nothing. Confirm the real path in the UI before relying on these instructions.
> All TypeScript scripts under script/, tasks/, and .claude/scripts/ are internal developer CLI tools and CI scripts. They are never deployed as network services and never receive input from untrusted external users. Constrained path inputs come from: network names validated against config/networks.json (a version-controlled allow-list, via helpers like getViemChainForNetworkName which throw for unknown networks); contract name strings from the codebase itself or from deploy logs (e.g. "LiFiDiamond", "StargateFacet"); git rev-parse output (trusted local git binary); hardcoded path constants; mkdtemp-generated temp files. Recognize these sanitizers: assertSafePathSegment in script/deploy/tron/helpers/tronscanVerify.ts (rejects path separators and ".." segments), and the containment-guard pattern `const rel = path.relative(base, resolvedPath); if (rel.startsWith('..') || path.isAbsolute(rel)) throw` used in getDeployLogFile/getFunctionSelectors (script/utils/viemScriptHelpers.ts), the propose*Mappings scripts, generateHexagateImportCsv.ts, filter_lcov.ts, and resolveWithinCwd in tasks/generateLedgerClearSigning.ts — any path flowing through one of these is contained. readJsonFile() in script/utils/utils.ts is a safe wrapper that returns null on any read error.

---

## `nosql_mongoEq`

**Matches when**: issue title contains "NoSQL injection"; file is `script/deploy/update-deployment-logs.ts` or `script/deploy/query-deployment-logs.ts`, or the flagged call is wrapped in `mongoEq()`

**ignore_reason**:
> False positive — mongoEq() in script/deploy/shared/mongo-log-utils.ts wraps every value in { $eq: value }, explicitly blocking MongoDB operator injection. The scanner does not recognize this project-specific wrapper as a sanitizer. All query fields in these files use mongoEq() wrapping.

**sast_context** (UI: NoSQL Injection rule → Custom Code Context):
> mongoEq() defined in script/deploy/shared/mongo-log-utils.ts is a sanitizer: export function mongoEq<T>(value: T): { $eq: T } { return { $eq: value } }. It wraps any value in { $eq: value }, blocking MongoDB operator injection. Any query field wrapped with mongoEq() is safe. All scripts in script/ are internal developer CLI tools — query values come from hardcoded contract names, network names from config/networks.json (version-controlled allow-list), or from MongoDB documents returned by prior queries.

---

## `nosql_internal_scripts`

**Matches when**: issue title contains "NoSQL injection"; file is under `script/deploy/safe/` or `script/mongoDb/`; the flagged call is a raw `.find()` / `.findOne()` not wrapped in `mongoEq()`

**ignore_reason**:
> False positive — internal deployment script. MongoDB query values come from: network names validated against config/networks.json (version-controlled allow-list), on-chain data retrieved in prior script steps, or hardcoded status strings like "queued"/"executed". No external user input flows into these queries. Scripts run in local/CI context, not as web services.

**sast_context**: same as `nosql_mongoEq` — add to the same NoSQL Injection rule in the Aikido UI.

---

## `ssrf_scripts`

**Matches when**: issue title contains "SSRF" or "HTTP request" and "attack"; file is under `script/`, `tasks/`, or `.claude/`

**ignore_reason**:
> False positive — internal developer CLI tool. All URLs passed to fetch() come from config/networks.json RPC entries (version-controlled) or developer CLI args. No web server or HTTP API; no attacker-controlled URL can flow in.

**sast_context** (UI: SSRF rule → Custom Code Context):
> All TypeScript scripts under script/, tasks/, and .claude/ are one-shot developer CLI tools or CI scripts with no HTTP server. All URLs passed to fetch() come from config/networks.json RPC entries (version-controlled configuration) or from CLI arguments supplied by developers. No external user or attacker can control the URL. These scripts are never deployed as web services.

---

## `idor_scripts`

**Matches when**: issue title contains "IDOR" or "access control"; file is under `script/utils/` or `script/deploy/`; function mentioned is `getContractAddress` or `readJsonFile`

**ignore_reason**:
> False positive — internal deployment utility called from CLI scripts. The network parameter is typed as SupportedChain (restricted to ~50 network names from config/networks.json) and the contract parameter is an internal contract name string. No HTTP API, no session, no external user. IDOR does not apply.

**sast_context** (UI: IDOR rule → Custom Code Context):
> getContractAddress() and readJsonFile() in script/utils/utils.ts are internal developer utilities called from CLI scripts and CI pipelines. The network parameter is typed as SupportedChain (a TypeScript union restricted to ~50 known network names from config/networks.json — a version-controlled allow-list). The contract parameter contains contract name strings from the codebase itself. There is no HTTP API, no authenticated session, and no external user making these calls.

---

## `ai_skill_md`

**Matches when**: issue title/body contains "skill", "Skill will call", "mutating", or "tricky skill"; file is under `.claude/skills/`, `.agents/commands/`, or `.claude/scripts/`

**ignore_reason**:
> False positive — Claude Code skill file (plain-text prompt instructions for a local AI coding assistant). Claude Code enforces a mandatory permission prompt before every tool call. All described actions (git push, Slack messages, Linear ticket creation) require explicit user approval via the Claude Code permission UI before execution. Not deployed software; no attack surface to external users.

**sast_context** (UI: AI Skill rule → Custom Code Context):
> Files under .claude/skills/ and .agents/commands/ are Claude Code skill files — plain-text instruction sets for an AI coding assistant running locally on a developer's machine. They are not deployed software. Claude Code enforces a mandatory permission prompt before every tool call (git push, API calls, file writes, Slack messages). All mutating actions described in skill files require explicit user approval before execution.

---


## `env_example_placeholder`

**Matches when**: issue title contains "Exposed secret" or "API Key"; file is `.env.example`

**ignore_reason**:
> False positive — .env.example contains placeholder/example keys for developer onboarding. No real credentials are committed; the values are dummy examples intentionally made public.

**sast_context**: not needed — this is a one-off ignore, not a systematic pattern requiring rule-level context.

---

## `gha_permissions_trusted_workflow`

**Matches when**: issue title contains "Overly Broad Permissions" (GitHub Actions); the workflow grants only specific, inline-documented permission(s) it demonstrably needs (NOT `write-all` / `read-all`); AND it is triggered only by trusted events (`push`, `workflow_dispatch`, `schedule`, or same-repo `pull_request`).

**Does NOT match** (these are REAL — review/fix, do not ignore): `write-all` / `read-all`; or any workflow triggered by `pull_request_target`, `workflow_run`, or `issue_comment` that can act on untrusted fork input — there a broad permission is a genuine privilege-escalation risk.

**ignore_reason**:
> False positive — the workflow grants only the specific, inline-documented permission it needs (e.g. `contents: write # Needed to push new tags`), per this repo's convention (.agents/rules/500-github-actions.md) of declaring minimal, commented, least-privilege permissions. It runs only on trusted triggers (push / workflow_dispatch / schedule), so no untrusted or fork-supplied input can reach the elevated permission. Aikido's heuristic flags any workflow-level write scope, but a single minimal documented permission on a trusted-trigger workflow is the intended hardened state, not over-broad. Not applicable to write-all/read-all or to pull_request_target / workflow_run / issue_comment workflows.

**sast_context** (UI: Overly Broad Permissions rule → Custom Code Context):
> GitHub Actions workflows in this repo follow a least-privilege convention: each workflow declares the minimal permission scopes it needs at the workflow or job level, with an inline comment explaining why (e.g. `contents: write # Needed to push new tags`). A workflow that grants only the specific scopes it uses, is triggered solely by trusted events (push, workflow_dispatch, schedule, or same-repo pull_request), and never checks out or executes untrusted fork input, is correctly hardened — not over-broad. Treat `write-all`/`read-all`, or any broad scope on pull_request_target / workflow_run / issue_comment workflows that handle fork input, as real findings requiring review.

---

## `gha_persist_credentials_push_checkout`

**Matches when**: issue title contains "persist Git credentials"; the flagged `actions/checkout` step configures a dedicated credential (`token:` backed by a dedicated secret or `ssh-key:`, never the ambient `GITHUB_TOKEN`), AND a later step in the same job performs an authenticated `git push` against that checkout using the persisted credential, AND the workflow uses only trusted triggers (`push`, `schedule`, `workflow_dispatch`, or same-repository `pull_request`).

**Does NOT match** (these are REAL — fix with `persist-credentials: false`): checkouts of jobs that never push with the persisted git credential afterwards. `gh`/API calls authenticate via `env:` tokens, not the persisted git `extraheader`, so they do not justify keeping it.

**ignore_reason**:
> Intended behavior, risk accepted — this checkout deliberately persists an explicitly scoped credential (dedicated PAT, sync token, or deploy ssh-key, not the ambient runner token) because a later step in the same job pushes to that repository with it. Setting persist-credentials: false would break the push. The workflow runs only on trusted triggers (push / schedule / workflow_dispatch).

**sast_context** (UI: persist Git credentials rule → Custom Code Context):
> Read-only checkouts in this repo set persist-credentials: false. The exceptions each configure an explicitly scoped credential (a dedicated PAT or deploy ssh-key passed via `token:`/`ssh-key:`, never the ambient runner GITHUB_TOKEN) because a later step in the same job performs a git push to that repository using the persisted credential (e.g. registry sync, type-bindings publish, dependency-bump branches). These are intentional and required; only flag checkouts that persist credentials without a subsequent authenticated git push in the same job.

---

## Patterns NOT auto-ignored (require manual review or a real fix)

| Pattern | Why | Action |
|---------|-----|--------|
| Template injection in GH Actions | `${{ github.event.* }}` in shell steps — real risk | Fix: use env var intermediary |
| Unpinned third-party Actions | Supply chain risk | Fix: pin to commit SHA |
| Open source dependency CVEs | Real vulnerabilities | Fix: bump the dep version |
