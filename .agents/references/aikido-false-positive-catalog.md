# Aikido False Positive Catalog — lifinance/contracts

Used by `/aikido-address-findings` (auto-triage on scan) and `/aikido-update-false-positive-catalog` (add new patterns).

Each pattern has:

- **Matches when** — how to recognize this false positive from issue data
- **ignore_reason** — exact text to pass to `aikido-mcp:aikido_ignore_issue`
- **sast_context** — text to paste into the Aikido UI "Custom Code Context" for this rule

---

## `path_traversal_scripts`

**Matches when**: issue title contains "path traversal" or "file inclusion"; file is under `script/`, `tasks/`, or `.claude/scripts/`

**ignore_reason**:
> False positive — internal developer CLI tool. File paths come from: SupportedChain enum restricted to ~50 network names in config/networks.json (version-controlled allow-list), contract name strings from the codebase itself, developer CLI args in local/CI context — never from untrusted external user input. No HTTP server; these scripts run locally or in CI. readJsonFile() in script/utils/utils.ts returns null on any error and never exposes file contents externally.

**sast_context** (UI: Path Traversal rule → Custom Code Context):
> All TypeScript scripts under script/, tasks/, and .claude/scripts/ are internal developer CLI tools and CI scripts. They are never deployed as network services and never receive input from untrusted external users. File path inputs come exclusively from: SupportedChain enum values derived from config/networks.json (version-controlled allow-list of ~50 network names); contract name strings from the codebase itself (e.g. "LiFiDiamond", "StargateFacet"); CLI args provided by developers or CI (not HTTP request parameters); git rev-parse output (trusted local git binary); hardcoded path constants. readJsonFile() in script/utils/utils.ts is a safe wrapper that returns null on any read error. getContractAddress() constructs paths by joining process.cwd() + "deployments/" + network + ".json" where network is constrained to the SupportedChain type.

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

## `git_path_scripts`

**Matches when**: issue title contains "path traversal" or "file inclusion"; file is `.claude/scripts/pr-ready-gate.ts`; issue mentions `git rev-parse`, `gitdir`, or `markerPath`

**ignore_reason**:
> False positive — path comes from `git rev-parse --git-dir` (trusted local binary, not user-controlled input). Code reads only file metadata (mtime via statSync) — file contents are never read or returned. The suggested fix would break git worktrees.

**sast_context**: same as `path_traversal_scripts` — add to the Path Traversal rule in the Aikido UI.

---

## `env_example_placeholder`

**Matches when**: issue title contains "Exposed secret" or "API Key"; file is `.env.example`

**ignore_reason**:
> False positive — .env.example contains placeholder/example keys for developer onboarding. No real credentials are committed; the values are dummy examples intentionally made public.

**sast_context**: not needed — this is a one-off ignore, not a systematic pattern requiring rule-level context.

---

## Patterns NOT auto-ignored (require manual review or a real fix)

| Pattern | Why | Action |
|---------|-----|--------|
| Template injection in GH Actions | `${{ github.event.* }}` in shell steps — real risk | Fix: use env var intermediary |
| Unpinned third-party Actions | Supply chain risk | Fix: pin to commit SHA |
| Open source dependency CVEs | Real vulnerabilities | Fix: bump the dep version |
