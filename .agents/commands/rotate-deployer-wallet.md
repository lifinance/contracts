---
name: rotate-deployer-wallet
description: Rotates the shared SC-owned **Deployer** wallet — `safeOwners[0]` + the Timelock `CANCELLER_ROLE` (and prod timelock executor) — end-to-end: bootstraps the new deployer's gas, swaps the Safe owner and moves the canceller role via Safe proposals, handles Tron, updates config, decommissions the old key, and gates on a completeness check. Thin orchestrator: it CALLS the L1 skills (`sweep-wallet-funds`, `move-tron-delegation`, `update-wallet-config`, `check-rotation-status`) and existing skills (`/multisig-rollout`, `transfer-ownership-to-timelock.ts`), never reimplementing them. Use when the user says "rotate the deployer wallet", "replace safeOwners[0]", "swap the deployer / canceller EOA", or "/rotate-deployer-wallet". This is the heaviest-governance rotation (production Safe + Timelock) — NOT the staging owner (that is `rotate-dev-wallet`), NOT the emergency pauser (that is `rotate-pauser-wallet`), and NOT a full person offboarding (that is `offboard-sc-dev`). Requires Foundry, gh, VPN for MongoDB, and a securely generated new wallet + hardware-wallet signing — both human steps. NEVER self-sign; all on-chain owner/role changes go through Safe/timelock.
usage: /rotate-deployer-wallet [--new-address 0xNEW] [--check]
---

# Rotate Deployer Wallet (LI.FI Contracts)

## Purpose

Rotate the shared **Deployer** wallet, which carries the protocol's heaviest privileges:

- `safeOwners[0]` — a signer on every production Safe.
- The Timelock `CANCELLER_ROLE` (and the production timelock executor).
- The CREATE3 deployer key used to broadcast deploys.

Because it is SC-owned it is rotatable, but every privilege it holds is governed by Safe + Timelock — so the on-chain swaps run as **Safe proposals through `multisig-rollout`**, never as owner shortcuts. This skill is a **thin orchestrator**: it sequences the L1 and existing skills, enforces the guardrails, and gates on the final check. It reimplements none of their logic.

## When to use / when NOT

Use when the user says:

- "rotate the deployer wallet" / "replace safeOwners[0]" / "swap the deployer / canceller EOA"
- "/rotate-deployer-wallet [0xNEW]"

Do NOT use for:

- The staging **Dev** wallet (staging diamond owner) → `rotate-dev-wallet`.
- The **Pauser** emergency EOA → `rotate-pauser-wallet`.
- A full SC-dev **offboarding** (signer swap + all three rotations + secret rotation) → `offboard-sc-dev` (the orchestrator that calls this skill).
- Any **CTO-owned** wallet (refund / feeCollector / withdraw) — see Guardrails.

## Inputs

Required:

- **--new-address** — the securely generated new deployer EOA (`0x…`). If not supplied, ask once; never generate it inside the skill (see Guardrails).

Optional:

- **--check** — run the completeness check only (delegates to `check-rotation-status`, changes nothing) and stop. Use to preview state before rotating or to re-verify after.

The **old** deployer address is derived from `PRIVATE_KEY_PRODUCTION` in `.env` (the sweep in Phase 1 does this), never from `config/global.json.deployerWallet` — the key and the config can diverge, and the wrong address makes a funded wallet look empty (or a rotation look incomplete).

## Guardrails

- **Custody guard.** Only the SC-owned wallets may be rotated: **deployer, dev, pauser**. This skill rotates **deployer** only. NEVER touch refund / feeCollector / withdraw — those are CTO-owned. If the request drifts to a CTO wallet, stop and say so.
- **Never self-sign.** Secure key generation for the new deployer is a human step — never generate or derive a fresh private key here. The Safe owner swap and canceller-role move are Ledger-signed by the human via `multisig-rollout`'s hand-off (`script/deploy/safe/confirm-safe-tx.ts`); this orchestrator hands off and WAITS — it never runs the signing script and never signs.
- **Never bypass Safe/timelock** (rule 002-architecture governance). Every on-chain owner/role/canceller change goes through `multisig-rollout` as a timelock-wrapped Safe proposal. No direct owner functions, no emergency paths that skip the timelock.
- **Secrets hygiene.** Never print a private key or a full RPC URL; read keys in a subshell and redact. Derive the acting address from the key, never from `config/global.json`.
- **Bootstrap ordering.** Sweep FIRST (Phase 1) so the new deployer has gas before it needs to act; sweep native LAST *within* the sweep (the L1 skill enforces this) so gas needed for other moves isn't stranded.
- **Dry-run first.** Each step has its own preview/`--check`/`--dryRun`; run the previews before the state-changing pass, and confirm the plan before any broadcast or proposal is minted.

## Workflow

Foundry/bun may need `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"`. VPN is required for the MongoDB signature verification inside `multisig-rollout`.

### Phase 0 — Preflight & confirm plan

- Confirm `--new-address` is present, checksum-valid, and NOT any current SC/CTO wallet in `config/global.json`.
- Report old → new for the EVM field and the derived Tron base58.
- Present the ordered plan (Phases 1–6) and wait for explicit go-ahead. State up front that the rotation is **semi-automated**: it will pause for human key generation and, critically, for **Ledger signing** of the Safe proposals inside `multisig-rollout`, after which the user returns to the chat and the skill finishes.

### Phase 1 — Bootstrap the new deployer's gas (`sweep-wallet-funds`) — FIRST

