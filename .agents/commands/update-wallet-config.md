---
name: update-wallet-config
description: Opens the PR that updates a rotated SC wallet role in `config/global.json` — both the EVM field (`deployerWallet` / `devWallet` / `pauserWallet`) and its matching `tronWallets.<role>` base58 — deriving the Tron address from the new EVM address via `troncast address to-base58` and cross-checking with the reverse `to-hex`. Use when the user says "update the wallet config", "bump the new deployer/dev/pauser in global.json", "open the config PR for the rotation", or when a `rotate-*` skill reaches its config step. NOT for the on-chain role change itself (Safe owner / Timelock role / diamond owner) — that is `multisig-rollout`; this skill only edits config and opens a PR. Only rotates SC-owned roles (deployer / dev / pauser); never refund / feeCollector / withdraw (CTO-owned). The Notion wallet-registry update is a manual follow-up (needs auth) — flagged, not faked. Requires `troncast`, `jq`, and `bun`. Ends by delegating to `/create-pr`.
usage: /update-wallet-config --role <deployer|dev|pauser> --new-address 0xNEW [--production]
---

# Update Wallet Config (LI.FI Contracts)

Config-only step of a wallet rotation: point a role in `config/global.json` at the new wallet, in the **same PR** that rotates that role. For each rotated role this rewrites two coupled fields — the top-level EVM field and the parallel `tronWallets.<role>` base58 — keeping them in sync. It changes no on-chain state (no Safe, no diamond, no Timelock); it edits config and hands the branch/commit/PR mechanic to `/create-pr`.

## When to use / when NOT

Use when:

- "update the wallet config for the new \<role\>" / "bump the new deployer in global.json"
- "open the config PR for the rotation"
- A `rotate-*` skill reaches its `config/global.json` step.
- "/update-wallet-config --role deployer --new-address 0xNEW"

Do NOT use when:

- The user wants the **on-chain** role change (swap the Safe owner, move `CANCELLER_ROLE`, transfer the diamond owner) → that is `multisig-rollout`. This skill only edits config; the on-chain move is a separate, governed flow.
- The role is **refund / feeCollector / withdraw** → CTO-owned, never rotated by SC tooling. Stop and say so.
- Only the Tron delegation needs moving (staked energy/bandwidth) → that is `move-tron-delegation`; a config edit does not move delegated resources.

## Inputs

Required:

- **role** (`--role`) — one of `deployer` / `dev` / `pauser` (maps to `deployerWallet` / `devWallet` / `pauserWallet` and the same key under `tronWallets`).
- **new wallet address** (`--new-address`, EVM `0x…`) — the rotation's replacement.

Optional:

- **--production** — target production (default staging), mirroring the `.env PRODUCTION=true` double-opt-in rail.

If either required input is missing or the role is not one of the three SC-owned roles, ask once and stop (custody guard). The **old** address is not an input — it is whatever the config currently holds for that role, and is being replaced.

## Guardrails

- **Custody guard.** Only `deployerWallet` / `devWallet` / `pauserWallet` (+ their `tronWallets` twins) may be edited here. NEVER touch `refundWallet` / `feeCollectorOwner` / `withdrawWallet` (CTO-owned). Reject any request naming those.
- **Derive the Tron address, never trust config.** Compute `tronWallets.<role>` from the **new EVM address** with `troncast address to-base58`, then round-trip it back with `troncast address to-hex` and assert it equals the new EVM address (checksum-insensitive). Known trap: `config/global.json` can be **mid-rotation-inconsistent** (EVM field already rotated, Tron twin not, or vice versa) — so derive both fields from `--new-address`, do not copy an existing base58 or assume the current pair is coherent.
- **Config-structure rule (004-config-structure `[CONV:CONFIG-STRUCTURE]`).** These are single top-level scalar fields plus a `tronWallets` object — edit the values in place; do not restructure, reorder, or change key names. No `deployRequirements.json` path change is implied (these are not per-network deploy params).
- **Never bypass Safe/timelock.** A config edit is not the authority for the role change — the on-chain move via `multisig-rollout` is. Landing this PR before/independently of the on-chain change is expected during a rotation; the config records intent, the chain enforces it.
- **Secrets hygiene.** `troncast address` conversion is offline but the CLI aborts without an RPC env — prefix a dummy URL (below); never print a real RPC URL or any key.
- **Exit-code convention.** `0` success (config edited, PR handed to `/create-pr`); `1` real error (Tron round-trip mismatch, jq write failure — report, stop, no retry); `2` recoverable misconfig (missing `--role`/`--new-address`, `troncast` not found — name what to fix).

