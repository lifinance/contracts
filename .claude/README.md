# Claude Code in this repo

This directory configures Claude Code (the CLI) for the `lifinance/contracts` repo:

- `skills/` — repo-bundled skills (workflows you can invoke by name, e.g. `post-pr-for-review`, `start-linear-ticket`). See each skill's `SKILL.md` for what it does and when to trigger it.
- `rules/` — coding rules and guardrails surfaced to Claude when working in this repo.
- `settings.json` — repo-scoped Claude Code settings (hooks, permissions, **enabled plugin marketplaces**, etc.).
- `../.mcp.json` — MCP servers bundled with this repo (see below).

## Bundled plugin: `superpowers`

This repo enables the [`obra/superpowers`](https://github.com/obra/superpowers) plugin — a community Claude Code skills library (TDD, systematic debugging, brainstorming, plan writing/execution, parallel agent dispatch, code review workflow, git worktrees, etc.).

It's pinned via `settings.json` so every developer gets **the exact same version** — upstream changes can never silently affect us:

```json
"extraKnownMarketplaces": {
  "obra-superpowers": {
    "source": {
      "source": "github",
      "repo": "obra/superpowers",
      "ref": "v5.1.0",
      "sha": "f2cbfbefebbfef77321e4c9abc9e949826bea9d7"
    }
  }
},
"enabledPlugins": { "superpowers@obra-superpowers": true }
```

`ref` is the human-readable tag; `sha` is the exact commit and takes precedence — together they make the pin tamper-evident.

### First-time setup

1. `cd` into this repo and run `claude` (or open Claude Code here).
2. Accept the trust prompt: *"This project wants to add marketplace `obra-superpowers`. Trust and add?"* — the plugin then auto-installs (it's in `enabledPlugins`).
3. Verify with `/plugin list` → `superpowers@obra-superpowers` should show as active.
4. Skills like `superpowers:brainstorming`, `superpowers:test-driven-development`, `superpowers:systematic-debugging` are now invokable via the `Skill` tool inside any Claude Code session in this repo.

### Bumping the pin

1. Pick the new tag from https://github.com/obra/superpowers/releases.
2. Look up its **commit SHA** (handles both annotated and lightweight tags — `obra/superpowers` uses annotated, so the naive `--jq '.object.sha'` returns the tag-object SHA, not the commit):
   ```bash
   TAG=<TAG>
   REF=$(gh api repos/obra/superpowers/git/ref/tags/$TAG)
   OBJ_TYPE=$(jq -r '.object.type' <<< "$REF")
   OBJ_SHA=$(jq -r '.object.sha' <<< "$REF")
   if [ "$OBJ_TYPE" = "tag" ]; then
     gh api repos/obra/superpowers/git/tags/$OBJ_SHA --jq '.object.sha'
   else
     echo "$OBJ_SHA"
   fi
   ```
3. Update both `ref` and `sha` in `settings.json` in a PR. Reviewers sanity-check the diff against upstream release notes.
4. After merge, contributors are re-prompted to trust the updated marketplace version on next `claude` launch.

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