Sweep native gas from the old deployer to the new one across all active EVM chains so the new deployer can broadcast. This runs **before** any governance change so the new wallet is fundable and usable when the Safe adds it.

```text
/sweep-wallet-funds --new-address <NEW> --old-key-env PRIVATE_KEY_PRODUCTION --production
```

`sweep-wallet-funds` previews balances first, sweeps native LAST (stranding guard), and owns the human-confirmed pre-send report + secrets hygiene. Do not reimplement `moveNativeFundsToNewWallet.ts` here.

> Leave enough in the OLD deployer to sign the Safe/timelock txs it still needs to send in Phase 2 if any are broadcast by the old key — `sweep-wallet-funds`'s dry-run lets you judge this per network before committing.

### Phase 2 — Swap the Safe owner + move CANCELLER_ROLE (`multisig-rollout`)

The governed changes — replace `safeOwners[0]` (old → new) on every production Safe and move the Timelock `CANCELLER_ROLE` (old removed, new granted) — run as timelock-wrapped Safe proposals via the production rollout skill:

```text
/multisig-rollout <owner-swap + canceller-role change>
```

`multisig-rollout` captures the proposals, drafts the PR, and then **pauses to hand Ledger signing to the human** (`confirm-safe-tx.ts`) — it verifies `signatureCount >= 2` in MongoDB and posts `#dev-sc-multisig-proposals`. This orchestrator does NOT sign and does NOT post; it waits for `multisig-rollout` to complete its lifecycle (the human signs, the team recruits the remaining signer). Never self-sign, never bypass the Safe.

### Phase 3 — Tron: ownership → Timelock + delegation

On Tron the diamond ownership is held by the Timelock; move it via the existing script (env-derived network: production → `tron`, NOT a flag):

```bash
bunx tsx script/deploy/tron/transfer-ownership-to-timelock.ts --dryRun          # preview
bunx tsx script/deploy/tron/transfer-ownership-to-timelock.ts --step 1          # then --step 2
```

Then re-point the Tron staked-resource delegation from the old deployer Tron address to the new one:

```text
/move-tron-delegation --old-address <old deployer 0x…> --new-address <NEW> --role deployer
```

`move-tron-delegation` derives both base58 addresses, drafts the undelegate→re-delegate request (delegator-controlled, executed off-repo), and verifies on Tronscan afterward. Any Ledger signing the Tron ownership step needs is a human step.

### Phase 4 — Update config (`update-wallet-config`)

Open the PR that rotates the `deployerWallet` role in config.

```text
/update-wallet-config --role deployer --new-address <NEW> --production
```

`update-wallet-config` updates the EVM `deployerWallet` field AND `tronWallets.deployer` (Tron base58 derived + reverse-checked), honors config-structure rule 004, and ends by calling `/create-pr`. Notion registry update is a flagged follow-up.

### Phase 5 — Decommission the old key

Once Phases 2–4 have landed and `check-rotation-status` (Phase 6) confirms the old address holds no Safe-owner / canceller / owner privileges anywhere, the old private key can be retired: remove it from `.env` / secret stores and rotate any CI secret that carried it. This is a human/operational step — surface the exact checklist; do not attempt to touch secret stores from the skill.

### Phase 6 — Verify (`check-rotation-status`)

Run the read-only completeness gate scoped to the deployer rotation:

```text
/check-rotation-status --old-address <old deployer 0x…> --new-address <NEW> --role deployer --production
```

For the deployer role the relevant checks are: Safe-owner membership (old removed / new added) on every production Safe, Timelock `CANCELLER_ROLE` (old removed / new granted), the Tron ownership/delegation state, and the CI wallet-funding check. Only declare complete when every network passes.

### Phase 7 — Report

Summarize: swept networks (moved/skipped), the `multisig-rollout` outcome (proposal nonces, PR URL, Slack thread, remaining team signatures), Tron ownership + delegation state, config PR URL, old-key decommission status, and the `check-rotation-status` result. Call out anything still pending (unsigned proposals, unverified networks) and the human follow-ups.

## Verification

Complete only when `check-rotation-status` (Phase 6) passes for every network: new deployer is `safeOwners[0]` and holds `CANCELLER_ROLE`, the old deployer holds neither anywhere, Tron reflects the new address, and funding passes. Because the Safe swaps go through timelock, the on-chain state flips only after the proposals are signed to threshold and the timelock delay elapses — the check may legitimately still show "old" until then; report that as pending, not as failure. Re-run `/rotate-deployer-wallet --check` to re-confirm.

## Reuse map

| Step | Delegates to | Owns |
|---|---|---|
| Bootstrap gas | `sweep-wallet-funds` | native sweep across EVM chains, pre-send report, secrets hygiene |
| Safe owner swap + canceller move | `multisig-rollout` | proposals → PR → Ledger hand-off → Mongo sig verify → Slack |
| Tron ownership → Timelock | `script/deploy/tron/transfer-ownership-to-timelock.ts` | env-derived Tron handover (production → tron) |
| Tron delegation | `move-tron-delegation` | undelegate→re-delegate request + Tronscan verify |
| Config PR | `update-wallet-config` | `global.json` deployerWallet + `tronWallets.deployer`, `/create-pr` |
| Completeness gate | `check-rotation-status` | read-only cross-network verification |

This skill adds only sequencing (sweep-first bootstrap ordering), the custody/self-sign/no-bypass guardrails, and the confirm gate — no funds-moving, signing, address-deriving, or config-editing logic of its own.
