# LI.FI Contracts

Cross-chain bridge aggregation protocol using the Diamond standard (EIP-2535).
Solidity ^0.8.17 · Foundry · TypeScript/Bun scripts.

## Agent Configuration

```
.agents/
  rules/*.md      25 rule files (source of truth, symlinked to .cursor/ as .mdc and .claude/ as .md)
  commands/*.md    6 command files (source of truth, symlinked to .cursor/ and .claude/)
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

## Network types

Networks in `config/networks.json` carry a `"type"` field (`"mainnet"` or `"testnet"`). Detect testnet via `isTestnetNetwork(network)` — bash helper in `script/helperFunctions.sh`, TS helper in `script/utils/viemScriptHelpers.ts`.

**Testnet networks always run with `ENVIRONMENT=production`.** No `.staging.json` deployment file exists for them, so any script that loads `deployments/${network}.staging.json` will fail on testnets. Consequence: `environment === 'production'` is already true on testnet — do **not** add defensive `|| isTestnet` clauses next to it. Use `isTestnetNetwork` only where behavior actively differs from production (ownership: EOA `deployerWallet` instead of Timelock; no Safe; no Timelock; direct-send instead of Safe-propose).

## Editing PRs via gh

Use the REST API to update PR title/body:

```bash
jq -Rs '{title: "...", body: .}' /tmp/pr-body.md > /tmp/payload.json
gh api -X PATCH repos/lifinance/contracts/pulls/<N> --input /tmp/payload.json
```