## Workflow

### Phase 0 — Preflight

Run from the worktree root. `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"` if `troncast`/`bun` are not found. Confirm the role is one of deployer/dev/pauser (custody guard) and `--new-address` is a valid EVM address. Report the current `global.json` pair for the role (EVM + `tronWallets.<role>`) so the reviewer sees old → new.

### Phase 1 — Derive + verify the Tron base58 from the new EVM address

`troncast address` conversion is offline but aborts without an RPC env, so prefix a dummy URL. Flags on `troncast address` are **kebab-case** — verify at write time with `troncast address --help`.

```bash
NEW_EVM="<0xNEW>"
NEW_TRON=$(ETH_NODE_URI_TRON="https://dummy" troncast address to-base58 "$NEW_EVM")
# Round-trip guard: the base58 must convert back to the same EVM address.
ROUNDTRIP=$(ETH_NODE_URI_TRON="https://dummy" troncast address to-hex "$NEW_TRON")
```

Assert `ROUNDTRIP` equals `NEW_EVM` (case-insensitive compare). On mismatch, stop with exit `1` and show both — do not write a base58 you could not round-trip. Do not read the base58 from the existing `tronWallets` entry (may be mid-rotation stale).

### Phase 2 — Edit config/global.json (both coupled fields)

Rewrite exactly the two fields for the role, in place, preserving structure and key order (rule 004). Example for the deployer role:

```bash
jq --arg evm "$NEW_EVM" --arg tron "$NEW_TRON" \
  '.deployerWallet = $evm | .tronWallets.deployerWallet = $tron' \
  config/global.json > config/global.json.tmp && mv config/global.json.tmp config/global.json
```

Map the role to its fields: `deployer → .deployerWallet` / `.tronWallets.deployerWallet`; `dev → .devWallet` / `.tronWallets.devWallet`; `pauser → .pauserWallet` / `.tronWallets.pauserWallet`. Touch no other field. Show the resulting diff (`git diff config/global.json`) — it must be exactly those two lines.

### Phase 3 — Open the PR

Delegate branch / commit / template / push / create to `/create-pr`, passing:

- **files to stage**: exactly `config/global.json` (never `git add -A`).
- **body** (the "Why"): the role being rotated, old → new EVM + Tron addresses, that this is the config half of a rotation whose on-chain change goes through `multisig-rollout`, and the linked rotation ticket.

`/create-pr` owns the plumbing and has a confirm gate — don't reimplement it here.

### Phase 4 — Note the Notion registry follow-up (do not fake)

The team's Notion wallet registry is the human-facing record and is **not** in this repo — updating it needs Notion auth this skill does not assume. State explicitly that the Notion wallet-registry entry for this role still needs updating to the new address, as a manual follow-up. Do not claim it was updated.

## Verification

- `git diff config/global.json` shows exactly the two rotated fields changed to the new EVM + derived Tron base58, nothing else.
- The Tron round-trip (`to-hex` of the written base58) equals the new EVM address.
- `/create-pr` reported the PR URL.
- The Notion follow-up is called out as pending.
- On-chain enforcement is verified separately by `check-rotation-status` after `multisig-rollout` lands the role change — this skill does not assert on-chain state.

## Reuse map

- `troncast address to-base58` / `to-hex` — EVM↔Tron address conversion + the round-trip guard (needs a dummy `ETH_NODE_URI_TRON`; kebab-case flags).
- `/create-pr` — owns branch / commit / PR-template / push / create; this skill only supplies the staged file and PR body.
- `multisig-rollout` — the sibling that performs the on-chain role change this config edit records; run in the same rotation, not by this skill.
- `move-tron-delegation` — moves staked Tron resources (separate from the config base58 update).
- `check-rotation-status` — read-only gate confirming the on-chain role change matches the new config.
- `config/global.json` (`004-config-structure`) — the edited file; single scalar wallet fields + the `tronWallets` object, edited in place.
