# LI.FI Contracts

Cross-chain bridge aggregation protocol using the Diamond standard (EIP-2535).
Solidity ^0.8.17 · Foundry · TypeScript/Bun scripts.

## Agent Configuration

```
.agents/
  rules/*.md      25 rule files (source of truth, symlinked to .cursor/ as .mdc and .claude/ as .md)
  commands/*.md    7 command files (source of truth, symlinked to .cursor/ and .claude/)
  hooks/*.sh       post-edit hooks (auto-format + lint feedback)
```

Edit files in `.agents/` only — never edit the symlinks in `.cursor/` or `.claude/` directly.
Rules load automatically: global rules (000–003, 099) always apply; scoped rules activate
when you edit matching files. Convention anchors (e.g. `[CONV:LICENSE]`, `[CONV:EVENTS]`)
are embedded in rule files.

## Common Commands

| Task | Command |
|---|---|
| Format | `bun format:fix` |
| Lint | `bun lint:fix` (JS + Solidity) |
| Test (Solidity) | `bun test` |
| Test (TypeScript) | `bun test:ts` |
| Build | `forge build` |
| Type check | `bunx tsc-files --noEmit <file>` |
| Solhint | `bunx solhint <file>` |
| Bash syntax | `bash -n <file>` |

## Creating and editing PRs via gh

When creating or editing a PR body, always start from the repo template at
`.github/pull_request_template.md` (sections, headings, and reviewer checklist
verbatim). Fill in the Linear task link and "Why I implemented it this way";
tick only the items in the author checklist that genuinely apply; leave the
reviewer checklist unchecked. Do not substitute a custom layout (e.g. `## Summary`

+ `## Test plan`) — the template's wording feeds the review process.

Use the REST API to update PR title/body:

```bash
jq -Rs '{title: "...", body: .}' /tmp/pr-body.md > /tmp/payload.json
gh api -X PATCH repos/lifinance/contracts/pulls/<N> --input /tmp/payload.json
```
