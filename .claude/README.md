# Claude Code in this repo

This directory configures Claude Code (the CLI) for the `lifinance/contracts` repo:

- `skills/` — repo-bundled skills (workflows you can invoke by name, e.g. `post-pr-for-review`, `start-linear-ticket`). See each skill's `SKILL.md` for what it does and when to trigger it.
- `rules/` — coding rules and guardrails surfaced to Claude when working in this repo.
- `plugins-lock.json` — pinned Claude Code plugin marketplaces + plugins (source of truth for `script/claude/install.mjs`).
- `settings.json` — repo-scoped Claude Code settings (hooks, permissions). The CLI also writes `extraKnownMarketplaces` and `enabledPlugins` here at install time; we don't hand-edit those fields.
- `../.mcp.json` — MCP servers bundled with this repo (see below).

## Claude bootstrap (`bun run claude:install`)

Everything pinned in `plugins-lock.json` is materialized onto your machine by `script/claude/install.mjs`, which runs automatically as part of `bun install` (chained from `postinstall`) and can be re-run manually with `bun run claude:install`.

For each entry in `plugins-lock.json` the script:

1. **Marketplace** — clones (or fetches) the source repo into `<CONFIG>/plugins/marketplaces/<name>`, checks out the pinned commit `sha`, verifies `HEAD` matches (**SHA mismatch is a hard error** — tamper-evidence gate), and registers it in `<CONFIG>/plugins/known_marketplaces.json` so Claude Code picks it up without the interactive trust prompt.
2. **Plugin** — for each `<plugin>@<marketplace>` entry, runs `claude plugin install --scope project <spec>` (idempotent). This is what populates `<CONFIG>/plugins/cache/...` and `installed_plugins.json` — without it, the marketplace is registered but the plugin still requires a manual `space` in `/plugin` to actually load.

`<CONFIG>` defaults to `~/.claude`, but the script honors `CLAUDE_CONFIG_DIR` if set. Users with dual-account setups (e.g. a `claude-work` shell function that exports `CLAUDE_CONFIG_DIR=$HOME/.claude-work`) should run `CLAUDE_CONFIG_DIR=$HOME/.claude-work bun run claude:install` once for the work config — the `bun install` postinstall hook picks up whichever config is in the parent env.

No-op paths (script exits 0 silently, never breaks `bun install`):

- `<CONFIG>` doesn't exist → not a Claude Code user.
- `plugins-lock.json` declares no marketplaces.
- `claude` CLI not on PATH → marketplaces still registered, plugin install step skipped with a warning.
- Transient network / missing `git` → warning logged, install continues.

## Bundled plugins

Pinned in `plugins-lock.json`. `ref` is the human-readable tag/branch; `sha` is the exact commit and is what the script verifies — together they make each pin tamper-evident.

### `superpowers` (from `obra/superpowers`)

Community Claude Code skills library — TDD, systematic debugging, brainstorming, plan writing/execution, parallel agent dispatch, code review workflow, git worktrees, etc. Pinned to `v5.1.0`.

### `skill-creator` (from `anthropics/claude-plugins-official`)

Anthropic's first-party plugin for authoring new skills — applies the official best practices (≤500-line limit, progressive disclosure, frontmatter conventions) automatically, so new skills in `.agents/commands/` stay within the guidelines from [`010-agents-authoring`](../.agents/rules/010-agents-authoring.md). The upstream marketplace publishes no release tags, so its `ref` is the branch name (`main`).

### First-time setup

1. Run `bun install` in the repo root if you haven't already — `postinstall` runs `claude:install` and both marketplaces register + both plugins install at the pinned SHA. (Re-run any time with `bun run claude:install`.)
2. `cd` into this repo and run `claude` (or open Claude Code here).
3. Verify with `claude plugin list` (or `/plugin list` inside a session) — `skill-creator@anthropics-claude-plugins-official` and `superpowers@obra-superpowers` should both show `enabled: true`.
4. Skills like `superpowers:brainstorming`, `superpowers:systematic-debugging`, `/skill-creator` are now invokable in any Claude Code session in this repo.

### Bumping a pin

Edit `plugins-lock.json` in a PR. To look up the SHA of a tag:

```bash
REPO=obra/superpowers; TAG=v5.2.0
REF=$(gh api repos/$REPO/git/ref/tags/$TAG)
OBJ_TYPE=$(jq -r '.object.type' <<< "$REF")
OBJ_SHA=$(jq -r '.object.sha' <<< "$REF")
if [ "$OBJ_TYPE" = "tag" ]; then
  gh api repos/$REPO/git/tags/$OBJ_SHA --jq '.object.sha'
else
  echo "$OBJ_SHA"
fi
```

For a branch-tracking pin (e.g. `anthropics/claude-plugins-official` has no tags):

```bash
gh api repos/anthropics/claude-plugins-official/commits/main --jq '.sha'
```

Update both `ref` and `sha` in `plugins-lock.json`. Reviewers sanity-check the diff against upstream release notes / commit history. After merge, contributors pick up the new pin on their next `bun install`.

If you don't use Claude Code, you can ignore this directory entirely — none of it affects normal `forge`/`bun`/`gh` workflows.

## MCP servers bundled with this repo

`.mcp.json` at the repo root declares the MCP (Model Context Protocol) servers that this repo's skills depend on. When you run `claude` in this directory for the first time, Claude Code will prompt you to approve each server before connecting — nothing connects silently.

### Why bundle them

Several of the bundled skills (`post-pr-for-review`, `sc-design-review`, `start-linear-ticket`, etc.) call out to external services via MCP. Without the right servers configured, the skills fail with cryptic errors. Bundling them via project-level `.mcp.json` means anyone who clones this repo gets a one-click setup instead of hunting through docs.

### Security model

- **Each server uses OAuth**, not shared secrets. No tokens, API keys, or credentials are stored in this repo — every teammate authenticates against their own account on first use.
- **Claude Code prompts before connecting.** On first encounter with `.mcp.json`, Claude Code shows you each declared server and asks whether to enable it for this workspace. You can approve some and decline others; the choice is per-server and per-workspace.
- **Revoking access** is done in the source-of-truth tool (e.g. Linear → Settings → API → revoke), not here.

### Current servers

| Server | Endpoint | Used by | Auth |
|---|---|---|---|
| `linear` | `https://mcp.linear.app/mcp` | `start-linear-ticket` | OAuth (linear.app) — browser flow on first call |
| `slack` | `https://mcp.slack.com/mcp` | `post-pr-for-review` | OAuth (LI.FI Slack workspace) — sign in once, your messages post as you |
| `notion` | `https://mcp.notion.com/mcp` | `sc-design-review` (PRD ingestion) | OAuth (notion.so) — grant access to the LI.FI Notion workspace |
| `blockscout` | `https://mcp.blockscout.com/mcp` | Ad-hoc onchain inspection of deployed contracts (no specific skill yet) | No login — public read-only endpoint |

### First-time setup

1. `cd` into this repo and run `claude` (or open Claude Code in this directory).
2. Claude Code detects `.mcp.json` and prompts: **"This workspace declares N MCP servers. Approve?"** Accept (or decline individual servers you don't need).
3. The first time you invoke a skill that uses one of these servers (e.g. `start ticket EXSC-XXX` → Linear), Claude Code triggers an OAuth flow in your browser. Sign in with your **LI.FI Google account** (Linear, Notion) or **LI.FI Slack identity** (Slack). Blockscout requires no auth.
4. The token is stored locally by Claude Code (per-user); subsequent calls reuse it without prompting.

> **Tip:** you don't have to authenticate everything upfront. Each server only triggers its OAuth flow the first time a skill actually calls it. If you only use `start-linear-ticket`, you'll only see the Linear prompt.

### Troubleshooting

- **"Needs authentication"** when running `claude mcp list` → re-run the skill that uses the server; Claude Code will re-trigger the OAuth flow.
- **Token expired / 401 errors** → run `claude mcp` to re-auth, or sign out + back in via the server's web app.
- **MCP not showing up at all** → make sure you ran `claude` from the repo root (where `.mcp.json` lives), not from a subdirectory you've cd'd into. The file is detected at session start.
- **Want to opt out for this workspace** → decline the server at the approval prompt, or delete `.mcp.json` locally (don't commit the deletion).

### Adding a new MCP server

If you're adding a skill that depends on a new MCP server, also add the server to `.mcp.json` and document it in the table above. Keep the criterion strict: only servers that something *in this repo* actively calls. Personal productivity MCPs (Gmail, Calendar, etc.) belong in your user-level Claude Code config, not here.
