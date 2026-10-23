---
name: update-wallet-config
description: "Opens the config PR for a rotated SC wallet role: sets the EVM field (`deployerWallet`/`devWallet`/`pauserWallet`) and its derived `tronWallets.<role>` base58 in `config/global.json`. Use for \"update the wallet config\" or a rotate-* config step. On-chain role change → calling rotate-* skill."
usage: /update-wallet-config --role <deployer|dev|pauser> --new-address 0xNEW [--production]
---

# Update Wallet Config (LI.FI Contracts)

Config half of a wallet rotation: rewrites the role's two coupled fields in `config/global.json` and hands the PR to `/create-pr`. Changes no on-chain state. The config records intent; the governed on-chain move in the calling rotate-* skill is the authority, so landing this PR before it is expected.

## Inputs

- `--role` — `deployer` | `dev` | `pauser` → `.deployerWallet` / `.devWallet` / `.pauserWallet` and the same key under `.tronWallets`.
- `--new-address` — the replacement EVM `0x…`.
- `--production` — target production (default staging).

Missing input or any other role → ask once and stop. Never edit `refundWallet` / `feeCollectorOwner` / `withdrawWallet` (CTO-owned). The old address is whatever config holds now.

Exit codes: `0` edited and handed to `/create-pr`; `1` round-trip mismatch or jq write failure (report, stop); `2` missing input or `troncast` not found.

## Workflow

### Phase 0 — Preflight

From the worktree root. `troncast` is `script/troncast/index.ts` run via `bunx tsx`, not a binary on `PATH` (`export PATH="$HOME/.bun/bin:$PATH"` if `bun` is missing). Report the current EVM + `tronWallets.<role>` pair so the reviewer sees old → new.

### Phase 1 — Derive and round-trip the Tron base58

Derive both fields from `--new-address`; never copy an existing base58 — `global.json` can be mid-rotation-inconsistent (one twin rotated, the other not). Flags are kebab-case (verify with `bunx tsx script/troncast/index.ts address --help`). `address` needs `ETH_NODE_URI_TRON` set even though conversion is offline; the block below falls back to a dummy value (as in `interact-tron`).

```bash
NEW_EVM="<0xNEW>"
export ETH_NODE_URI_TRON="${ETH_NODE_URI_TRON:-https://dummy}"
NEW_TRON=$(bunx tsx script/troncast/index.ts address to-base58 "$NEW_EVM")
ROUNDTRIP=$(bunx tsx script/troncast/index.ts address to-hex "$NEW_TRON")
```

`ROUNDTRIP` must equal `NEW_EVM` (case-insensitive); otherwise exit `1` and show both.

### Phase 2 — Edit both fields in place

Preserve structure and key order (rule 004 `[CONV:CONFIG-STRUCTURE]`). Deployer example (for `dev` / `pauser`, use `.devWallet` + `.tronWallets.devWallet` / `.pauserWallet` + `.tronWallets.pauserWallet`):

```bash
jq --arg evm "$NEW_EVM" --arg tron "$NEW_TRON" \
  '.deployerWallet = $evm | .tronWallets.deployerWallet = $tron' \
  config/global.json > config/global.json.tmp && mv config/global.json.tmp config/global.json
```

`git diff config/global.json` must show exactly those two lines.

### Phase 3 — Open the PR

`/create-pr` with exactly `config/global.json` staged (never `git add -A`). Body: role, old → new EVM + Tron addresses, that the on-chain change goes through Safe proposals, and the rotation ticket.

### Phase 4 — Notion registry

The Notion wallet registry is outside this repo and needs auth this skill doesn't assume. Report its update as a pending manual follow-up; never claim it done.

## Verification

Two-line diff, round-trip equal, PR URL from `/create-pr`, Notion follow-up flagged. On-chain state is `check-rotation-status`'s job.
