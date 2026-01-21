# MCP (Cursor) – Shared Repo Setup

This repo includes a **project MCP configuration** so Cursor can connect to GitHub/Jira/Notion/Slack via MCP servers.

## What’s committed vs. what’s private

- **Committed**: `.cursor/mcp.json` (server definitions; **no secrets**)
- **Private per developer**: `.env.mcp.local` (API tokens; **gitignored**)

## Prerequisites

- **Bun or Node tooling**: repo-owned MCP servers are Node scripts and require installing the repo JS deps once (`@modelcontextprotocol/sdk`, `zod`, `dotenv`, etc.).
- **Foundry** (optional, only for Foundry MCP tools): `forge` + `cast` available in your PATH.
- **Docker** (optional, only for GitHub MCP server): Docker Desktop / Docker Engine running locally.

## Setup (recommended)

1. Install JS dependencies (one-time per clone):

```bash
bun install
```

2. Copy the secrets template (repo root):

```bash
cp config/mcp.env.example .env.mcp.local
```

3. Fill in `.env.mcp.local` with your tokens / URLs (never commit this file).
4. Restart Cursor (so it picks up the project MCP config and environment).
5. In Cursor, open **Settings → MCP** and ensure the servers are enabled.

## When to run the helper script (`script/mcp/run.ts`)

Use the helper script any time you want to run an MCP server command **manually** while still loading `.env.mcp.local` (the same “per-dev secrets” file the repo is designed around).

- **Run it when**:
  - A server shows as “failing” in Cursor and you want the real stderr/stack trace.
  - You just edited `.env.mcp.local` and want to confirm env var names are correct.
  - You want to smoke-test repo-owned MCP servers without involving Cursor UI.

- **Format**:

```bash
bunx tsx script/mcp/run.ts -- <command> [args...]
```

- **Examples**:

```bash
# Smoke-test the repo-owned servers (validates env + basic dependencies)
bunx tsx script/mcp/run.ts -- bunx tsx script/mcp/foundry.server.ts --smoke-test
bunx tsx script/mcp/run.ts -- bunx tsx script/mcp/explorer.server.ts --smoke-test
bunx tsx script/mcp/run.ts -- bunx tsx script/mcp/tenderly.server.ts --smoke-test

# Run a third-party MCP server manually (useful for debugging)
bunx tsx script/mcp/run.ts -- npx -y @modelcontextprotocol/server-slack@latest
```

## Services

### Foundry (Forge/Cast)

- **Server**: repo-owned (`script/mcp/foundry.server.ts`)
- **Env vars**:
  - `RPC_URL` (needed for RPC-backed tools like `cast_call`, `cast_tx`, `cast_receipt`)
- **Tools**:
  - `forge_build`, `forge_test`, `cast_sig`, `cast_4byte`, `cast_call`, `cast_tx`, `cast_receipt`
- **Local requirements**: Foundry installed (`forge`, `cast`)

### GitHub

- **Server**: `ghcr.io/github/github-mcp-server` (Docker)
- **Env var**: `GITHUB_PERSONAL_ACCESS_TOKEN`
- **Notes**: You need Docker running locally.

### Jira (Atlassian Cloud)

- **Server**: `@aashari/mcp-server-atlassian-jira`
- **Env vars**: `ATLASSIAN_SITE_NAME`, `ATLASSIAN_USER_EMAIL`, `ATLASSIAN_API_TOKEN`

### Notion

- **Server**: `@ramidecodes/mcp-server-notion`
- **Env var**: `NOTION_API_KEY`
- **Notes**: Your Notion integration must be explicitly shared into the pages/databases you want accessible.

### Tenderly (simulation)

- **Server**: repo-owned (`script/mcp/tenderly.server.ts`)
- **Env vars**: `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT`, `TENDERLY_PROJECT`
- **Tools**: `tenderly_simulate` (supports compact summaries + capped call traces)

### Block explorer (Etherscan / Blockscout APIs)

- **Server**: repo-owned (`script/mcp/explorer.server.ts`)
- **How it selects explorers**: uses `config/networks.json` → `explorerApiUrl` per network (supports `verificationType`: `etherscan`, `blockscout`, `routescan`)
- **Env vars**:
  - `EXPLORER_NETWORK` (optional default network key, e.g. `mainnet`, `base`)
  - Advanced overrides: `EXPLORER_API_BASE_URL`, `EXPLORER_API_KEY`, `EXPLORER_KIND`
- **Tools**:
  - `explorer_list_networks`
  - `explorer_get_abi`, `explorer_get_source_code`, `explorer_contract_summary`
  - `explorer_proxy_tx_by_hash`, `explorer_proxy_receipt_by_hash`
  - `explorer_get_logs`

### Slack

- **Server**: `@modelcontextprotocol/server-slack`
- **Env vars**: `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID`

## Troubleshooting

- **Server shows as failing in Cursor**: run it manually via `script/mcp/run.ts` to see the real error output.
- **Repo-owned servers fail immediately**:
  - Ensure you ran `bun install`
  - Ensure you have required local tooling (e.g. Foundry for `foundry.server.mjs`)
- **Env vars not found**:
  - Ensure `.env.mcp.local` exists in the repo root
  - Re-run the relevant `--smoke-test` command (above) to validate env parsing
  - Restart Cursor after changing `.env.mcp.local`
- **Cursor can’t see MCP servers at all**: verify `.cursor/mcp.json` exists and restart Cursor.

## Fallback policy (important)

MCP is meant for **verified enrichment** and often **lower token usage**, but it must never reduce output quality.

- **Default**: try MCP first when it’s supported/configured for the target network.
- **Always fallback** to the existing repo workflows (premium RPC + `analyzeFailingTx` + local repo artifacts) when:
  - MCP tools error (missing env vars, auth failures, timeouts),
  - A tool does not support the given network,
  - MCP output is incomplete for root-cause analysis.

When falling back, follow the repo’s trace-first analysis principles and still produce a full, stakeholder-quality writeup.
