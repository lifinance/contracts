# LI.FI Contracts

Cross-chain bridge aggregation protocol using the Diamond standard (EIP-2535).
Solidity ^0.8.17 · Foundry · TypeScript/Bun scripts.

## Agent Configuration

`.agents/rules/`, `.agents/commands/` and `.agents/hooks/` are the source of truth; `.cursor/`
and `.claude/` symlink into them. Edit files in `.agents/` only — never the symlinks.
Rules load automatically: global rules (000–002, 099, and 600, which has no `paths:`)
always apply; scoped rules activate when you edit matching files. Convention anchors (e.g. `[CONV:LICENSE]`, `[CONV:EVENTS]`)
are embedded in rule files.

## Common Commands

| Task | Command |
|---|---|
| Format | `bunx prettier --write <file>` (scoped; `bun format:fix` rewrites the whole tree) |
| Lint | `bunx oxlint --type-aware <file>` (TS/JS) |
| Test (Solidity) | `bun run test` (bare `bun test` runs Bun's own test runner) |
| Test (TypeScript) | `bun test:ts` |
| Build | `forge build` |
| Type check | `bash script/utils/typecheck-files.sh <file>` |
| Node runtime fence | `bun lint:node-runtime` |
| Solhint | `bunx solhint <file>` |
| Bash syntax | `bash -n <file>` |

## Environment & resource access

Internal resources — the Safe proposal MongoDB (`SC_MONGODB_URI`) and deploy
infrastructure — are reached through the `lifi-connect` tunnel. Agents **cannot**
perform the interactive/secret steps (browser Okta SSO, 1Password credentials,
opening a production tunnel). Before doing Safe/deploy work that touches these,
read `docs/Setup-agents.md` — what an agent must not do and how commands differ
in a non-interactive shell. Full setup (human path) is in `docs/Setup.md`.

## SC feature-PR lifecycle

Feature PRs go: self-test → PR ready + bot comments resolved → peer review
(`#dev-sc-review`) → BE integration → audit → audit-log commit → final review →
merge. **The audit is the last gate before merge, not a prerequisite for peer
review.** Full stage list and automation mapping:
`.agents/rules/503-sc-feature-pr-lifecycle.md`.

## Ticket linkage

The PR template's "Which Linear task belongs to this PR?" field is the source of
truth. `.github/workflows/ticketLinkageMetric.yml` reports monthly the % of
merged PRs that reference a Linear ticket ID (regex `[A-Z]+-[0-9]+`) in their
title, branch, or body. Target: 80%+.

PRs labelled `trivial` (typo / doc-only / dep-bump / single-line fix) count as
linked. Use it only for genuinely tiny PRs, not to skip ticket creation; the
report lists every `trivial`-only PR by name.

## Creating and editing PRs via gh

When creating or editing a PR body, always start from the repo template at
`.github/pull_request_template.md` (sections, headings, and reviewer checklist
verbatim). Fill in the Linear task link and "Why I implemented it this way";
tick only the items in the author checklist that genuinely apply; leave the
reviewer checklist unchecked. Do not substitute a custom layout
(e.g. `## Summary` + `## Test plan`) — the template's wording feeds the review process.

Use the REST API to update PR title/body:

```bash
jq -Rs '{title: "...", body: .}' /tmp/pr-body.md > /tmp/payload.json
gh api -X PATCH repos/lifinance/contracts/pulls/<N> --input /tmp/payload.json
```
